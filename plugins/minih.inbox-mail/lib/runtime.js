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
 * - **One connection per account.** A watcher dials one socket and keeps it in
 *   IDLE; the panel's "open this message" and "mark it read" are queued jobs that
 *   run on that same socket between two IDLEs (`watcher.runJob`). Five accounts
 *   therefore cost five of the host's eight per-plugin TCP connections, and no
 *   action in the panel can open a sixth.
 * - **The host owns the account list.** Every refresh reads
 *   `pi.credentials.list()` and makes the local set match it: a new instance
 *   starts watching, a removed one stops and its state is deleted. The plugin
 *   never invents an account and never keeps one the host no longer has.
 */

const body = require("./body");
const accountsFile = require("./accounts");
const messages = require("./messages");
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
   * The endpoint comes from the provider table, never from a setting, and the
   * credential instance is named as `<slot>#<instanceId>` because the slot holds
   * several accounts: the host refuses a bare slot id for a `multiple` slot, and
   * it would sign in as the wrong mailbox if this file picked one.
   */
  async function connectAccount(account) {
    const provider = providers.findProvider(account.provider);
    if (!provider) throw coded("PROVIDER_UNSELECTED", "this account has no mail provider yet");
    if (provider.auth !== "password") {
      throw coded("PROVIDER_NEEDS_OAUTH", `${provider.label} requires OAuth2 for IMAP`);
    }
    if (typeof host.net?.tcp?.connect !== "function") {
      throw coded("UNSUPPORTED", "this app version has no net.tcp");
    }
    const handle = await host.net.tcp.connect({
      endpoint: { host: provider.host, port: provider.port },
      credentialRef: `${SLOT_ID}#${account.instanceId}`,
    });
    return createSession(wrapTransport(handle.connectionId), { log });
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
    record.watcher = createWatcher({
      account: { instanceId: record.instanceId, label: record.label },
      state: accountStateOf(record.instanceId),
      persist: () => deps.persist(),
      settings: () => deps.settings(),
      provider: () => snapshot.provider,
      connect: () => connectAccount(snapshot),
      notify: {
        alert: (message) => notifyAlert(snapshot, message),
        digest: (entries) => notifyDigest(snapshot, entries),
      },
      onError: (error) => onAccountError(snapshot, error),
      log,
      now: () => Date.now(),
      timers: { setTimeout, clearTimeout },
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
        record = { instanceId: instance.instanceId, label, email, provider: null, watcher: null };
        accounts.set(instance.instanceId, record);
      }
      record.label = label;
      record.email = email;
      const stored = providerOf(instance.instanceId);
      let provider = stored;
      if (!provider) {
        // First sight of this account: infer from the address when the domain has
        // exactly one mail service, and otherwise leave it unselected until the
        // user picks one in the panel. Connecting on a guess would send the
        // password to the wrong server.
        const inferred = providers.inferProviderId(email);
        if (inferred) provider = accountsFile.setProvider(root, instance.instanceId, inferred);
      }
      if (provider && record.provider !== provider.id) {
        await stopAccount(record);
        record.provider = provider.id;
      } else {
        record.provider = provider ? provider.id : null;
      }
      if (record.provider && !record.watcher) {
        startAccount(record);
        startedAny = true;
      }
    }
    await deps.persist();
    return { accounts: [...accounts.values()], startedAny };
  }

  function statusFor(record) {
    const state = accountStateOf(record.instanceId);
    if (!record.provider) {
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
    const provider = providers.findProvider(record.provider);
    return {
      instanceId: record.instanceId,
      label: record.label,
      email: record.email,
      provider: provider
        ? {
            id: provider.id,
            title: provider.title[locale] ?? provider.title.en,
            available: provider.auth === "password",
          }
        : null,
      // The panel offers the mailbox page for the provider it knows; a mailbox
      // with no provider has no page to offer.
      webmail: provider ? provider.webmail : null,
      status: statusFor(record),
    };
  }

  function messageViews() {
    const list = [];
    for (const record of accounts.values()) {
      for (const envelope of accountStateOf(record.instanceId).messages) {
        list.push({
          accountId: record.instanceId,
          accountLabel: record.label,
          key: envelope.key,
          uid: envelope.uid,
          from: envelope.from,
          subject: envelope.subject,
          receivedAt: envelope.receivedAt,
          unread: !envelope.flags.includes("\\Seen"),
          starred: envelope.flags.includes("\\Flagged"),
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
      const provider = providers.findProvider(String(providerId ?? ""));
      if (!provider) throw coded("INVALID_ARGUMENT", "unknown mail provider");
      if (provider.auth !== "password") {
        throw coded("PROVIDER_NEEDS_OAUTH", `${provider.label} requires OAuth2 for IMAP, which this app cannot do yet`);
      }
      accountsFile.setProvider(root, instanceId, provider.id);
      await deps.persist();
      await stopAccount(record);
      record.provider = provider.id;
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
      const fetched = await record.watcher.runJob(
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
