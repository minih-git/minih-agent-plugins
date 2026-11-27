"use strict";

/**
 * The accounts this plugin is watching, and everything the panel can do to them.
 *
 * This file is the seam between three owners: the host owns the account list (one
 * `multiple` credential slot, at most five instances), this plugin owns one
 * watcher and one small state slice per account (`lib/watcher.js`, `lib/store.js`),
 * and the Inbox panel owns the user's clicks. Keeping the three apart is what
 * makes "add a mailbox" a data operation instead of a rewrite.
 *
 * Two rules live here and nowhere else:
 *
 * - **One connection per account.** An IMAP watcher dials one socket and keeps it
 *   in IDLE; the panel's "open this message" and "mark it read" are queued jobs
 *   that run on that same socket between two IDLEs (`watcher.runJob`). Five
 *   accounts therefore cost five of the host's eight per-plugin TCP connections,
 *   and no action in the panel can open a sixth. A POP3 account cannot hold a
 *   connection at all (the session locks the maildrop), so its watcher opens one
 *   short session per poll and one more for the message the user opened.
 * - **The host owns the account list.** Every refresh reads
 *   `pi.credentials.list()` and makes the local set match it: a new instance
 *   starts watching, a removed one stops and its state is deleted. The plugin
 *   never invents an account and never keeps one the host no longer has.
 */

const accountsFile = require("./accounts");
const attachments = require("./attachments");
const body = require("./body");
const compose = require("./compose");
const { createGate } = require("./gate");
const mailboxes = require("./mailboxes");
const mime = require("./mime");
const pop3 = require("./pop3");
const { createPop3Watcher } = require("./pop3-watcher");
const providers = require("./providers");
const store = require("./store");
const { createSession } = require("./session");
const { createWatcher } = require("./watcher");

/** The one credential slot the user fills in, one instance per mailbox. */
const SLOT_ID = "mailbox";
/** How much of one message the panel may download. */
const BODY_LIMIT = 1024 * 1024;
/** A body fetch is interactive: it must finish before the panel's own timeout. */
const BODY_TIMEOUT_MS = 20_000;
/**
 * How large one saved attachment may be.
 *
 * The host refuses a file above 50 MiB in `pi.fs.saveAs` anyway; checking first
 * means the plugin says "too large" instead of failing after a download that
 * could not have worked.
 */
const SAVE_LIMIT = attachments.MAX_ATTACHMENT_BYTES;
/** An attachment download is minutes of a slow mailbox, not a click. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A send is the host's session; the plugin only waits for the answer. */
const SEND_TIMEOUT_MS = 120_000;
/*
 * How a body the panel already opened is remembered.
 *
 * Since 0.8.0 it is on disk, in `lib/body-cache.js`: the raw bytes the server sent,
 * under a hashed name, with a small index of size and last-open time. A reply or a
 * forward re-reads those bytes and parses them again — the headers it needs
 * (`Message-ID`, `Reply-To`, `References`) come out of the same parse, so there is
 * one cache rather than one in memory and one on disk.
 */
/**
 * Sessions this plugin may have open at once.
 *
 * The host allows eight per plugin; four leaves room for the app's own work and is
 * still more throughput than any mailbox needs. Every poll, message body and flag
 * change goes through this one gate (`lib/gate.js`).
 */
const MAX_CONNECTIONS = 4;
/** Accounts start their first poll this far apart. */
const STAGGER_MS = 1_500;
/**
 * How many older envelopes one "load older" click asks for.
 *
 * Fifty is a few screens of list and about two hundred kilobytes of envelope,
 * which is what keeps a mailbox with tens of thousands of messages responsive on
 * a connection that is one short session.
 */
const OLDER_PAGE_SIZE = 50;

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function createRuntime(deps) {
  const host = deps.host;
  const root = deps.root;
  const log = deps.log ?? (() => {});
  const accounts = new Map();
  const gate = deps.gate ?? createGate(MAX_CONNECTIONS);
  /**
   * Which mailbox is the trash and which the archive, per account.
   *
   * Learned with one `LIST` on a session the account already had, cached until
   * the account's connection changes, and used to decide whether the panel shows
   * a delete or an archive button at all.
   */
  const folders = mailboxes.createFolderCache();
  /**
   * The bodies the user has opened, kept on this computer by `lib/body-cache.js`.
   *
   * A reply has to know the original's `Message-ID`, `Reply-To` and `References`,
   * and a forward needs its text and its attachment part numbers. All of that is in
   * the bytes the panel already downloaded, so the cache is what makes "reply" cost
   * no network request — and what makes a second open cost none either.
   */
  const bodyCache = deps.bodyCache;
  let loaded = false;

  const accountStateOf = (instanceId) => accountsFile.accountState(root, instanceId);
  const providerOf = (instanceId) => accountsFile.providerOf(root, instanceId);

  /**
   * The folders this account offers, or `null` when the answer is not known yet.
   *
   * POP3 has no folders at all, so its answer is a constant; IMAP needs one
   * `LIST`, which the first poll of a session does and this cache then keeps.
   */
  function foldersOf(record) {
    if (record.protocol === "pop3") return { trash: null, archive: null, specialUse: false };
    return folders.get(record.instanceId, record.connectionKey);
  }

  /**
   * Learn (once) which mailbox is the trash and which is the archive.
   *
   * Called from a session the caller already opened, so it costs one `LIST` per
   * account and connection — never one per click.
   */
  async function ensureFolders(record, session, capabilities) {
    const cached = foldersOf(record);
    if (cached) return cached;
    const list = await session.listMailboxes({ specialUse: capabilities.includes("SPECIAL-USE") });
    return folders.set(record.instanceId, record.connectionKey, mailboxes.resolveFolders(list));
  }

  /**
   * Take one message out of the inbox and put it in `destination`.
   *
   * Three commands at most, in the order that leaves the mailbox consistent if
   * one of them fails: a `MOVE` where the server has one, otherwise a `COPY` that
   * is then deleted exactly. A server with neither is refused with a code instead
   * of falling back to a mailbox-wide `EXPUNGE`, which would remove other
   * clients' `\Deleted` messages too.
   */
  async function moveOutOfInbox(session, capabilities, uid, destination) {
    const supported = new Set(capabilities.map((value) => String(value).toUpperCase()));
    if (supported.has("MOVE")) {
      await session.moveMessage(uid, destination);
      return "move";
    }
    if (supported.has("UIDPLUS")) {
      await session.copyMessage(uid, destination);
      await session.storeFlags(uid, { add: ["\\Deleted"], remove: [] });
      await session.expungeUid(uid);
      return "copy-expunge";
    }
    throw coded("MOVE_UNSUPPORTED", "this server can neither move nor expunge a single message");
  }

  /** The account a panel call names, or the coded refusal the panel can translate. */
  function requireAccount(instanceId) {
    const record = accounts.get(String(instanceId ?? ""));
    if (!record) throw coded("ACCOUNT_NOT_FOUND", "this mailbox is not in the list");
    return record;
  }

  /** One message's envelope from this account's list, or a coded refusal. */
  function requireEnvelope(state, key) {
    const envelope = store.findEnvelope(state, String(key ?? ""));
    if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
    return envelope;
  }

  /**
   * An envelope the store does not hold, named by the UID a server search returned.
   *
   * The panel only ever opens mail its own list holds, but a tool call can ask
   * about a message the poll window never covered — an invoice from the first of
   * the month is older than the last 200 envelopes. A `UID` is the server's own
   * name for that message inside one `UIDVALIDITY`, and the era carried here is
   * the one the last poll saw, which is exactly what `requireCurrentEra` compares
   * against: a mailbox that renumbered its messages answers `MESSAGE_STALE`
   * instead of handing back whichever message holds that number now.
   *
   * The sender, subject and date are unknown until the message arrives;
   * `fillEnvelopeFromHeaders` fills them from the bytes themselves.
   */
  function envelopeFromUid(state, uid, era = null) {
    if (!Number.isInteger(uid) || uid < 1) return null;
    return {
      key: `uid:${uid}`,
      uid,
      // The era named by the key that produced this envelope, so a mailbox that
      // renumbered its messages since the search is refused rather than read.
      uidValidity: Number.isInteger(era) ? era : state.cursor?.uidValidity ?? null,
      messageId: "",
      from: { name: "", address: "" },
      subject: "",
      receivedAt: null,
      flags: [],
      important: false,
      summary: "",
      to: [],
      cc: [],
      hasAttachments: false,
    };
  }

  /**
   * Fill a synthesized envelope's facts from the message it names.
   *
   * Only the header block is read, and only for the five fields a caller needs to
   * recognise the message: answering with an empty subject would make a read of
   * old mail useless.
   */
  function fillEnvelopeFromHeaders(envelope, raw) {
    const headers = mime.parseHeaders(body.splitEntity(raw).header);
    envelope.subject = mime.headerValue(headers, "subject");
    envelope.from = compose.parseAddressHeader(mime.headerValue(headers, "from"))[0] ?? {
      name: "",
      address: "",
    };
    const receivedAt = Date.parse(mime.headerValue(headers, "date"));
    envelope.receivedAt = Number.isFinite(receivedAt) ? receivedAt : null;
    envelope.messageId = mime.headerValue(headers, "message-id").trim();
    return envelope;
  }

  /**
   * The name one message's body is kept under.
   *
   * A key is not enough on its own. A stored IMAP envelope carries either its
   * Message-ID or `uid:<uid>`, and neither says which `UIDVALIDITY` it belongs to:
   * a mailbox that was rebuilt hands out the same `uid:<uid>` for a different
   * message. The era is therefore part of the cache's name, so an entry from a
   * previous era cannot be served — it stops being reachable and ages out on its
   * own. POP3 has no such era; its key is the server's UIDL.
   */
  function bodyKeyOf(record, envelope) {
    if (record.protocol === "pop3") return envelope.key;
    return `${envelope.uidValidity ?? 0}:${envelope.key}`;
  }

  /**
   * Remember one downloaded body, and never let that fail the open.
   *
   * `write` answers `false` rather than throwing for anything it cannot store, and
   * this catch is the second half of the same promise: a cache that has gone bad
   * costs the user one re-download, never the message they asked to read.
   */
  async function keepBody(record, envelope, fetched) {
    try {
      await bodyCache.write(record.instanceId, bodyKeyOf(record, envelope), fetched.body, {
        size: fetched.size,
        truncated: fetched.truncated === true,
      });
    } catch (error) {
      log("warn", `could not keep a message body: ${error?.message ?? error}`);
    }
  }

  /**
   * A message named by a key, by a UID, or by the key a server search reported.
   *
   * A row that came from the server is not in the stored list, so its key cannot
   * be a store key: it is `uid:<uidValidity>:<uid>`, which this resolves back to
   * the same message — the era travels with it, so a renumbered mailbox answers
   * `MESSAGE_STALE` instead of handing back whichever message holds that number
   * now. A key that is neither stored nor in that form, with no UID beside it, is
   * not a message this plugin can name.
   */
  function envelopeFor(state, input) {
    const key = String(input?.key ?? "");
    const stored = store.findEnvelope(state, key);
    if (stored) return stored;
    const serverKey = /^uid:(\d+):(\d+)$/.exec(key);
    if (serverKey) return envelopeFromUid(state, Number(serverKey[2]), Number(serverKey[1]));
    return envelopeFromUid(state, Number(input?.uid));
  }

  /**
   * Refuse to act on an envelope that belongs to another `UIDVALIDITY`.
   *
   * A UID names a message only inside one validity. The list is purged as soon as
   * a poll sees the server change it (`watcher.reconcile`), but a click can land in
   * the window between that change and the next poll — and a delete, an archive or
   * a `STORE` must never be able to hit whichever message holds that number now.
   * POP3 has no UIDVALIDITY, so both sides are `null` there and nothing is refused.
   */
  function requireCurrentEra(envelope, box) {
    const era = box?.uidValidity;
    if (!Number.isInteger(era) || envelope.uidValidity === null) return;
    if (envelope.uidValidity !== era) {
      throw coded(
        "MESSAGE_STALE",
        "the mailbox was renumbered since this message was listed, so it cannot be acted on",
      );
    }
  }

  /**
   * Wrap the host's TCP handle as the stream `lib/session.js` speaks.
   *
   * The host owns the socket and delivers `net:tcp:*` events for it; this adapter
   * filters by `connectionId` (the events are per plugin, not per connection) and
   * unsubscribes when the connection ends, so a reconnect cannot leave the old
   * listener feeding bytes into a dead session.
   */
  function wrapTransport(connectionId) {
    const dataListeners = new Set();
    const closeListeners = new Set();
    let finished = false;

    const onData = (event) => {
      if (!event || event.connectionId !== connectionId) return;
      for (const listener of dataListeners) {
        try {
          listener(event.data);
        } catch (error) {
          log("warn", `transport data handler failed: ${error?.message ?? error}`);
        }
      }
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      host.events.off("net:tcp:data", onData);
      host.events.off("net:tcp:close", onClose);
      host.events.off("net:tcp:error", onError);
      for (const listener of closeListeners) {
        try {
          listener(error);
        } catch (failure) {
          log("warn", `transport close handler failed: ${failure?.message ?? failure}`);
        }
      }
      closeListeners.clear();
      dataListeners.clear();
    };
    const onClose = (event) => {
      if (!event || event.connectionId !== connectionId) return;
      finish(coded("IMAP_CLOSED", "the mailbox server closed the connection"));
    };
    const onError = (event) => {
      if (!event || event.connectionId !== connectionId) return;
      finish(coded(String(event.code ?? "CONNECT_FAILED"), String(event.message ?? "socket error")));
    };

    host.events.on("net:tcp:data", onData);
    host.events.on("net:tcp:close", onClose);
    host.events.on("net:tcp:error", onError);

    return {
      send: async (data) => {
        if (finished) throw coded("IMAP_CLOSED", "the connection is closed");
        await host.net.tcp.send({ connectionId, data });
      },
      close: async () => {
        if (finished) return;
        finished = true;
        host.events.off("net:tcp:data", onData);
        host.events.off("net:tcp:close", onClose);
        host.events.off("net:tcp:error", onError);
        await host.net.tcp.close({ connectionId }).catch(() => undefined);
      },
      onData: (listener) => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    };
  }

  /**
   * Open one authenticated IMAP session for one account.
   *
   * Two paths, deliberately different:
   *
   * - a preset provider is addressed by the endpoint this file names; the host
   *   checks `manifest.net.tcp` and the slot's scope, then injects that
   *   instance's password into it;
   * - an account whose server the user typed passes the credential reference and
   *   no endpoint at all. The endpoint lives in that instance, the host injects
   *   the password into that endpoint and no other, and this file never names a
   *   host of its own choosing — which is what keeps a plugin from redirecting a
   *   password at a server it picked.
   *
   * The instance is named `<slot>#<instanceId>` either way: the slot holds several
   * accounts, the host refuses a bare slot id for it, and naming the wrong one
   * would sign in as the wrong mailbox.
   */
  async function connectImap(record) {
    if (typeof host.net?.tcp?.connect !== "function") {
      throw coded("UNSUPPORTED", "this app version has no net.tcp");
    }
    const credentialRef = `${SLOT_ID}#${record.instanceId}`;
    if (record.custom) {
      const handle = await host.net.tcp.connect({ credentialRef });
      return createSession(wrapTransport(handle.connectionId), { log });
    }
    const provider = providers.findProvider(record.provider);
    if (!provider) throw coded("PROVIDER_UNSELECTED", "this account has no mail provider yet");
    if (provider.auth !== "password") {
      throw coded("PROVIDER_NEEDS_OAUTH", `${provider.label} requires OAuth2 for IMAP`);
    }
    const handle = await host.net.tcp.connect({
      endpoint: { host: provider.host, port: provider.port },
      credentialRef,
    });
    return createSession(wrapTransport(handle.connectionId), { log });
  }

  /**
   * The POP3 counterpart: the same binding, a different client.
   *
   * A preset provider is always IMAP here (the table's ports are IMAP), so this
   * path only ever runs for a server the user typed. It never names an endpoint
   * either, for the same reason.
   */
  async function connectPop3(record) {
    if (typeof host.net?.tcp?.connect !== "function") {
      throw coded("UNSUPPORTED", "this app version has no net.tcp");
    }
    if (!record.custom) throw coded("PROVIDER_UNSELECTED", "a POP3 account needs its own server");
    const handle = await host.net.tcp.connect({ credentialRef: `${SLOT_ID}#${record.instanceId}` });
    return pop3.createClient(wrapTransport(handle.connectionId), { log });
  }

  function startAccount(record) {
    if (record.watcher) return;
    const snapshot = record;
    const shared = {
      account: { instanceId: record.instanceId, label: record.label },
      state: accountStateOf(record.instanceId),
      persist: () => deps.persist(),
      settings: () => deps.settings(),
      onError: (error) => log("warn", `mailbox check failed: ${error?.code ?? "FAILED"}`),
      log,
      now: () => Date.now(),
      timers: { setTimeout, clearTimeout },
      // One budget for every session this plugin opens, and one start offset per
      // account so a restart does not connect every mailbox in the same second.
      gate,
      staggerMs: [...accounts.keys()].indexOf(record.instanceId) * STAGGER_MS,
      // One `LIST` per account and connection, on a session the poll already
      // opened: that is what tells the panel whether delete and archive exist.
      probeFolders: async (session, capabilities) => {
        if (foldersOf(snapshot)) return;
        await ensureFolders(snapshot, session, capabilities);
      },
    };
    // One protocol, one watcher: both poll, but IMAP and POP3 speak differently.
    // The panel and the notifications are the same code for both, which is why the
    // two watchers share this shape.
    record.watcher = record.protocol === "pop3"
      ? createPop3Watcher({ ...shared, connect: () => connectPop3(snapshot) })
      : createWatcher({
          ...shared,
          connect: () => connectImap(snapshot),
          clientId: deps.clientId,
        });
    record.watcher.start();
  }

  async function stopAccount(record) {
    const watcher = record.watcher;
    record.watcher = null;
    await watcher?.stop().catch(() => undefined);
  }

  /**
   * Make the local accounts match the host's list.
   *
   * Runs on load, after `credentials:changed`, and after the plugin's own add or
   * remove call. It is idempotent: an account that is already watching keeps its
   * watcher and its cursor, so a settings change does not restart five IDLEs.
   */
  async function refresh() {
    if (!loaded) return { accounts: [] };
    const slots = await host.credentials.list();
    const slot = slots.find((entry) => entry.id === SLOT_ID) ?? null;
    const instances = Array.isArray(slot?.instances) ? slot.instances : [];
    const known = new Set(instances.map((instance) => instance.instanceId));
    const removed = accountsFile.retainAccounts(root, [...known]);
    for (const instanceId of removed) {
      const record = accounts.get(instanceId);
      accounts.delete(instanceId);
      folders.forget(instanceId);
      // A mailbox that is no longer watched keeps none of the bodies opened from
      // it: the account is gone, so nothing would ever ask for them again.
      await bodyCache.clearAccount(instanceId);
      if (record) await stopAccount(record);
    }
    let startedAny = false;
    for (const instance of instances) {
      const email = String(instance.publicFields?.username ?? instance.label ?? "").trim();
      const label = String(instance.label ?? email ?? "").trim() || instance.instanceId;
      let record = accounts.get(instance.instanceId);
      if (!record) {
        record = {
          instanceId: instance.instanceId,
          label,
          email,
          provider: null,
          custom: null,
          proxy: null,
          sendTarget: null,
          missingServer: false,
          protocol: null,
          connectionKey: "",
          watcher: null,
        };
        accounts.set(instance.instanceId, record);
      }
      record.label = label;
      record.email = email;
      // Which service this account belongs to, in the order `lib/providers.js`
      // documents: the endpoint the user typed, then the provider they chose in
      // the host's form, then the choice a 0.2.0 panel stored, then the domain.
      const stored = providerOf(instance.instanceId);
      const resolved = providers.resolveAccount({
        endpoint: providers.customEndpointOf(instance.publicFields),
        fieldProvider: instance.publicFields?.provider,
        storedProvider: stored ? stored.id : "",
        email,
      });
      const provider = resolved.provider;
      const connectionKey = resolved.custom
        ? providers.endpointKey(resolved.custom)
        : provider
          ? `preset:${provider.id}`
          : "";
      const protocol = resolved.custom ? resolved.custom.protocol : provider ? "imap" : null;
      // An edit can change the protocol, and the two cursors are not
      // interchangeable: an IMAP UID means nothing to POP3 and a POP3 UIDL means
      // nothing to IMAP. The account keeps its identity, its baseline does not.
      const protocolChanged = Boolean(record.protocol && protocol && record.protocol !== protocol);
      record.custom = resolved.custom;
      // Only the three non-secret fields are published; the proxy credentials
      // never reach this process, and nothing here needs them.
      record.proxy = providers.proxyOf(instance.publicFields);
      // How this account sends, decided where the account itself is decided:
      // a preset provider through its published submission endpoint, a server the
      // user typed through the outgoing server they typed, and a reason when
      // neither exists. The panel shows that reason instead of a send button that
      // would fail.
      record.sendTarget = providers.sendTargetOf({
        custom: resolved.custom,
        provider,
        publicFields: instance.publicFields,
      });
      record.missingServer = resolved.missingServer;
      record.provider = provider ? provider.id : null;
      record.protocol = protocol;
      if (record.connectionKey !== connectionKey) {
        // A different server, protocol or transport means the open connection is
        // to the wrong place: an edited account is not a poke. The old watcher is
        // stopped first, so its last poll cannot write the old cursor back over
        // the reset below.
        await stopAccount(record);
        record.connectionKey = connectionKey;
        if (protocolChanged) {
          const state = accountStateOf(record.instanceId);
          state.cursor = null;
          state.pop3 = { baselined: false, uidls: [], read: [] };
          log("info", `the protocol of ${instance.instanceId} changed; a fresh baseline follows`);
        }
      }
      if (record.connectionKey && !record.watcher) {
        startAccount(record);
        startedAny = true;
      }
    }
    await deps.persist();
    return { accounts: [...accounts.values()], startedAny };
  }

  function statusFor(record) {
    const state = accountStateOf(record.instanceId);
    // The provider is chosen in the account form now, so the two ways an account
    // can be unusable are distinct: "custom server, no server filled in" and "no
    // provider at all". Both are fixed in the host's account settings.
    if (record.missingServer) {
      return {
        phase: "needs-server",
        lastError: null,
        lastCheckAt: state.lastCheckAt,
        lastDigestAt: state.lastDigestAt,
        uidValidity: state.cursor?.uidValidity ?? null,
        maxUid: state.cursor?.maxUid ?? null,
      };
    }
    // `connectionKey` is what there is to connect to: a preset provider id, or
    // the endpoint the user typed. Without one the account is waiting for the
    // form, and saying "connecting" would be a lie.
    if (!record.connectionKey) {
      return {
        phase: "needs-provider",
        lastError: null,
        lastCheckAt: state.lastCheckAt,
        lastDigestAt: state.lastDigestAt,
        uidValidity: state.cursor?.uidValidity ?? null,
        maxUid: state.cursor?.maxUid ?? null,
      };
    }
    const status = record.watcher?.status ?? { phase: "stopped" };
    return { ...status, lastError: status.lastError ?? state.lastError ?? null };
  }

  function accountView(record, locale) {
    const provider = record.custom ? null : providers.findProvider(record.provider);
    const state = accountStateOf(record.instanceId);
    const known = foldersOf(record);
    return {
      instanceId: record.instanceId,
      label: record.label,
      email: record.email,
      protocol: record.protocol ?? null,
      // The proxy is part of how the account connects, so the panel can say so
      // instead of leaving a failing proxy invisible.
      proxy: record.proxy
        ? { type: record.proxy.type, host: record.proxy.host, port: record.proxy.port }
        : null,
      // A `provider: custom` account with no server filled in yet: the panel says
      // so instead of pretending it is connecting.
      missingServer: record.missingServer === true,
      // What the panel may offer: a POP3 mailbox has no read or starred state.
      flagsSupported: record.protocol !== "pop3",
      // Delete moves the message to the trash on IMAP, and is final on POP3; both
      // are offered, and the panel is what asks before the final one. Archive
      // needs a mailbox to archive into, which only a `LIST` can tell.
      canDelete: record.protocol === "imap" || record.protocol === "pop3",
      canArchive: Boolean(known?.archive),
      // Whether this account can send at all, and why not when it cannot. The
      // panel lists only the accounts that can, and names the reason for the rest
      // instead of offering a send button the host would refuse.
      canSend: sendBlockedReasonOf(record) === null,
      sendBlockedReason: sendBlockedReasonOf(record),
      // The list is bounded per account; once it is full the panel stops offering
      // "load older" and says the limit was reached.
      messageCount: state.messages.length,
      provider: record.custom
        ? {
            id: providers.CUSTOM_PROVIDER_ID,
            title: providers.customTitle(record.custom, locale),
            available: true,
            custom: {
              host: record.custom.host,
              port: record.custom.port,
              protocol: record.custom.protocol,
              security: record.custom.security,
            },
          }
        : provider
          ? {
              id: provider.id,
              title: provider.title[locale] ?? provider.title.en,
              available: provider.auth === "password",
              custom: null,
            }
          : null,
      // The panel offers the mailbox page for the provider it knows; a server the
      // user typed has no page this plugin could name.
      webmail: record.custom ? null : provider ? provider.webmail : null,
      status: statusFor(record),
    };
  }

  function messageViews() {
    const list = [];
    for (const record of accounts.values()) {
      const flagsSupported = record.protocol !== "pop3";
      const state = accountStateOf(record.instanceId);
      for (const envelope of state.messages) {
        list.push({
          accountId: record.instanceId,
          accountLabel: record.label,
          flagsSupported,
          key: envelope.key,
          uid: envelope.uid,
          from: envelope.from,
          subject: envelope.subject,
          receivedAt: envelope.receivedAt,
          // IMAP reports the flag; POP3 has none, so "read" there means "opened on
          // this machine". A star has no local equivalent and stays `null`.
          unread: flagsSupported
            ? !envelope.flags.includes("\\Seen")
            : !store.hasReadLocally(state, envelope.key),
          readLocally: flagsSupported ? null : store.hasReadLocally(state, envelope.key),
          starred: flagsSupported ? envelope.flags.includes("\\Flagged") : null,
          important: envelope.important,
          // The list's second line, and the two facts the reading pane shows
          // without opening the message body.
          summary: envelope.summary,
          to: envelope.to,
          cc: envelope.cc,
          hasAttachments: envelope.hasAttachments,
        });
      }
    }
    list.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || b.uid - a.uid);
    return list;
  }

  /**
   * Why this account cannot send, or `null` when it can.
   *
   * Two refusals come from the account itself (`lib/providers.js` decides them:
   * a server the user typed with no outgoing server, or a provider with no SMTP
   * entry), and one from the app: a host without `mail.send` cannot deliver
   * anything, however the account is configured.
   */
  function sendBlockedReasonOf(record) {
    if (typeof host.mail?.send !== "function") return "send-disabled";
    return record.sendTarget?.blocked ?? null;
  }

  /** One timestamp as the attribution line of a reply reads it. */
  function formatMessageDate(value, locale) {
    if (!Number.isFinite(value)) return "";
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    } catch {
      return new Date(value).toISOString();
    }
  }

  /** Whether one address is the account's own, compared without case. */
  function isSelf(record, entry) {
    const address = String(entry?.address ?? "").toLowerCase();
    return Boolean(address) && address === String(record.email ?? "").toLowerCase();
  }

  /**
   * The message the panel opened, from the body cache, or the coded refusal.
   *
   * A reply or a forward is built from what opening the message already downloaded:
   * its text, its HTML alternative, its attachment part numbers, and the four
   * headers that decide threading. No second request, and no guessing from an
   * `ENVELOPE` that some servers fill with `NIL` — the same bytes are parsed again
   * here, which is why there is one cache and not one in memory beside one on disk.
   */
  async function openedMessageOf(record, envelope) {
    const cached = await bodyCache.read(record.instanceId, bodyKeyOf(record, envelope));
    if (!cached) {
      throw coded("MESSAGE_NOT_OPEN", "open this message before replying to or forwarding it");
    }
    return body.parseMessage(cached.body);
  }

  /**
   * Who a reply goes to, and whether they are copies.
   *
   * A reply answers whoever asked for it (`Reply-To`, or the sender when there is
   * none); reply-all adds the original recipients, never the account itself, and
   * keeps the original's split between `To` and `Cc` for the ones that survive.
   */
  function replyRecipients(record, envelope, headers, { all = false } = {}) {
    const explicit = compose.parseAddressHeader(headers["reply-to"] ?? "");
    const sender = envelope.from?.address ? [envelope.from] : [];
    const to = [];
    const seen = new Set();
    const push = (list, target) => {
      for (const entry of list) {
        const address = String(entry?.address ?? "").trim();
        if (!address || isSelf(record, entry)) continue;
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        target.push({ name: String(entry?.name ?? "").trim(), address });
      }
    };
    push(explicit.length ? explicit : sender, to);
    if (!to.length) push(sender, to);
    const cc = [];
    if (all) {
      push(Array.isArray(envelope.to) ? envelope.to : [], to);
      push(Array.isArray(envelope.cc) ? envelope.cc : [], cc);
    }
    return { to, cc };
  }

  /**
   * One attachment's bytes, fetched the way its protocol allows.
   *
   * The attachment is named by its **section number**, the identity both parsers
   * agree on (`lib/body.js` walks the bytes the panel shows, the server answers
   * `BODYSTRUCTURE`; an inline image or an unnamed part makes a list position mean
   * two different things). IMAP confirms that number against the server's own
   * structure, checks the name the panel reported and the size before it asks for
   * `BODY.PEEK[<part>]`; POP3 has no such command, so the whole message is fetched
   * (capped) and the part taken out of it.
   *
   * `filename` is what the panel called that part: a name that disagrees with the
   * server's is `ATTACHMENT_MISMATCH` rather than a file the user did not ask for,
   * and an empty name on either side is not a disagreement.
   */
  async function attachmentBytes(record, envelope, input) {
    const part = String(input?.part ?? "").trim();
    if (!attachments.isPart(part)) {
      throw coded("INVALID_ARGUMENT", "a MIME part number is required");
    }
    const reported = String(input?.filename ?? "").trim();
    if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
    if (record.protocol === "pop3") {
      const fetched = await record.watcher.fetchBody(envelope.key, {
        maxBytes: SAVE_LIMIT,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      // A truncated maildrop message is not the attachment the user asked for.
      if (fetched.truncated) {
        throw coded("ATTACHMENT_TOO_LARGE", "this message is larger than one save may write");
      }
      const file = body.selectAttachment(fetched.body, part, {
        maxBytes: SAVE_LIMIT,
        filename: reported,
      });
      return { part, filename: file.filename, type: file.type, data: file.data };
    }
    return record.watcher.withSession(async (session, box) => {
      requireCurrentEra(envelope, box);
      const structure = await session.fetchStructure(envelope.uid, { timeoutMs: BODY_TIMEOUT_MS });
      const leaf = attachments.partAt(structure, part);
      if (!leaf) throw coded("ATTACHMENT_NOT_FOUND", "this message has no such attachment");
      if (!attachments.sameName(reported, leaf.name)) {
        throw coded("ATTACHMENT_MISMATCH", "the part at that number is a different attachment");
      }
      if (leaf.size > SAVE_LIMIT) {
        throw coded("ATTACHMENT_TOO_LARGE", "this attachment is larger than one save may write");
      }
      const fetched = await session.fetchPart(envelope.uid, part, {
        maxBytes: SAVE_LIMIT,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      return {
        part,
        filename: reported || leaf.name || `attachment-${part}`,
        type: leaf.type || "application/octet-stream",
        data: attachments.decodePart(fetched.data, leaf.encoding),
      };
    });
  }

  /**
   * File one copy of a just-sent message in the account's Sent mailbox.
   *
   * SMTP delivers; it does not file. A provider's web interface shows what it
   * received and, for a submission through its own SMTP, often nothing in Sent —
   * which is why every desktop client appends a copy. Gmail is the exception: it
   * files what it sends, so a copy there would be a duplicate.
   *
   * This never fails the send. The message is already out, and a mailbox that
   * refuses `APPEND` cannot make that untrue; the answer reports it in one line.
   */
  async function fileSentCopy(record, mime) {
    if (record.protocol !== "imap") return { filed: false, folder: null, skipped: "no-folders" };
    if (record.provider === "gmail") return { filed: false, folder: null, skipped: "gmail" };
    if (!record.watcher) return { filed: false, folder: null, skipped: "offline" };
    try {
      return await record.watcher.withSession(async (session, box, capabilities) => {
        const known = await ensureFolders(record, session, capabilities);
        if (!known?.sent) return { filed: false, folder: null, skipped: "no-sent-folder" };
        await session.appendMessage(known.sent, mime, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
        return { filed: true, folder: known.sent, skipped: null };
      });
    } catch (error) {
      log("warn", `could not file the sent copy: ${error?.code ?? error?.message ?? error}`);
      return { filed: false, folder: null, skipped: "failed", error: String(error?.code ?? "FAILED") };
    }
  }

  /**
   * Deliver one message the user asked for: the panel's Send, or a tool call the
   * host approved.
   *
   * Everything that decides what leaves is here rather than at either caller, so a
   * reply written by the agent and a reply written in the panel go out the same
   * way — same sender lock, same endpoint rule, same Sent copy.
   */
  async function sendMessage(input) {
    const record = requireAccount(input?.accountId);
    const blocked = sendBlockedReasonOf(record);
    if (blocked) throw coded(blocked, "this mailbox cannot send mail as it is configured");
    if (!compose.isAddress(record.email)) {
      throw coded("BAD_SENDER", "this mailbox has no usable address to send from");
    }
    const files = [];
    for (const file of Array.isArray(input?.attachments) ? input.attachments : []) {
      const data = Buffer.from(String(file?.data ?? ""), "base64");
      if (!data.length) continue;
      files.push({ name: String(file?.name ?? ""), type: String(file?.type ?? ""), data });
    }
    let forwarded = null;
    if (input?.forwardOf?.accountId && input?.forwardOf?.key) {
      const source = requireAccount(input.forwardOf.accountId);
      const sourceState = accountStateOf(source.instanceId);
      const envelope = requireEnvelope(sourceState, input.forwardOf.key);
      const wanted = Array.isArray(input.forwardOf.attachments) ? input.forwardOf.attachments : [];
      for (const wantedFile of wanted) {
        // Each ticked attachment is fetched by its own section number, so what
        // goes out is the file the user chose and nothing beside it.
        const file = await attachmentBytes(source, envelope, {
          part: wantedFile?.part,
          filename: wantedFile?.filename,
        });
        files.push({ name: file.filename, type: file.type, data: file.data });
      }
      forwarded = { accountId: source.instanceId, key: envelope.key, attachments: wanted.length };
    }
    const built = compose.buildMessage({
      // The display name is the account's label only when it says something the
      // address does not; the address itself is always the account's own.
      from: { name: record.label && record.label !== record.email ? record.label : "", address: record.email },
      to: input?.to ?? [],
      cc: input?.cc ?? [],
      bcc: input?.bcc ?? [],
      subject: input?.subject ?? "",
      text: input?.text ?? "",
      attachments: files,
      inReplyTo: input?.inReplyTo ?? "",
      references: input?.references ?? [],
    });
    const request = {
      credential: { slot: SLOT_ID, instanceId: record.instanceId },
      envelope: built.envelope,
      mime: new Uint8Array(built.mime),
      timeoutMs: SEND_TIMEOUT_MS,
    };
    if (record.sendTarget?.endpoint) request.endpoint = record.sendTarget.endpoint;
    const result = await host.mail.send(request);
    const filed = await fileSentCopy(record, built.mime);
    return {
      accountId: record.instanceId,
      accepted: Array.isArray(result?.accepted) ? result.accepted : [],
      rejected: Array.isArray(result?.rejected) ? result.rejected : [],
      messageId: built.messageId,
      serverMessageId: result?.messageId ?? null,
      size: built.size,
      attachments: files.length,
      forwarded,
      filed,
    };
  }

  return {
    get accounts() {
      return [...accounts.values()];
    },

    async load() {
      loaded = true;
      await refresh();
    },

    async unload() {
      loaded = false;
      for (const record of accounts.values()) await stopAccount(record);
      accounts.clear();
    },

    refresh,

    /** Everything the panel renders in one answer. */
    snapshot(locale) {
      const list = [...accounts.values()];
      return {
        accounts: list.map((record) => accountView(record, locale)),
        providers: providers.catalogue(locale),
        messages: messageViews(),
        // What "open a message" has kept on this computer, so the panel can show it
        // and offer to empty it.
        cache: bodyCache.stats(),
        // No account ceiling: the manifest declares no `max`, and the host keeps
        // its own safety bound. What is bounded here is one account's list.
        limits: { messagesPerAccount: store.MESSAGES_LIMIT },
        empty: list.length === 0,
      };
    },

    /** Ask the host to collect one more mailbox. The host owns the form. */
    async addAccount() {
      if (typeof host.credentials?.requestAdd !== "function") {
        throw coded("UNSUPPORTED", "this app version cannot ask for a mailbox");
      }
      const result = await host.credentials.requestAdd(SLOT_ID);
      if (result?.instanceId) await refresh();
      return result ?? { cancelled: true };
    },

    async removeAccount(instanceId) {
      if (typeof host.credentials?.requestRemove !== "function") {
        throw coded("UNSUPPORTED", "this app version cannot remove a mailbox");
      }
      const result = await host.credentials.requestRemove(SLOT_ID, String(instanceId ?? ""));
      if (result?.removed) await refresh();
      return result ?? { cancelled: true };
    },

    async checkNow(instanceId) {
      const targets = instanceId
        ? [accounts.get(instanceId)].filter(Boolean)
        : [...accounts.values()].filter((record) => record.watcher);
      let handled = 0;
      let checked = 0;
      for (const record of targets) {
        if (!record.watcher) continue;
        const status = await record.watcher.checkNow();
        if (status.checked) checked += 1;
        handled += status.handled ?? 0;
      }
      return { accounts: targets.length, checked: checked > 0, handled };
    },

    /**
     * One message's body, for the panel or for an agent tool.
     *
     * The bytes are kept on this computer by `lib/body-cache.js`, so opening the
     * same message a second time downloads nothing. Nothing else about opening
     * changes:
     *
     * - the cache is a miss whenever it cannot answer — missing, expired, damaged,
     *   unwritable — and the body is downloaded exactly as before, so a broken cache
     *   is never something the user sees;
     * - IMAP still asks the server for the mailbox's `UIDVALIDITY` before it hands
     *   anything back, so a renumbered mailbox refuses a stale key instead of serving
     *   whatever that number means now;
     * - `options.markRead` still separates the panel from the tools: the panel
     *   opening an unread message sends one `UID STORE +FLAGS (\Seen)` even when the
     *   body came from disk, while a tool's read changes no flag anywhere. A failed
     *   mark is reported as `readError` and never costs the user the message.
     */
    async openMessage(input, options = {}) {
      const markRead = options.markRead !== false;
      const record = accounts.get(String(input?.accountId ?? ""));
      if (!record) throw coded("ACCOUNT_NOT_FOUND", "this mailbox is not in the list");
      const state = accountStateOf(record.instanceId);
      const envelope = envelopeFor(state, input);
      if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      // A UID the store does not hold names a message the poll window never
      // covered; its own headers are the only place its subject and sender are.
      const stored = store.findEnvelope(state, envelope.key) !== null;
      const cached = await bodyCache.read(record.instanceId, bodyKeyOf(record, envelope));
      // Two ways to read one message body, one per protocol, and one rule for
      // both: a body the panel fetched is a message the user just read, so it is
      // marked read only after the body actually arrived — and not at all when an
      // agent tool asked for it. IMAP sends one `UID STORE +FLAGS (\\Seen)`;
      // POP3 has no such flag, so the mark is local.
      let fetched = cached;
      let readError = null;
      if (record.protocol === "pop3") {
        if (!fetched) {
          fetched = await record.watcher.fetchBody(envelope.key, {
            maxBytes: BODY_LIMIT,
            timeoutMs: BODY_TIMEOUT_MS,
          });
          await keepBody(record, envelope, fetched);
        }
        if (markRead) {
          store.markReadLocally(state, envelope.key);
          await deps.persist();
        }
      } else {
        // The panel's own envelope carries the flags the poll saw: a body fetch
        // does not report flags on every server, and a message the user already
        // read must not be stored again.
        const alreadySeen = Array.isArray(envelope.flags) && envelope.flags.includes("\\Seen");
        fetched = await record.watcher.withSession(async (session, box) => {
          // A cached body is this message's only while the era still matches: an
          // entry's name carries the `UIDVALIDITY` (`bodyKeyOf`), and a mailbox that
          // was rebuilt answers `MESSAGE_STALE` here rather than handing over bytes
          // that belong to whatever holds that number now.
          requireCurrentEra(envelope, box);
          const message = cached ?? await session.fetchMessage(envelope.uid, {
            maxBytes: BODY_LIMIT,
            timeoutMs: BODY_TIMEOUT_MS,
          });
          // `markRead` is false for an agent tool: one `\Seen` STORE is a mail
          // state change, and a read performed for the model must not make one.
          if (!alreadySeen && markRead) {
            try {
              const flags = await session.storeFlags(envelope.uid, { add: ["\\Seen"], remove: [] });
              message.flags = Array.isArray(flags?.flags) && flags.flags.length
                ? flags.flags
                : [...(message.flags ?? []), "\\Seen"];
            } catch (error) {
              // A failed mark must not lose the message the user asked for.
              readError = String(error?.code ?? "FAILED");
            }
          }
          return message;
        });
        if (!cached) await keepBody(record, envelope, fetched);
        if (markRead && Array.isArray(fetched.flags) && fetched.flags.length) {
          store.setFlags(state, envelope.key, fetched.flags);
          await deps.persist();
        }
      }
      if (!stored) fillEnvelopeFromHeaders(envelope, fetched.body);
      const parsed = body.parseMessage(fetched.body);
      return {
        accountId: record.instanceId,
        accountLabel: record.label,
        protocol: record.protocol ?? "imap",
        flagsSupported: record.protocol !== "pop3",
        readLocally: record.protocol === "pop3" ? store.hasReadLocally(state, envelope.key) : false,
        readError,
        key: envelope.key,
        uid: envelope.uid,
        subject: envelope.subject,
        from: envelope.from,
        to: envelope.to,
        cc: envelope.cc,
        receivedAt: envelope.receivedAt,
        messageId: (parsed.headers["message-id"] || envelope.messageId || "").trim(),
        flags: store.findEnvelope(state, envelope.key)?.flags ?? envelope.flags,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments,
        canSend: sendBlockedReasonOf(record) === null,
        sendBlockedReason: sendBlockedReasonOf(record),
        limited: BODY_LIMIT,
        truncated: fetched.truncated,
        size: fetched.size,
      };
    },

    /** Explicitly mark the selected inboxes read, reporting partial failures. */
    async markAllRead(input) {
      const selected = input?.accountId === undefined
        ? [...accounts.values()]
        : [requireAccount(input.accountId)];
      const results = [];
      for (const record of selected) {
        let marked = 0;
        try {
          const state = accountStateOf(record.instanceId);
          if (record.protocol === "pop3") {
            for (const envelope of state.messages) {
              if (!store.hasReadLocally(state, envelope.key)) {
                store.markReadLocally(state, envelope.key);
                marked += 1;
              }
            }
          } else {
            if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
            const envelopes = [...state.messages];
            await record.watcher.withSession(async (session, box) => {
              // Refuse a stale list before changing anything on the server.
              for (const envelope of envelopes) requireCurrentEra(envelope, box);
              const uids = await session.searchNew({ unseen: true });
              if (accounts.get(record.instanceId) !== record) {
                throw coded("ACCOUNT_NOT_FOUND", "this mailbox changed during the operation");
              }
              for (let offset = 0; offset < uids.length; offset += 100) {
                const batch = uids.slice(offset, offset + 100);
                await session.markRead(batch);
                if (accounts.get(record.instanceId) !== record) {
                  throw coded("ACCOUNT_NOT_FOUND", "this mailbox changed during the operation");
                }
                const changed = new Set(batch);
                for (const envelope of state.messages) {
                  if (changed.has(envelope.uid)) {
                    store.setFlags(state, envelope.key, store.applyFlag(envelope.flags, "seen"));
                  }
                }
                marked += batch.length;
                await deps.persist();
              }
              // A flag may already have been changed by another mail client.
              for (const envelope of envelopes) {
                store.setFlags(state, envelope.key, store.applyFlag(envelope.flags, "seen"));
              }
            });
          }
          await deps.persist();
          results.push({ accountId: record.instanceId, marked });
        } catch (error) {
          log("warn", `mark all read failed: ${error?.code ?? "FAILED"}`);
          results.push({ accountId: record.instanceId, marked, code: String(error?.code ?? "FAILED") });
        }
      }
      return { results };
    },

    /**
     * One user click on one message's flag.
     *
     * The IMAP `STORE` goes first: a panel that flipped the star locally and then
     * failed would show a state the mailbox does not have. Only the server's
     * answer is written back, and a failure reaches the panel as a coded error.
     */
    async setFlag(input) {
      const record = accounts.get(String(input?.accountId ?? ""));
      if (!record) throw coded("ACCOUNT_NOT_FOUND", "this mailbox is not in the list");
      const flag = String(input?.flag ?? "");
      if (record.protocol === "pop3") {
        // POP3 has no flags on the server. Read is a mark this plugin keeps for
        // this machine, and a star has no equivalent at all.
        const state = accountStateOf(record.instanceId);
        const envelope = store.findEnvelope(state, String(input?.key ?? ""));
        if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
        if (flag === "seen") store.markReadLocally(state, envelope.key);
        else if (flag === "unseen") store.clearReadLocally(state, envelope.key);
        else throw coded("POP3_NO_FLAGS", "POP3 has no flags, only a read mark kept on this machine");
        await deps.persist();
        return {
          accountId: record.instanceId,
          key: envelope.key,
          flags: [],
          readLocally: store.hasReadLocally(state, envelope.key),
        };
      }
      const change = store.flagChange(flag);
      if (!change) throw coded("INVALID_ARGUMENT", "unknown flag");
      const state = accountStateOf(record.instanceId);
      const envelope = store.findEnvelope(state, String(input?.key ?? ""));
      if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      const result = await record.watcher.withSession((session, box) => {
        requireCurrentEra(envelope, box);
        return session.storeFlags(envelope.uid, change);
      });
      const flags = Array.isArray(result?.flags) && result.flags.length
        ? store.setFlags(state, envelope.key, result.flags)
        : store.setFlags(state, envelope.key, store.applyFlag(envelope.flags, flag));
      await deps.persist();
      return { accountId: record.instanceId, key: envelope.key, flags: flags ?? envelope.flags };
    },

    /**
     * Walk back through one mailbox for the panel's "load older".
     *
     * Bounded twice: the panel's list holds at most `store.MESSAGES_LIMIT`
     * envelopes per account, and `limit` is what is left of that budget. Nothing
     * is announced — this is browsing, not watching — and the cursor is untouched,
     * so the next poll still starts from the newest handled message.
     */
    async loadOlder(input) {
      const record = requireAccount(input?.accountId);
      const state = accountStateOf(record.instanceId);
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      const remaining = store.MESSAGES_LIMIT - state.messages.length;
      if (remaining <= 0) return { added: 0, reachedLimit: true, atEnd: false };
      const limit = Math.min(OLDER_PAGE_SIZE, remaining);
      let added = 0;
      if (record.protocol === "pop3") {
        // The list is newest first, so its last entry is the oldest the panel
        // holds; POP3 counts "older" in maildrop order, which matches arrival.
        const oldest = state.messages[state.messages.length - 1];
        if (!oldest) return { added: 0, reachedLimit: false, atEnd: true };
        const older = await record.watcher.loadOlder({ beforeKey: oldest.key, limit });
        added = older.length;
      } else {
        // Only the current era's envelopes can say where "older" starts: a UID
        // from a previous UIDVALIDITY names some other message now.
        const beforeUid = store.oldestUid(state, state.cursor?.uidValidity ?? null);
        if (!beforeUid) return { added: 0, reachedLimit: false, atEnd: true };
        const older = await record.watcher.loadOlder({ beforeUid, limit });
        added = older.length;
      }
      await deps.persist();
      return {
        added,
        atEnd: added === 0,
        reachedLimit: state.messages.length >= store.MESSAGES_LIMIT,
      };
    },

    /**
     * Delete one message, because the user asked for that one.
     *
     * IMAP moves it to the trash: `UID MOVE` where the server has it, otherwise
     * `UID COPY` + `\Deleted` + `UID EXPUNGE` of that one UID. A mailbox with
     * neither, or with no trash to move into, is refused with a code — there is no
     * mailbox-wide `EXPUNGE` anywhere in this plugin. POP3 has no trash at all, so
     * `DELE` is final and the session is ended with `QUIT` to commit it.
     *
     * The envelope leaves the list only after the server agreed.
     */
    async deleteMessage(input) {
      const record = requireAccount(input?.accountId);
      const state = accountStateOf(record.instanceId);
      const envelope = requireEnvelope(state, input?.key);
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      if (record.protocol === "pop3") {
        await record.watcher.deleteMessage(envelope.key);
        store.removeEnvelope(state, envelope.key);
        store.pop3Forget(state, envelope.key.replace(/^pop3:/, ""));
        await bodyCache.remove(record.instanceId, bodyKeyOf(record, envelope));
        await deps.persist();
        return { accountId: record.instanceId, key: envelope.key, removed: true, final: true, folder: null };
      }
      const result = await record.watcher.withSession(async (session, box, capabilities) => {
        requireCurrentEra(envelope, box);
        const known = await ensureFolders(record, session, capabilities);
        if (!known?.trash) {
          throw coded("NO_TRASH_FOLDER", "this mailbox has no trash folder to move the message to");
        }
        const how = await moveOutOfInbox(session, capabilities, envelope.uid, known.trash);
        return { folder: known.trash, how };
      });
      store.removeEnvelope(state, envelope.key);
      // The message left this mailbox, so the body kept for it goes too.
      await bodyCache.remove(record.instanceId, bodyKeyOf(record, envelope));
      await deps.persist();
      return { accountId: record.instanceId, key: envelope.key, removed: true, final: false, ...result };
    },

    /**
     * Archive one message, because the user asked for that one.
     *
     * IMAP only, and only when a `LIST` found an archive mailbox: the special-use
     * `\Archive` first, then the names a provider's web interface shows (Gmail's
     * `[Gmail]/All Mail` behaves as one over IMAP). POP3 has no folders, so the
     * panel never offers this there.
     */
    async archive(input) {
      const record = requireAccount(input?.accountId);
      const state = accountStateOf(record.instanceId);
      const envelope = requireEnvelope(state, input?.key);
      if (record.protocol === "pop3") throw coded("NO_ARCHIVE_FOLDER", "POP3 has no folders to archive into");
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      const result = await record.watcher.withSession(async (session, box, capabilities) => {
        requireCurrentEra(envelope, box);
        const known = await ensureFolders(record, session, capabilities);
        if (!known?.archive) {
          throw coded("NO_ARCHIVE_FOLDER", "this mailbox has no archive folder");
        }
        const how = await moveOutOfInbox(session, capabilities, envelope.uid, known.archive);
        return { folder: known.archive, how };
      });
      store.removeEnvelope(state, envelope.key);
      await bodyCache.remove(record.instanceId, bodyKeyOf(record, envelope));
      await deps.persist();
      return { accountId: record.instanceId, key: envelope.key, removed: true, ...result };
    },

    /**
     * The draft a reply, a reply-all or a forward opens with.
     *
     * Everything here comes from the message the panel already opened — its
     * headers, its text and its attachment part numbers — so pressing "reply"
     * costs no network request. The panel only renders this and lets the user edit
     * it; the rules that decide who is answered, what the subject becomes and how
     * the original is quoted live in `lib/compose.js` and are tested there.
     */
    async draft(input) {
      const record = requireAccount(input?.accountId);
      const state = accountStateOf(record.instanceId);
      const envelope = requireEnvelope(state, input?.key);
      const mode = String(input?.mode ?? "reply");
      if (mode !== "reply" && mode !== "replyAll" && mode !== "forward") {
        throw coded("INVALID_ARGUMENT", "unknown draft mode");
      }
      const opened = await openedMessageOf(record, envelope);
      const headers = opened.headers ?? {};
      const locale = deps.locale();
      const original = {
        from: envelope.from ?? { name: "", address: "" },
        to: Array.isArray(envelope.to) ? envelope.to : [],
        cc: Array.isArray(envelope.cc) ? envelope.cc : [],
        subject: envelope.subject ?? "",
        date: formatMessageDate(envelope.receivedAt, locale),
      };
      const messageId = String(headers["message-id"] || envelope.messageId || "").trim();
      const references = String(headers["references"] || "").trim();
      const blocked = sendBlockedReasonOf(record);
      const base = {
        accountId: record.instanceId,
        mode,
        inReplyTo: messageId,
        references: compose.referencesFor({ references, inReplyTo: messageId }),
        canSend: blocked === null,
        sendBlockedReason: blocked,
      };
      if (mode === "forward") {
        return {
          ...base,
          to: [],
          cc: [],
          subject: compose.forwardSubject(original.subject),
          text: compose.forwardBody({
            ...original,
            text: opened.text ?? "",
            html: opened.html ?? "",
            locale,
          }),
          // The original's attachments are offered as a choice, not attached: the
          // panel lists them and the send carries only the ones the user ticked.
          forwardOf: {
            accountId: record.instanceId,
            key: envelope.key,
            // A forwarded attachment is named by its section number, exactly like a
            // saved one: an index into the panel's list means something else to the
            // server's structure as soon as the message has an inline image.
            attachments: (opened.attachments ?? []).map((file) => ({
              part: file.part,
              filename: file.filename,
              size: file.size,
            })),
          },
        };
      }
      const targets = replyRecipients(record, envelope, headers, { all: mode === "replyAll" });
      return {
        ...base,
        to: targets.to,
        cc: targets.cc,
        subject: compose.replySubject(original.subject),
        text: compose.replyBody({
          text: opened.text ?? "",
          html: opened.html ?? "",
          from: original.from,
          date: original.date,
          locale,
        }),
        forwardOf: null,
      };
    },

    /**
     * Answer one message, for the agent tool the user approved.
     *
     * A reply has to thread (`In-Reply-To`, `References`) and quote, and both
     * come from the original's own headers and text. That is the same capped
     * fetch opening a message does, except this one leaves `\Seen` alone: an
     * agent reading mail is not the user reading it.
     */
    async sendReply(input) {
      const record = requireAccount(input?.accountId);
      const state = accountStateOf(record.instanceId);
      const envelope = envelopeFor(state, input);
      if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
      const text = String(input?.text ?? "").trim();
      if (!text) throw coded("INVALID_ARGUMENT", "a reply needs a text body");
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      // The same bytes a read of this message would have downloaded: a reply to mail
      // the user (or the agent) already opened costs no second fetch.
      const cached = await bodyCache.read(record.instanceId, bodyKeyOf(record, envelope));
      const fetched = cached ?? (record.protocol === "pop3"
        ? await record.watcher.fetchBody(envelope.key, { maxBytes: BODY_LIMIT, timeoutMs: BODY_TIMEOUT_MS })
        : await record.watcher.withSession((session, box) => {
            requireCurrentEra(envelope, box);
            return session.fetchMessage(envelope.uid, { maxBytes: BODY_LIMIT, timeoutMs: BODY_TIMEOUT_MS });
          }));
      if (!cached) await keepBody(record, envelope, fetched);
      if (!store.findEnvelope(state, envelope.key)) fillEnvelopeFromHeaders(envelope, fetched.body);
      const parsed = body.parseMessage(fetched.body);
      const headers = parsed.headers ?? {};
      const messageId = String(headers["message-id"] || envelope.messageId || "").trim();
      const locale = deps.locale();
      const targets = replyRecipients(record, envelope, headers, { all: input?.replyAll === true });
      if (!targets.to.length) throw coded("NO_RECIPIENTS", "this message has no sender to answer");
      return sendMessage({
        accountId: record.instanceId,
        to: targets.to,
        cc: targets.cc,
        subject: compose.replySubject(envelope.subject ?? ""),
        // The agent's own words, then the quoted original the panel would have
        // put there — the same attribution line, in the user's language.
        text: `${text}${compose.replyBody({
          text: parsed.text ?? "",
          html: parsed.html ?? "",
          from: envelope.from ?? {},
          date: formatMessageDate(envelope.receivedAt, locale),
          locale,
        })}`,
        inReplyTo: messageId,
        references: compose.referencesFor({
          references: String(headers["references"] || "").trim(),
          inReplyTo: messageId,
        }),
        attachments: [],
      });
    },

    /**
     * Send one message, because the user pressed send or approved a tool call.
     *
     * The message is built here (`lib/compose.js`) and delivered by the host
     * (`pi.mail.send`): the plugin never sees the password, the connection or the
     * server's text, only the outcome. The endpoint is named for a preset account
     * and omitted for an account with its own outgoing server, which is the rule
     * the host enforces and `lib/providers.js` decides.
     *
     * A send that succeeded files one copy in the account's Sent mailbox; a send
     * the host refused throws its own code, and the panel keeps the draft.
     */
    send(input) {
      return sendMessage(input);
    },

    /**
     * Save one attachment of one message where the user points the save dialog.
     *
     * The bytes are fetched for this one click (`attachmentBytes`), written by the
     * host's own dialog, and dropped: nothing is kept in the plugin's data folder,
     * and a cancelled dialog is an answer, not an error.
     */
    async saveAttachment(input) {
      const record = requireAccount(input?.accountId);
      const state = accountStateOf(record.instanceId);
      const envelope = requireEnvelope(state, input?.key);
      if (typeof host.fs?.saveAs !== "function") {
        throw coded("UNSUPPORTED", "this app version cannot save a file");
      }
      const file = await attachmentBytes(record, envelope, {
        part: input?.part,
        filename: input?.filename,
      });
      if (file.data.length > SAVE_LIMIT) {
        throw coded("ATTACHMENT_TOO_LARGE", "this attachment is larger than one save may write");
      }
      const saved = await host.fs.saveAs({
        suggestedName: attachments.suggestedName(file.filename),
        data: new Uint8Array(file.data),
        mimeType: file.type || "application/octet-stream",
      });
      if (!saved || !saved.path) return { cancelled: true };
      return {
        cancelled: false,
        part: file.part,
        name: String(saved.name ?? ""),
        size: file.data.length,
      };
    },

    /** Open a provider's web mailbox in the user's own browser. */
    async openWebmail(instanceId) {
      const record = accounts.get(String(instanceId ?? ""));
      if (!record) throw coded("ACCOUNT_NOT_FOUND", "this mailbox is not in the list");
      // A server the user typed has no web mailbox this plugin could name, and
      // guessing one would send the user to a page that is not their mail host.
      if (record.custom) throw coded("NO_WEBMAIL", "a custom mail server has no known web mailbox");
      const provider = providers.findProvider(record.provider);
      if (!provider) throw coded("PROVIDER_UNSELECTED", "this account has no mail provider yet");
      if (typeof host.shell?.openExternal !== "function") {
        throw coded("UNSUPPORTED", "this app version cannot open a browser");
      }
      await host.shell.openExternal(provider.webmail);
      return { url: provider.webmail };
    },

    /** The URL a link in a message opens with, after the panel asked for it. */
    async openExternal(url) {
      const target = String(url ?? "").trim();
      if (!/^https?:\/\//i.test(target) && !/^mailto:/i.test(target)) {
        throw coded("INVALID_ARGUMENT", "only http, https and mailto links are opened");
      }
      if (typeof host.shell?.openExternal !== "function") {
        throw coded("UNSUPPORTED", "this app version cannot open a browser");
      }
      await host.shell.openExternal(target);
      return { url: target };
    },
  };
}

module.exports = { BODY_LIMIT, BODY_TIMEOUT_MS, OLDER_PAGE_SIZE, SLOT_ID, createRuntime };
