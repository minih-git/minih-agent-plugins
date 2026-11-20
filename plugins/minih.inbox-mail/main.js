"use strict";

/**
 * Inbox mail — Minih-Agent-Desktop plugin entry (plugin process).
 *
 * The plugin watches one mailbox the user configured in Settings and turns what
 * arrives into notification-centre entries: one `alert` for a message the rules
 * consider important, one rolling `digest` for everything else. It is the first
 * information source of a resident assistant, and it is deliberately the
 * cheapest kind: no model call, no token, no provider request — collection,
 * de-duplication, the rule and the notification are all local and deterministic.
 *
 * Read-only, by construction rather than by promise. The only IMAP verbs this
 * plugin sends are `CAPABILITY`, `ID`, `SELECT INBOX`, `UID SEARCH`, `UID FETCH`
 * with `BODY.PEEK`, `IDLE`, `DONE` and `LOGOUT`; there is no path in this
 * plugin that sends mail, deletes it, moves it or changes its flags. The user's
 * password never reaches this file either: the host performs the login and hands
 * over an already-authenticated socket.
 *
 * Division of responsibility with the host:
 *
 *   - the host holds the credential (`credentials.use`), opens and keeps the
 *     socket (`net.tcp`), owns the timer (`scheduler`) and stores the rows
 *     (`notify.center`);
 *   - this file owns the protocol (`lib/session.js`), the waiting and reconnecting
 *     (`lib/watcher.js`), the rules (`lib/rules.js`) and the small state file.
 *
 * What is stored, and nothing else: the UID cursor (`UIDVALIDITY` + highest
 * handled UID), the Message-IDs already reported (bounded), and the digest queue
 * waiting for its interval. No message body is ever fetched, and no message text
 * is copied into the state file.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const messages = require("./lib/messages");
const providers = require("./lib/providers");
const { createSession } = require("./lib/session");
const { normalizeSettings } = require("./lib/settings");
const store = require("./lib/store");
const { createWatcher } = require("./lib/watcher");
const { version: PLUGIN_VERSION } = require("./package.json");

/** The one credential slot the user fills in. */
const SLOT_ID = "mailbox";
const STATE_FILE = "inbox-mail.json";
/** The command a notification links to, and the one the palette shows. */
const COMMAND_ID = "check-now";
/** One row for the setup problem, updated in place instead of added again. */
const CREDENTIALS_KEY = "minih.inbox-mail:credentials";
/** One row for the roll-up; re-posting it updates that row. */
const DIGEST_KEY = "minih.inbox-mail:digest";
let host = null;
let locale = "en";
let state = store.emptyState();
let settingsCache = normalizeSettings({});
let watcher = null;
let subscriptions = [];
let writing = Promise.resolve();
let setupNoticePosted = false;
/** The transport of the current connection, closed by `onUnload`. */
let connection = null;

function text() {
  return messages.messages(locale);
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** One line on stderr at most: the host owns the log surface. */
function log(level, message) {
  if (level === "warn" || level === "error") console.warn(`[inbox-mail] ${message}`);
}

async function refreshLocale() {
  try {
    const value = await host.app?.getLocale?.();
    locale = typeof value === "string" && value.startsWith("zh") ? "zh-CN" : "en";
  } catch {
    locale = "en";
  }
}

async function readSettings() {
  try {
    settingsCache = normalizeSettings(await host.plugin.getSettings());
  } catch (error) {
    log("warn", `could not read settings: ${error?.message ?? error}`);
    settingsCache = normalizeSettings({});
  }
  return settingsCache;
}

async function loadState() {
  try {
    const file = path.join(await host.plugin.getDataPath(), STATE_FILE);
    state = store.normalizeState(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    // A missing or unreadable file is the first run, not a failure: the cursor
    // is rebuilt from the server and nothing is reported from the archive.
    state = store.emptyState();
  }
}

/**
 * Save the whole state file, one writer at a time.
 *
 * Two overlapping writes of a whole JSON document would let the older snapshot
 * win, which for a UID cursor means re-reporting mail that was already handled.
 */
function persist(next) {
  writing = writing
    .then(async () => {
      const file = path.join(await host.plugin.getDataPath(), STATE_FILE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
    })
    .catch((error) => {
      log("warn", `could not write the mailbox state: ${error?.message ?? error}`);
    });
  return writing;
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

  const transport = {
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
  connection = transport;
  return transport;
}

/**
 * Open one authenticated IMAP session.
 *
 * The endpoint comes from the provider table, never from a setting: the host
 * refuses any endpoint outside `manifest.net.tcp` anyway, and the user chose a
 * provider rather than a server.
 */
async function connectMailbox() {
  const provider = providers.providerFor(settingsCache.provider);
  if (provider.auth !== "password") {
    throw coded("PROVIDER_NEEDS_OAUTH", `${provider.label} requires OAuth2 for IMAP`);
  }
  if (typeof host.net?.tcp?.connect !== "function") {
    throw coded("UNSUPPORTED", "this app version has no net.tcp");
  }
  const slots = await host.credentials.list();
  if (!slots.some((slot) => slot.id === SLOT_ID && slot.configured)) {
    throw coded("CREDENTIAL_NOT_CONFIGURED", "the mailbox credential slot is empty");
  }
  const handle = await host.net.tcp.connect({
    endpoint: { host: provider.host, port: provider.port },
    credentialRef: SLOT_ID,
  });
  const transport = wrapTransport(handle.connectionId);
  return createSession(transport, { log });
}

/**
 * One alert row per message the rules picked out.
 *
 * The `dedupeKey` is the message's own identity, so a reconnect, a second copy or
 * a restart updates the same row instead of adding another one.
 */
function notifyAlert(message) {
  const strings = text();
  return postRow({
    kind: "alert",
    title: messages.clamp(message.subject || strings.noSubject, messages.MAX_TITLE),
    body: messages.alertBody(message, strings, locale),
    dedupeKey: messages.clamp(store.messageKey(message), 240),
  });
}

/** One rolling row for the batch. */
function notifyDigest(entries) {
  if (!entries.length) return Promise.resolve();
  const strings = text();
  return postRow({
    kind: "digest",
    title: messages.clamp(strings.digestTitle(entries.length), messages.MAX_TITLE),
    body: messages.digestBody(entries, strings),
    dedupeKey: DIGEST_KEY,
  });
}

/** Every row this plugin writes links to its one command. */
function postRow(row) {
  return host.notify
    .center({ ...row, link: { command: COMMAND_ID } })
    .catch((error) => log("warn", `could not post a ${row.kind}: ${error?.message ?? error}`));
}

/**
 * Say once per plugin load why nothing is arriving.
 *
 * The user has no panel to look at in this slice, so the notification centre is
 * the only surface that can explain a missing credential; re-posting the same
 * dedupe key updates that row instead of filling the list.
 */
function postSetupNotice(error) {
  if (setupNoticePosted) return Promise.resolve();
  setupNoticePosted = true;
  const strings = text();
  return postRow({
    kind: "alert",
    title: messages.clamp(strings.needsSetup, messages.MAX_TITLE),
    body: messages.clamp(messages.setupReason(error?.code, strings), messages.MAX_BODY),
    dedupeKey: CREDENTIALS_KEY,
  });
}

function onError(error) {
  const code = String(error?.code ?? "");
  if (
    code === "CREDENTIAL_NOT_CONFIGURED" ||
    code === "CREDENTIAL_REJECTED" ||
    code === "CREDENTIAL_UNSUPPORTED" ||
    code === "CREDENTIAL_UNAVAILABLE" ||
    code === "PROVIDER_NEEDS_OAUTH" ||
    code === "UNSUPPORTED"
  ) {
    void postSetupNotice(error);
    return;
  }
  if (code === "PERMISSION_DENIED") {
    log("warn", `the host refused the mailbox connection: ${error.message}`);
  }
}

async function onCommand() {
  if (!host) throw coded("PLUGIN_INVALID", "the plugin is not loaded");
  await refreshLocale();
  await readSettings();
  const status = await watcher.checkNow();
  await host.ui
    ?.showToast?.(messages.checkedToast(status, text()), "info")
    .catch?.(() => undefined);
}

async function onLoad() {
  host = globalThis.pi ?? null;
  if (!host) {
    // A load without the host API is a broken load, not an old app: fail it, so
    // the host records a failure instead of installing a plugin that never works.
    throw coded("PLUGIN_INVALID", "plugin host API is missing (globalThis.pi)");
  }
  await refreshLocale();
  await loadState();
  await readSettings();

  watcher = createWatcher({
    connect: connectMailbox,
    state,
    persist,
    settings: () => normalizeSettings(settingsCache),
    notify: { alert: notifyAlert, digest: notifyDigest },
    onError,
    log,
    now: () => Date.now(),
    timers: { setTimeout, clearTimeout },
    clientId: { name: "Minih Agent Inbox Mail", vendor: "minih", version: PLUGIN_VERSION },
  });

  if (typeof host.commands?.register === "function") {
    await host.commands.register({
      id: COMMAND_ID,
      title: text().commandTitle,
      category: "Mail",
      keywords: ["mail", "inbox", "email"],
      run: onCommand,
    });
  }

  subscriptions = [
    {
      event: "schedule:fire",
      handler: () => {
        watcher?.poke();
      },
    },
    {
      event: "plugin:settingsChanged",
      handler: () => {
        void (async () => {
          await readSettings();
          watcher?.poke();
        })();
      },
    },
  ];
  for (const { event, handler } of subscriptions) host.events.on(event, handler);

  watcher.start();
}

async function onUnload() {
  for (const { event, handler } of subscriptions) {
    try {
      host?.events?.off?.(event, handler);
    } catch {
      // A subscription that is already gone needs no cleanup.
    }
  }
  subscriptions = [];
  await watcher?.stop().catch(() => undefined);
  watcher = null;
  await connection?.close?.().catch(() => undefined);
  connection = null;
  await writing;
  host = null;
}

module.exports = { onLoad, onUnload };
