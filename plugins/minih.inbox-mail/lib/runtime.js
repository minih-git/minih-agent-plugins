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

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function createRuntime(deps) {
  const host = deps.host;
  const root = deps.root;
  const log = deps.log ?? (() => {});
  const accounts = new Map();
  let loaded = false;

  const accountStateOf = (instanceId) => accountsFile.accountState(root, instanceId);
  const providerOf = (instanceId) => accountsFile.providerOf(root, instanceId);

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
    };
    // One protocol, one watcher: IMAP is pushed and keeps a connection, POP3 is
    // polled and must not keep one. The panel and the notifications are the same
    // code for both, which is why the two watchers share this shape.
    record.watcher = record.protocol === "pop3"
      ? createPop3Watcher({ ...shared, connect: () => connectPop3(snapshot) })
      : createWatcher({
          ...shared,
          // An account whose server the user edited must reconnect: the key is
          // the endpoint, not a provider id that stayed the same.
          provider: () => snapshot.connectionKey,
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
          protocol: null,
          connectionKey: "",
          watcher: null,
        };
        accounts.set(instance.instanceId, record);
      }
      record.label = label;
      record.email = email;
      // A server the user typed wins over every other rule: the endpoint lives in
      // the credential instance, and the host injects that instance's password
      // into that endpoint alone. Nothing is inferred from the domain here — the
      // domain says nothing about where a company's mail server is.
      const custom = providers.customEndpointOf(instance.publicFields);
      let provider = null;
      if (!custom) {
        provider = providerOf(instance.instanceId);
        if (!provider) {
          // First sight of this account: infer from the address when the domain
          // has exactly one mail service, and otherwise leave it unselected until
          // the user picks one in the panel. Connecting on a guess would send the
          // password to the wrong server.
          const inferred = providers.inferProviderId(email);
          if (inferred) provider = accountsFile.setProvider(root, instance.instanceId, inferred);
        }
      }
      const connectionKey = custom
        ? providers.endpointKey(custom)
        : provider
          ? `preset:${provider.id}`
          : "";
      record.custom = custom;
      record.provider = provider ? provider.id : null;
      record.protocol = custom ? custom.protocol : provider ? "imap" : null;
      if (record.connectionKey !== connectionKey) {
        // A different server, protocol or transport means the open connection is
        // to the wrong place: an edited account is not a poke.
        await stopAccount(record);
        record.connectionKey = connectionKey;
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
    // `connectionKey` is what there is to connect to: a preset provider id, or
    // the endpoint the user typed. Without one the account is waiting for the
    // panel, and saying "connecting" would be a lie.
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
    return {
      instanceId: record.instanceId,
      label: record.label,
      email: record.email,
      protocol: record.protocol ?? null,
      // What the panel may offer: a POP3 mailbox has no read or starred state.
      flagsSupported: record.protocol !== "pop3",
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
      for (const envelope of accountStateOf(record.instanceId).messages) {
        list.push({
          accountId: record.instanceId,
          accountLabel: record.label,
          flagsSupported,
          key: envelope.key,
          uid: envelope.uid,
          from: envelope.from,
          subject: envelope.subject,
          receivedAt: envelope.receivedAt,
          // `null` means "this mailbox does not report it". POP3 has no read or
          // starred state at all, and `false` here would claim the mail is read.
          unread: flagsSupported ? !envelope.flags.includes("\\Seen") : null,
          starred: flagsSupported ? envelope.flags.includes("\\Flagged") : null,
          important: envelope.important,
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
        limits: { maxAccounts: accountsFile.MAX_ACCOUNTS, messagesPerAccount: store.MESSAGES_LIMIT },
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

    /** Record the provider the user picked for one account, and connect it. */
    async setProvider(instanceId, providerId) {
      const record = accounts.get(instanceId);
      if (!record) throw coded("ACCOUNT_NOT_FOUND", "this mailbox is not in the list");
      // An account whose server the user typed is not a provider choice: that
      // endpoint lives in the credential instance, and a provider picked here
      // would be overwritten by the next refresh anyway.
      if (record.custom) {
        throw coded("CUSTOM_SERVER_ACCOUNT", "this mailbox already names its own server");
      }
      const provider = providers.findProvider(String(providerId ?? ""));
      if (!provider) throw coded("INVALID_ARGUMENT", "unknown mail provider");
      if (provider.auth !== "password") {
        throw coded("PROVIDER_NEEDS_OAUTH", `${provider.label} requires OAuth2 for IMAP, which this app cannot do yet`);
      }
      accountsFile.setProvider(root, instanceId, provider.id);
      await deps.persist();
      await stopAccount(record);
      record.provider = provider.id;
      record.custom = null;
      record.protocol = "imap";
      record.connectionKey = `preset:${provider.id}`;
      startAccount(record);
      return { instanceId, provider: provider.id };
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
      // Two ways to read one message body, one per protocol: IMAP keeps the
      // account's own connection and fetches a capped section on it, while POP3
      // opens a short session of its own and resolves the UIDL to the message
      // number of that session first.
      const fetched = record.protocol === "pop3"
        ? await record.watcher.fetchBody(envelope.key, { maxBytes: BODY_LIMIT, timeoutMs: BODY_TIMEOUT_MS })
        : await record.watcher.runJob(
            (session) => session.fetchMessage(envelope.uid, { maxBytes: BODY_LIMIT, timeoutMs: BODY_TIMEOUT_MS }),
            {},
          );
      const parsed = body.parseMessage(fetched.body);
      if (Array.isArray(fetched.flags) && fetched.flags.length) {
        store.setFlags(state, envelope.key, fetched.flags);
        await deps.persist();
      }
      return {
        accountId: record.instanceId,
        accountLabel: record.label,
        protocol: record.protocol ?? "imap",
        flagsSupported: record.protocol !== "pop3",
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
      // POP3 reports no flags at all, so there is nothing to send and nothing to
      // show: the panel hides these actions and this refuses them anyway.
      if (record.protocol === "pop3") {
        throw coded("POP3_NO_FLAGS", "POP3 does not report read or starred state");
      }
      const flag = String(input?.flag ?? "");
      const change = store.flagChange(flag);
      if (!change) throw coded("INVALID_ARGUMENT", "unknown flag");
      const state = accountStateOf(record.instanceId);
      const envelope = store.findEnvelope(state, String(input?.key ?? ""));
      if (!envelope) throw coded("MESSAGE_NOT_FOUND", "this message is not in the list");
      if (!record.watcher) throw coded("ACCOUNT_OFFLINE", "this mailbox is not connected yet");
      const result = await record.watcher.runJob((session) => session.storeFlags(envelope.uid, change), {});
      const flags = Array.isArray(result?.flags) && result.flags.length
        ? store.setFlags(state, envelope.key, result.flags)
        : store.setFlags(state, envelope.key, store.applyFlag(envelope.flags, flag));
      await deps.persist();
      return { accountId: record.instanceId, key: envelope.key, flags: flags ?? envelope.flags };
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

module.exports = { BODY_LIMIT, BODY_TIMEOUT_MS, SLOT_ID, createRuntime };
