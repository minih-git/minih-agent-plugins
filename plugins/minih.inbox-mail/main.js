"use strict";

/**
 * Inbox mail — Minih-Agent-Desktop plugin entry (plugin process).
 *
 * The plugin watches the mailboxes the user added (up to five, each a host-owned
 * credential instance) and turns what arrives into notification-centre entries:
 * one `alert` for a message the rules consider important, one rolling `digest`
 * per account for everything else. The Inbox panel in the sidebar shows the same
 * accounts together, opens one message body when the user clicks it, and changes
 * a read or star flag only when the user clicks that.
 *
 * An account is a listed provider (IMAP) or a mail server the user typed (IMAP or
 * POP3); the four non-secret fields of such a server come back in
 * `credentials.list`, and the endpoint itself never leaves the host's credential
 * store, which is what keeps the password bound to the server the user named.
 *
 * Division of responsibility with the host:
 *
 *   - the host holds the credentials (`credentials.use`), opens and keeps each
 *     socket (`net.tcp`), owns the timer (`scheduler`), stores the rows
 *     (`notify.center`) and opens the browser (`shell.openExternal`);
 *   - this file owns the plugin's own data file, the account list it derives from
 *     the host's, and the two surfaces the plugin exposes: the `check-now`
 *     command and the panel channels (`onPanelInvoke`).
 *
 * What is stored, and nothing else: per account the UID cursor (`UIDVALIDITY` +
 * highest handled UID), the Message-IDs already reported (bounded), the digest
 * queue, the last error, and the envelope of the newest messages the panel shows.
 * A message body is fetched only when the user opens that message, is kept in
 * memory for the answer, and never reaches this file.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const accountsFile = require("./lib/accounts");
const messages = require("./lib/messages");
const providers = require("./lib/providers");
const { normalizeSettings } = require("./lib/settings");
const { createRuntime, SLOT_ID } = require("./lib/runtime");
const { version: PLUGIN_VERSION } = require("./package.json");

const STATE_FILE = accountsFile.FILE;
const LEGACY_FILE = accountsFile.LEGACY_FILE;
/** The command a notification links to, and the one the palette shows. */
const COMMAND_ID = "check-now";
/** One row for "no mailbox at all", updated in place instead of added again. */
const CREDENTIALS_KEY = "minih.inbox-mail:credentials";

let host = null;
let locale = "en";
let settingsCache = normalizeSettings({});
/** The sheet as the host returned it, which is the only place a 0.1.0 provider survives. */
let rawSettings = {};
let root = accountsFile.emptyRoot();
let runtime = null;
let subscriptions = [];
let writing = Promise.resolve();
/** Rows posted once per load, so a retry loop cannot fill the notification list. */
const postedRows = new Set();

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
    rawSettings = (await host.plugin.getSettings()) ?? {};
    settingsCache = normalizeSettings(rawSettings);
  } catch (error) {
    log("warn", `could not read settings: ${error?.message ?? error}`);
    rawSettings = {};
    settingsCache = normalizeSettings({});
  }
  return settingsCache;
}

async function dataPath(name) {
  return path.join(await host.plugin.getDataPath(), name);
}

/** Read the accounts file. `null` means "this plugin has never run here". */
async function readRoot() {
  try {
    const raw = await fs.readFile(await dataPath(STATE_FILE), "utf8");
    return accountsFile.normalizeRoot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The 0.1.0 state file, if this is an upgrade from a single mailbox. */
async function readLegacy() {
  try {
    return JSON.parse(await fs.readFile(await dataPath(LEGACY_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function removeLegacy() {
  try {
    await fs.rm(await dataPath(LEGACY_FILE), { force: true });
  } catch (error) {
    log("warn", `could not remove the 0.1.0 state file: ${error?.message ?? error}`);
  }
}

/**
 * Save the whole file, one writer at a time.
 *
 * Two overlapping writes of a whole JSON document would let the older snapshot
 * win, which for a UID cursor means re-reporting mail that was already handled.
 */
function persist() {
  writing = writing
    .then(async () => {
      const file = await dataPath(STATE_FILE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(root, null, 2), "utf8");
    })
    .catch((error) => {
      log("warn", `could not write the mailbox state: ${error?.message ?? error}`);
    });
  return writing;
}

/**
 * Move the 0.1.0 mailbox under the instance the host migrated it to.
 *
 * The host turns the old single credential value into the first instance of the
 * slot, so an upgrade shortly after 0.1.0 has exactly one instance and its old
 * cursor, reported IDs and provider can be attributed without guessing. With two
 * accounts there is no honest answer, so the old file is left untouched: losing a
 * cursor costs nothing but re-reporting, and guessing could silence a mailbox.
 *
 * Re-entrant by construction: the old file is removed only after the new file is
 * on disk, so a crash in between repeats the same migration into the same account.
 */
async function migrateLegacy(instances) {
  const legacy = await readLegacy();
  if (!legacy) return false;
  if (instances.length !== 1) return false;
  const instanceId = instances[0].instanceId;
  // The 0.1.0 provider was a global setting. A host that still returns it is
  // the best evidence of which service this mailbox belongs to; without it the
  // address's domain has the next say, and otherwise the panel asks.
  accountsFile.adoptLegacy(root, instanceId, legacy, rawSettings.provider);
  if (!root.providers[instanceId]) {
    const email = instances[0].publicFields?.username ?? instances[0].label ?? "";
    const inferred = providers.inferProviderId(email);
    if (inferred) accountsFile.setProvider(root, instanceId, inferred);
  }
  await persist();
  await removeLegacy();
  return true;
}

/** Every row this plugin writes links to its one command. */
function postRow(row) {
  // A queued handler can run after the plugin was unloaded, and a row on a closed
  // host is not an error worth logging.
  if (!host) return Promise.resolve();
  return host.notify
    .center({ ...row, link: { command: COMMAND_ID } })
    .catch((error) => log("warn", `could not post a ${row.kind}: ${error?.message ?? error}`));
}

/**
 * Say once per plugin load why nothing is arriving for one account.
 *
 * The notification centre is the surface a user sees without opening the panel,
 * so a mailbox that cannot connect has to explain itself there. Re-posting the
 * same dedupe key updates that row instead of filling the list.
 */
function postSetupNotice(account, error) {
  const key = `${CREDENTIALS_KEY}:${account?.instanceId ?? "none"}`;
  if (postedRows.has(key)) return Promise.resolve();
  postedRows.add(key);
  const strings = text();
  return postRow({
    kind: "alert",
    title: messages.clamp(strings.needsSetup, messages.MAX_TITLE),
    body: messages.clamp(messages.setupReason(error?.code, strings), messages.MAX_BODY),
    dedupeKey: key,
  });
}

/** One row for a mailbox that still needs its provider chosen in the panel. */
function postProviderNotice(account) {
  const key = `${CREDENTIALS_KEY}:provider:${account.instanceId}`;
  if (postedRows.has(key)) return Promise.resolve();
  postedRows.add(key);
  const strings = text();
  return postRow({
    kind: "alert",
    title: messages.clamp(strings.needsProvider, messages.MAX_TITLE),
    body: messages.clamp(strings.needsProviderBody(account.label || account.email), messages.MAX_BODY),
    dedupeKey: key,
  });
}

/**
 * One explanation when the plugin has no mailbox at all.
 *
 * A fresh install has nothing to watch, and a plugin that stays silent looks
 * broken. This is the one row the 0.1.0 release posted for a missing credential,
 * kept under the same key so an upgrade replaces it rather than adding a second.
 */
function postNoAccountNotice() {
  if (postedRows.has(CREDENTIALS_KEY)) return Promise.resolve();
  postedRows.add(CREDENTIALS_KEY);
  const strings = text();
  return postRow({
    kind: "alert",
    title: messages.clamp(strings.needsSetup, messages.MAX_TITLE),
    body: messages.clamp(messages.setupReason("CREDENTIAL_NOT_CONFIGURED", strings), messages.MAX_BODY),
    dedupeKey: CREDENTIALS_KEY,
  });
}

async function announceAccounts() {
  const list = runtime?.accounts ?? [];
  if (!list.length) {
    await postNoAccountNotice();
    return;
  }
  for (const account of list) {
    // An account with its own server has nothing to pick: it is connected by the
    // endpoint in its credential instance, so the "choose a provider" row would
    // be asking for something that is already answered.
    if (!account.provider && !account.custom) await postProviderNotice(account);
  }
}

/** The `check-now` command: look at every connected account, then say what happened. */
async function onCommand() {
  if (!runtime) throw coded("PLUGIN_INVALID", "the plugin is not loaded");
  await refreshLocale();
  await readSettings();
  const status = await runtime.checkNow();
  await host.ui
    ?.showToast?.(messages.checkedToast(status, text()), "info")
    .catch?.(() => undefined);
}

/**
 * Panel → plugin.
 *
 * Every answer is a value, not a throw: the panel maps `code` to a sentence in
 * the user's language, and a rejected bridge call would only give it a string it
 * cannot translate. The bridge's own reserved channels are handled by the host;
 * these names are this plugin's own.
 */
async function onPanelInvoke(channel, payload) {
  if (!runtime) return { ok: false, code: "PLUGIN_NOT_LOADED", message: "the plugin is not loaded" };
  try {
    switch (String(channel)) {
      case "inbox.snapshot": {
        await refreshLocale();
        return { ok: true, snapshot: runtime.snapshot(locale) };
      }
      case "inbox.addAccount": {
        const result = await runtime.addAccount();
        await announceAccounts();
        return { ok: true, ...result };
      }
      case "inbox.removeAccount": {
        const result = await runtime.removeAccount(payload?.instanceId);
        await announceAccounts();
        return { ok: true, ...result };
      }
      case "inbox.check": {
        const result = await runtime.checkNow(payload?.instanceId ? String(payload.instanceId) : undefined);
        return { ok: true, ...result };
      }
      case "inbox.openMessage":
        return { ok: true, message: await runtime.openMessage(payload ?? {}) };
      case "inbox.setFlag":
        return { ok: true, ...(await runtime.setFlag(payload ?? {})) };
      case "inbox.openWebmail":
        return { ok: true, ...(await runtime.openWebmail(payload?.instanceId)) };
      case "inbox.openExternal":
        return { ok: true, ...(await runtime.openExternal(payload?.url)) };
      default:
        throw coded("UNSUPPORTED", `unknown panel channel: ${String(channel)}`);
    }
  } catch (error) {
    const code = String(error?.code ?? "FAILED");
    log("warn", `panel ${String(channel)} failed: ${code} ${error?.message ?? error}`);
    return { ok: false, code, message: messages.clamp(String(error?.message ?? code), messages.MAX_BODY) };
  }
}

async function onLoad() {
  host = globalThis.pi ?? null;
  if (!host) {
    // A load without the host API is a broken load, not an old app: fail it, so
    // the host records a failure instead of installing a plugin that never works.
    throw coded("PLUGIN_INVALID", "plugin host API is missing (globalThis.pi)");
  }
  await refreshLocale();
  await readSettings();

  const stored = await readRoot();
  root = stored ?? accountsFile.emptyRoot();

  const slots = await host.credentials.list();
  const slot = slots.find((entry) => entry.id === SLOT_ID) ?? null;
  const instances = Array.isArray(slot?.instances) ? slot.instances : [];
  if (!stored) await migrateLegacy(instances);

  runtime = createRuntime({
    host,
    root,
    log,
    locale: () => locale,
    text,
    settings: () => normalizeSettings(settingsCache),
    persist,
    postRow,
    postSetupNotice,
    clientId: { name: "Minih Agent Inbox Mail", vendor: "minih", version: PLUGIN_VERSION },
  });
  await runtime.load();
  await announceAccounts();

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
      event: "plugin:settingsChanged",
      handler: () => {
        void (async () => {
          await readSettings();
          for (const account of runtime?.accounts ?? []) account.watcher?.poke();
        })();
      },
    },
    {
      event: "credentials:changed",
      handler: () => {
        // The host owns the account list: an instance added in Settings or
        // through the panel is a mailbox to start watching, and a removed one is
        // a watcher to close and state to forget.
        void (async () => {
          try {
            await runtime?.refresh();
            await announceAccounts();
          } catch (error) {
            log("warn", `could not re-read the mailbox list: ${error?.message ?? error}`);
          }
        })();
      },
    },
  ];
  for (const { event, handler } of subscriptions) host.events.on(event, handler);
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
  await runtime?.unload().catch(() => undefined);
  runtime = null;
  await writing;
  postedRows.clear();
  host = null;
}

module.exports = { onLoad, onPanelInvoke, onUnload };
