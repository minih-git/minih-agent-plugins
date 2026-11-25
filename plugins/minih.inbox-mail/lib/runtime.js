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

const body = require("./body");
const accountsFile = require("./accounts");
const { createGate } = require("./gate");
const mailboxes = require("./mailboxes");
const messages = require("./messages");
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

  function notifyAlert(account, message) {
    const strings = deps.text();
    const accountLabel = account.label || account.instanceId;
    return deps.postRow({
      kind: "alert",
      title: messages.clamp(message.subject || strings.noSubject, messages.MAX_TITLE),
      body: messages.alertBody(message, strings, deps.locale(), accountLabel),
      // The account is part of the key: two mailboxes can legitimately hold the
      // same Message-ID — a message addressed to both of them, or a forward —
      // and one row must not suppress the other.
      dedupeKey: messages.clamp(`${account.instanceId}:${store.messageKey(message)}`, 240),
    });
  }

  function notifyDigest(account, entries) {
    if (!entries.length) return Promise.resolve();
    const strings = deps.text();
    const accountLabel = account.label || account.instanceId;
    return deps.postRow({
      kind: "digest",
      title: messages.digestTitle(entries.length, strings, accountLabel),
      body: messages.digestBody(entries, strings, accountLabel),
      // One rolling row per account: each account keeps its own interval anchor,
      // and merging them would need a queue that belongs to no account.
      dedupeKey: messages.clamp(`minih.inbox-mail:digest:${account.instanceId}`, 240),
    });
  }

  function onAccountError(account, error) {
    const code = String(error?.code ?? "");
    if (
      code === "CREDENTIAL_NOT_CONFIGURED" ||
      code === "CREDENTIAL_REJECTED" ||
      code === "CREDENTIAL_UNSUPPORTED" ||
      code === "CREDENTIAL_UNAVAILABLE" ||
      code === "CREDENTIAL_INSTANCE_REQUIRED" ||
      code === "PROVIDER_NEEDS_OAUTH" ||
      // A server the user typed can fail in ways a preset cannot: it may not
      // offer STARTTLS at all, or its certificate may not verify. Those are
      // account settings to fix, not transients to retry silently.
      code === "STARTTLS_UNAVAILABLE" ||
      code === "TLS_FAILED" ||
      code === "TLS_CERTIFICATE" ||
      // A proxy the user configured is an account setting too: the host never
      // falls back to a direct connection, so this has to be visible once.
      code === "PROXY_FAILED" ||
      code === "PROXY_AUTH_FAILED" ||
      code === "UNSUPPORTED"
    ) {
      void deps.postSetupNotice(account, error);
      return;
    }
    if (code === "PERMISSION_DENIED") {
      log("warn", `the host refused the mailbox connection: ${error.message}`);
    }
  }

  function startAccount(record) {
    if (record.watcher) return;
    const snapshot = record;
    const shared = {
      account: { instanceId: record.instanceId, label: record.label },
      state: accountStateOf(record.instanceId),
      persist: () => deps.persist(),
      settings: () => deps.settings(),
      notify: {
        alert: (message) => notifyAlert(snapshot, message),
        digest: (entries) => notifyDigest(snapshot, entries),
      },
      onError: (error) => onAccountError(snapshot, error),
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
     * Download one message body for the panel, in memory only.
     *
     * Nothing here is persisted: the parsed body is returned to the caller and
     * dropped with the response, so "open a message" cannot leave a mailbox's
     * text on disk.
     */
    async openMessage(input) {
      const record = accounts.get(String(input?.accountId ?? ""));
      if (!record) throw coded("ACCOUNT_NOT_FOUND", "this mailbox is not in the list");
      const state = accountStateOf(record.instanceId);
      const envelope = store.findEnvelope(state, String(input?.key ?? ""));
      if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      // Two ways to read one message body, one per protocol, and one rule for
      // both: a body that was fetched is a message the user just read, so it is
      // marked read only after the body actually arrived. IMAP sends one
      // `UID STORE +FLAGS (\\Seen)`; POP3 has no such flag, so the mark is local.
      let fetched;
      let readError = null;
      if (record.protocol === "pop3") {
        fetched = await record.watcher.fetchBody(envelope.key, {
          maxBytes: BODY_LIMIT,
          timeoutMs: BODY_TIMEOUT_MS,
        });
        store.markReadLocally(state, envelope.key);
        await deps.persist();
      } else {
        // The panel's own envelope carries the flags the poll saw: a body fetch
        // does not report flags on every server, and a message the user already
        // read must not be stored again.
        const alreadySeen = Array.isArray(envelope.flags) && envelope.flags.includes("\\Seen");
        fetched = await record.watcher.withSession(async (session, box) => {
          requireCurrentEra(envelope, box);
          const message = await session.fetchMessage(envelope.uid, {
            maxBytes: BODY_LIMIT,
            timeoutMs: BODY_TIMEOUT_MS,
          });
          if (!alreadySeen) {
            try {
              const stored = await session.storeFlags(message.uid, { add: ["\\Seen"], remove: [] });
              message.flags = Array.isArray(stored?.flags) && stored.flags.length
                ? stored.flags
                : [...(message.flags ?? []), "\\Seen"];
            } catch (error) {
              // A failed mark must not lose the message the user asked for.
              readError = String(error?.code ?? "FAILED");
            }
          }
          return message;
        });
        if (Array.isArray(fetched.flags) && fetched.flags.length) {
          store.setFlags(state, envelope.key, fetched.flags);
          await deps.persist();
        }
      }
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
        receivedAt: envelope.receivedAt,
        flags: store.findEnvelope(state, envelope.key)?.flags ?? envelope.flags,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments,
        limited: BODY_LIMIT,
        truncated: fetched.truncated,
        size: fetched.size,
      };
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
      await deps.persist();
      return { accountId: record.instanceId, key: envelope.key, removed: true, ...result };
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
      await host.shell.openExternal({ url: provider.webmail });
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
      await host.shell.openExternal({ url: target });
      return { url: target };
    },
  };
}

module.exports = { BODY_LIMIT, BODY_TIMEOUT_MS, OLDER_PAGE_SIZE, SLOT_ID, createRuntime };
