"use strict";

/** Mail Assistant: mailbox polling, explicit panel actions and agent tools. */

const fs = require("node:fs/promises");
const path = require("node:path");

const accountsFile = require("./lib/accounts");
const { createAgentTools } = require("./lib/agent-tools");
const { createBodyCache, DIR_NAME: BODY_CACHE_DIR } = require("./lib/body-cache");
const messages = require("./lib/messages");
const providers = require("./lib/providers");
const { normalizeSettings } = require("./lib/settings");
const { createRuntime, SLOT_ID } = require("./lib/runtime");
const { version: PLUGIN_VERSION } = require("./package.json");

const STATE_FILE = accountsFile.FILE;
const LEGACY_FILE = accountsFile.LEGACY_FILE;
const COMMAND_ID = "check-now";

let host = null;
let locale = "en";
let settingsCache = normalizeSettings({});
/** The sheet as the host returned it, which is the only place a 0.1.0 provider survives. */
let rawSettings = {};
let root = accountsFile.emptyRoot();
let runtime = null;
/**
 * The bodies the user has opened, kept on this computer.
 *
 * It lives beside the state file (`body-cache/`) because it is the same kind of
 * thing: data this plugin owns in its own folder. See `lib/body-cache.js` for what
 * it keeps and for the two limits that bound it.
 */
let bodyCache = null;
let subscriptions = [];
/** The tools this plugin contributes to the agent, and their registration handle. */
let agentTools = null;
let writing = Promise.resolve();

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
      // Written beside the target and renamed over it: a reader never sees half
      // a JSON document, and a crash in the middle leaves the previous state —
      // with its UID cursor — intact instead of an empty file.
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(root, null, 2), "utf8");
      await fs.rename(temporary, file);
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
        return { ok: true, ...result };
      }
      case "inbox.removeAccount": {
        const result = await runtime.removeAccount(payload?.instanceId);
        return { ok: true, ...result };
      }
      case "inbox.check": {
        const result = await runtime.checkNow(payload?.instanceId ? String(payload.instanceId) : undefined);
        return { ok: true, ...result };
      }
      case "inbox.openMessage":
        return { ok: true, message: await runtime.openMessage(payload ?? {}) };
      case "inbox.markAllRead":
        return { ok: true, ...(await runtime.markAllRead(payload ?? {})) };
      case "inbox.setFlag":
        return { ok: true, ...(await runtime.setFlag(payload ?? {})) };
      // Since 0.4.0 the panel can also walk back through a mailbox, and it can
      // delete or archive the one message the user picked. All three are one
      // short session, and none of them is reachable from the poll path.
      case "inbox.loadOlder":
        return { ok: true, ...(await runtime.loadOlder(payload ?? {})) };
      case "inbox.delete":
        return { ok: true, ...(await runtime.deleteMessage(payload ?? {})) };
      case "inbox.archive":
        return { ok: true, ...(await runtime.archive(payload ?? {})) };
      // Since 0.5.0 the panel can also answer a message and save an attachment.
      // Both are one user click each: a reply is built from the body the panel
      // already opened, a save writes exactly one file to where the host's own
      // dialog points, and neither runs anywhere but under those clicks.
      case "inbox.draft":
        return { ok: true, draft: await runtime.draft(payload ?? {}) };
      case "inbox.send":
        return { ok: true, ...(await runtime.send(payload ?? {})) };
      case "inbox.saveAttachment":
        return { ok: true, ...(await runtime.saveAttachment(payload ?? {})) };
      case "inbox.openWebmail":
        return { ok: true, ...(await runtime.openWebmail(payload?.instanceId)) };
      case "inbox.openExternal":
        return { ok: true, ...(await runtime.openExternal(payload?.url)) };
      // What "open a message" keeps on this computer. The host builds the settings
      // page from the manifest and that page cannot hold a button, so emptying this
      // from the panel is the only way a user can reclaim the space.
      case "inbox.clearBodyCache": {
        if (!bodyCache) throw coded("PLUGIN_NOT_LOADED", "the plugin is not loaded");
        await bodyCache.clear();
        return { ok: true, ...bodyCache.stats() };
      }
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

  // The body cache is read at load, not on the first open: it is one small file,
  // and reading it here is what lets the panel show its size straight away.
  bodyCache = createBodyCache({ dir: await dataPath(BODY_CACHE_DIR), log });
  await bodyCache.load();

  runtime = createRuntime({
    host,
    root,
    bodyCache,
    log,
    locale: () => locale,
    text,
    settings: () => normalizeSettings(settingsCache),
    persist,
    clientId: { name: "Minih Agent Inbox Mail", vendor: "minih", version: PLUGIN_VERSION },
  });
  await runtime.load();
  // The agent can read this mailbox on the user's behalf: four tools, two of them
  // reads the host lets a scheduled run use without a card, two of them sends the
  // host asks about every time (`lib/agent-tools.js`).
  agentTools = createAgentTools({ host, runtime, log });
  // A refused registration must not cost the user their mailbox: an app that has
  // `pi.agent` but not the grant answers with a coded error, and the panel, the
  // watcher and the command all work without these tools.
  await agentTools.register().catch(async (error) => {
    log("warn", `could not register the agent tools: ${error?.code ?? ""} ${error?.message ?? error}`.trim());
    // A half-registered set is worse than none: withdraw whatever went through.
    await agentTools?.unregister().catch(() => undefined);
    agentTools = null;
  });

  if (typeof host.commands?.register === "function") {
    // The palette entry performs the same check as the panel's button.
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
  // Nothing to flush beyond what is already queued: waiting for it means a reload
  // (or a test that removes the data folder) cannot catch a write half way.
  await bodyCache?.flush().catch(() => undefined);
  bodyCache = null;
  await writing;
  await agentTools?.unregister().catch(() => undefined);
  agentTools = null;
  host = null;
}

module.exports = { onLoad, onPanelInvoke, onUnload };
