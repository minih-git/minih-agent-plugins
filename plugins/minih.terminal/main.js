/**
 * Terminal plugin backend.
 *
 * This module runs in the plugin's own host process, beside the app rather than
 * inside it. It owns nothing but its terminals: no Agent tool, no extension, no
 * MCP server, and no prompt surface. The page reaches it only through the
 * sender-bound panel bridge (`window.pluginBridge.invoke`), which the host
 * forwards here as `onPanelInvoke`; the terminal data therefore never touches a
 * cross-plugin channel, and no local socket is opened for it.
 *
 * Nothing here persists or logs terminal input, output, environment values, or
 * shell history: the registry is memory-only and dies with the process.
 */
const { TerminalEngine, codedError } = require("./lib/terminal-engine.js");
const { openRequest, terminalDefaults } = require("./lib/settings.js");

const engine = new TerminalEngine();

/**
 * What a terminal starts with when the page names no directory or shell.
 *
 * The values come from `contributes.settings`, so the user configures "my
 * default terminal" once in the app's Plugins settings instead of answering the
 * same two questions on every new tab.
 * @type {{ profileId: string | null, directory: string | null, openOnView: boolean }}
 */
let defaults = terminalDefaults();

/** Channels the page may call. Anything else is refused, not forwarded. */
const CHANNELS = new Set([
  "terminal.catalog",
  "terminal.open",
  "terminal.read",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "terminal.closeAll",
  "terminal.pickDirectory",
]);

/**
 * Read the user's settings and keep them for the next terminal.
 *
 * A settings read that fails leaves the built-in defaults in place: the plugin
 * still runs terminals, it just cannot honour a preference this session.
 */
async function refreshDefaults() {
  try {
    const settings = await globalThis.pi.plugin.getSettings();
    defaults = terminalDefaults(settings);
  } catch {
    defaults = terminalDefaults();
  }
  return defaults;
}

async function onLoad() {
  // Warm the shell catalog so the first page render does not pay for detection.
  engine.profiles();
  await refreshDefaults();
  // The generated Plugins settings sheet writes through the host, which then
  // tells this process; without it a change would only apply after a reload.
  globalThis.pi.events?.on?.("plugin:settingsChanged", () => {
    void refreshDefaults();
  });
}

/**
 * Answer one page request.
 *
 * The host arms a 30s timeout per call, and `terminal.read` is a long poll of at
 * most a few seconds, so an idle terminal keeps one request in flight instead of
 * spinning.
 */
async function onPanelInvoke(channel, payload) {
  const name = String(channel ?? "");
  if (!CHANNELS.has(name)) {
    throw codedError("UNSUPPORTED", `unknown terminal channel: ${name}`);
  }
  switch (name) {
    case "terminal.catalog":
      // One read answers both the start form and the auto-open decision.
      return { ...engine.catalog(), defaults };
    case "terminal.open":
      // The page may name a directory and shell (the dialog), or nothing at all
      // (auto-open). `openRequest` fills in whatever the user configured.
      return engine.open(openRequest(payload, defaults));
    case "terminal.read":
      return engine.read(payload ?? {});
    case "terminal.write":
      return engine.write(payload ?? {});
    case "terminal.resize":
      return engine.resize(payload ?? {});
    case "terminal.close":
      return engine.close(payload ?? {});
    case "terminal.closeAll":
      return engine.closeAll();
    case "terminal.pickDirectory": {
      // The host owns the native picker; the plugin only asks for one and
      // receives a path the user chose. Cancelling changes nothing.
      const picked = await globalThis.pi.fs.requestDirectory();
      if (!picked?.path) return { canceled: true };
      return { path: picked.path, name: picked.name ?? null };
    }
    default:
      throw codedError("UNSUPPORTED", `unknown terminal channel: ${name}`);
  }
}

/**
 * Disabling, uninstalling, reloading, or upgrading the plugin ends every
 * terminal it owns. The host calls this before the process goes away, and the
 * process-exit path below is the second chance for a crash-free shutdown.
 */
async function onUnload() {
  const result = await engine.closeAll();
  if (result.failures.length > 0) {
    const detail = result.failures.map((failure) => `${failure.id}: ${failure.message}`).join("; ");
    throw codedError("CLOSE_FAILED", `some terminals may still be running — ${detail}`);
  }
}

/**
 * What the user would lose by ending this plugin now (spec 07-plugins/05 §3.0).
 *
 * Only running shells count: an exited terminal is history the user can already
 * see is finished. The sentence is written in the app language the plugin is
 * publishing, so the host's prompt needs no translation table for plugin copy.
 */
const INTERRUPTION_COPY = {
  en: {
    one: "Terminal: 1 shell is still running. Continuing ends it.",
    many: (count) => `Terminal: ${count} shells are still running. Continuing ends them.`,
  },
  "zh-CN": {
    one: "终端插件：仍有 1 个 shell 在运行，继续将结束它。",
    many: (count) => `终端插件：仍有 ${count} 个 shell 在运行，继续将结束它们。`,
  },
};

async function appLocale() {
  try {
    const appearance = await globalThis.pi.app.getAppearance();
    return String(appearance?.locale ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  } catch {
    return "en";
  }
}

async function onActiveWork() {
  const running = engine.list().filter((terminal) => !terminal.exited);
  if (running.length === 0) return null;
  const copy = INTERRUPTION_COPY[await appLocale()] ?? INTERRUPTION_COPY.en;
  return running.length === 1 ? copy.one : copy.many(running.length);
}

process.on("exit", () => {
  // Synchronous last resort: the process is already leaving, so an async close
  // cannot be awaited. Closing the PTY master hangs up the shell's session,
  // which is what stops the process tree when this process dies unexpectedly.
  engine.dispose();
});

module.exports = { onLoad, onPanelInvoke, onActiveWork, onUnload };
