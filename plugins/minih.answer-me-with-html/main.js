"use strict";

/**
 * Answer me with HTML — Minih-Agent-Desktop plugin entry (plugin process).
 *
 * What this plugin adds:
 *   - the `answer-me-with-html` skill (instructions the Agent loads on demand)
 *     together with the bundled `am` CLI it drives over Bash;
 *   - a panel that shows the pages the CLI produced, and can open, copy,
 *     delete and clean them;
 *   - two commands and one setting.
 *
 * Why this file uses `node:fs` directly instead of `pi.fs.*`:
 *   the pages live in the CLI's own folders, which are outside the workspace.
 *   The host file gateway is rooted in the workspace (or in a directory the user
 *   picks per session), so it cannot address them at all; the plugin's own Node
 *   process is the only place with reach. The same boundary is documented for
 *   the bundled file view (docs/spec/07-plugins/04-plugin-security.md): the
 *   brokered gate does not constrain direct Node access inside a plugin
 *   process. This plugin therefore keeps its own rules:
 *
 *   1. Two folders, both the CLI's own: `<home>/pages` and, when it exists and
 *      is private to this user, the CLI's fallback `<tmpdir>/answer-me-with-html-<uid>/pages`.
 *      They are the two places `am render` writes to and the two `am clean`
 *      walks, so the panel shows what the CLI reports. A page written anywhere
 *      else on purpose (`am render -o <file>`) is not listed here.
 *   2. One name shape: a plain `.html` file name directly inside `pages/`.
 *      Separators, `..`, absolute paths and other extensions are refused, and
 *      the real path of a file must still sit directly in the real `pages/`
 *      directory before it is touched.
 *   3. One delete: a single regular file. A symlink, a directory and a
 *      vanished file are refused; `pages/` itself is never removed.
 *   4. Cleaning old pages is not re-implemented: the panel runs the CLI's own
 *      `am clean`, so the plugin and the CLI agree on what "old" means.
 *
 * The panel talks to this file over `window.pluginBridge.invoke("am.*")`,
 * which the host forwards to `onPanelInvoke` below.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const pages = require("./lib/pages");

const SKILL_DIR = path.join(__dirname, "skills", "answer-me-with-html");
const AM_SCRIPT = path.join(SKILL_DIR, "scripts", "am.mjs");

const COMMAND_OPEN = "answer-me-with-html.open";
const COMMAND_REVEAL = "answer-me-with-html.revealPages";

const DEFAULT_CLEANUP_DAYS = 30;
/** `am clean` walks three directories; a stuck child must not hold the panel. */
const CLEAN_TIMEOUT_MS = 20000;
const VERSION_TIMEOUT_MS = 10000;

/** Cached `am --version` output; the CLI is bundled, so this never changes. */
let cachedVersion = null;

async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return {};
  }
}

function cleanupDays(settings) {
  const value = Number(settings?.cleanupDays);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CLEANUP_DAYS;
  return Math.floor(value);
}

/**
 * Run the bundled CLI. Arguments are passed as an array and the spawn never
 * goes through a shell, so nothing a caller sends can become a command.
 */
function runAm(args, { timeoutMs = CLEAN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AM_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`am ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `am exited with code ${code}`).trim()));
    });
  });
}

async function amVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const { stdout } = await runAm(["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    cachedVersion = stdout.trim().split("\n").pop()?.trim() || "unknown";
  } catch (error) {
    cachedVersion = `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
  return cachedVersion;
}

/**
 * Hand a path to the operating system. The child is detached and unref'd so the
 * opened browser window outlives the panel, and the executable is fixed here:
 * only `openPage` / `reveal` reach this function, both with a path this plugin
 * resolved itself.
 */
function openWithOs(target) {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [target] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", target] }
        : { file: "xdg-open", args: [target] };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Set once the host refuses the browser API in this plugin process: a plugin
 * that was never granted `browser.cdp` must not ask again on every click, or
 * each "open" writes one PERMISSION_DENIED audit line for a call that could
 * never succeed. A refusal of the other kind (`UNAVAILABLE`: panel closed, no
 * active session) is deliberately *not* remembered — opening the Browser panel
 * makes the next click work.
 */
let inAppBrowserRefused = false;

/**
 * Try to show a page in the app's own browser panel, before falling back to the
 * operating system. Which one is possible is decided by the host, not here.
 *
 * The host's browser surface refuses work unless its view is the visible
 * work-panel tab, and it keys that view by session — a page card runs from a
 * renderer call, which carries no session. So this attempt succeeds only when
 * the user already has the Browser panel open; every refusal (not visible, no
 * active session, plugin disabled, permission not granted) becomes the caller's
 * signal to hand the file to the operating system instead.
 */
async function openInAppBrowser(full) {
  if (inAppBrowserRefused) throw Object.assign(new Error("the browser API refused this plugin earlier"), { code: "PERMISSION_DENIED" });
  if (typeof pi.browser?.navigate !== "function") throw Object.assign(new Error("browser API unavailable"), { code: "NO_API" });
  try {
    const state = await pi.browser.navigate({ path: full });
    // A null answer is the host's "another session owns this view": it records
    // the target for later instead of loading it here.
    if (!state) throw Object.assign(new Error("the browser panel belongs to another session"), { code: "OTHER_SESSION" });
    const error = state.loadError;
    if (error) {
      const message = typeof error === "string" ? error : error.message || "browser load failed";
      throw Object.assign(new Error(message), { code: "LOAD_FAILED" });
    }
    return state;
  } catch (error) {
    if (error?.code === "PERMISSION_DENIED") inAppBrowserRefused = true;
    throw error;
  }
}

/** Real path of a `pages/` folder, or null when it does not exist yet. */
function realDirOf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * Resolve the path a page card names: one existing `.html` file, given as an
 * absolute path by the reply. The card is the only channel that takes a path
 * from the conversation rather than from this plugin's own listing, so it is
 * deliberately strict: absolute, a plain `.html` name, a regular file (never a
 * symlink or a folder), and the folder it really sits in is reported so the
 * reader sees whether the page is in the library, the CLI's temporary fallback,
 * or somewhere else the Agent was asked to write.
 */
function resolveCardPage(raw) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("the card needs a page path");
  if (!path.isAbsolute(value)) throw new Error("the card needs an absolute path");
  if (!pages.isPageName(path.basename(value))) throw new Error("only a .html page can be shown");
  let stat;
  try {
    stat = fs.lstatSync(value);
  } catch {
    throw new Error(`page not found: ${value}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`not a regular page file: ${value}`);
  const full = fs.realpathSync(value);
  const folder = path.dirname(full);
  const roots = pages.dataRoots(pages.amHome());
  const known = roots.find((root) => realDirOf(root.pagesDir) === folder);
  return { full, stat, folder: known ? known.id : "other" };
}

/**
 * The card's channels. `pageInfo` answers with a value instead of throwing so
 * the card can show a readable line; the two actions throw, because the reader
 * pressed a button and needs to know when nothing happened.
 */
async function onRendererCall(method, args) {
  if (method === "pageInfo") {
    try {
      const { full, stat, folder } = resolveCardPage(args?.path);
      return {
        ok: true,
        path: full,
        name: path.basename(full),
        title: pages.readTitle(full, path.basename(full)),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        folder,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (method === "openPage") {
    const { full } = resolveCardPage(args?.path);
    return showPage(full);
  }
  if (method === "copyPath") {
    const { full } = resolveCardPage(args?.path);
    await pi.clipboard.writeText(full);
    return { ok: true, path: full };
  }
  throw Object.assign(new Error(`unsupported renderer method: ${method}`), { code: "UNSUPPORTED" });
}

/**
 * Show one page and say where it went: the app's own browser panel when the host
 * allows it, otherwise the operating system's default application. A refusal from
 * the app is not an error the reader should see — it is the reason the fallback
 * exists — so the answer always names the surface that worked.
 */
async function showPage(full) {
  try {
    await openInAppBrowser(full);
    return { ok: true, path: full, where: "app" };
  } catch (error) {
    await openWithOs(full);
    // Say which surface took the page and, when the app refused, the reason the
    // host gave. The card turns `code` into one short sentence; it never guesses
    // a cause it did not observe.
    return {
      ok: true,
      path: full,
      where: "system",
      code: error?.code ?? "UNKNOWN",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Resolve one page to a real file inside one of the CLI's own folders, or
 * explain why it cannot be used. `rootId` names a folder this plugin knows
 * (`home` or the CLI's `temp` fallback); the file must still be a regular file
 * sitting directly in that folder's `pages/` after symlinks are resolved.
 */
function resolveExistingPage(home, rootId, name) {
  const root = pages.rootById(home, rootId);
  if (!root) throw new Error(`unknown page folder: ${String(rootId ?? "")}`);
  const full = pages.pagePath(root.dir, name);
  if (!full) throw new Error(`"${String(name ?? "")}" is not a page file name`);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw new Error(`page not found: ${name}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`not a regular page file: ${name}`);
  const realDir = fs.realpathSync(root.pagesDir);
  const realFull = fs.realpathSync(full);
  if (path.dirname(realFull) !== realDir) throw new Error(`page resolves outside the pages folder: ${name}`);
  return { full: realFull, root };
}

async function appLocale() {
  try {
    return String((await pi.app.getLocale()) ?? "");
  } catch {
    return "";
  }
}

async function state() {
  const home = pages.amHome();
  const settings = await loadSettings();
  const listed = pages.listPages(home);
  const used = pages.usage(home);
  return {
    version: await amVersion(),
    locale: await appLocale(),
    home,
    pagesDir: pages.pagesDir(home),
    cleanupDays: cleanupDays(settings),
    pages: { total: listed.total, bytes: listed.bytes, truncated: listed.truncated },
    usage: used,
  };
}

async function listPages() {
  const home = pages.amHome();
  const listed = pages.listPages(home);
  return {
    home,
    pagesDir: pages.pagesDir(home),
    roots: listed.roots,
    pages: listed.pages,
    total: listed.total,
    bytes: listed.bytes,
    truncated: listed.truncated,
  };
}

async function openPage(payload) {
  const home = pages.amHome();
  const { full } = resolveExistingPage(home, payload?.root, payload?.name);
  return showPage(full);
}

async function revealPagesFolder() {
  const home = pages.amHome();
  const dir = pages.pagesDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await openWithOs(dir);
  return { ok: true, path: dir };
}

async function copyPath(payload) {
  const home = pages.amHome();
  const { full } = resolveExistingPage(home, payload?.root, payload?.name);
  await pi.clipboard.writeText(full);
  return { ok: true, path: full };
}

async function deletePage(payload) {
  const home = pages.amHome();
  const { full } = resolveExistingPage(home, payload?.root, payload?.name);
  await fsp.rm(full, { force: false });
  await pi.ui.showToast(`Deleted ${payload?.name}`);
  return { ...(await listPages()), deleted: payload?.name };
}

/** Cleaning is the CLI's job: `am clean` owns the age rule and the cache. */
async function clean(payload) {
  const settings = await loadSettings();
  const days = cleanupDays(settings);
  const args = payload?.all ? ["clean", "--all"] : ["clean", "--days", String(days)];
  const { stdout } = await runAm(args);
  const summary = stdout.trim().split("\n").filter(Boolean).pop() || "cleaned";
  await pi.ui.showToast(summary);
  return { ...(await listPages()), summary, output: stdout.trim() };
}

async function onLoad() {
  await pi.commands.register({
    id: COMMAND_OPEN,
    title: "Answer me with HTML: Open panel",
    keywords: ["answer me with html", "am", "page", "html", "页面", "图解"],
    run: async () => {
      await pi.ui.openPanel({ title: "Answer me with HTML" });
    },
  });
  await pi.commands.register({
    id: COMMAND_REVEAL,
    title: "Answer me with HTML: Open pages folder",
    keywords: ["answer me with html", "pages folder", "页面目录", "清理"],
    run: async () => {
      const result = await revealPagesFolder();
      await pi.ui.showToast(`Opened ${result.path}`);
    },
  });
}

async function onUnload() {
  await pi.commands.unregister(COMMAND_OPEN);
  await pi.commands.unregister(COMMAND_REVEAL);
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "am.state":
      return state();
    case "am.pages":
      return listPages();
    case "am.openPage":
      return openPage(payload);
    case "am.reveal":
      return revealPagesFolder();
    case "am.copyPath":
      return copyPath(payload);
    case "am.deletePage":
      return deletePage(payload);
    case "am.clean":
      return clean(payload);
    default:
      throw Object.assign(new Error(`unsupported panel channel: ${channel}`), { code: "UNSUPPORTED" });
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke, onRendererCall };
