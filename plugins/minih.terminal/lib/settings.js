/**
 * Turn the user's plugin settings into what a new terminal starts with.
 *
 * Every field is best-effort. The settings file can be edited by hand, a shell
 * can be uninstalled after being chosen, and a directory can be moved or live on
 * another machine, so an unusable value falls back to the built-in behaviour
 * instead of stopping the view from opening a terminal at all. Validation that
 * needs the machine (does this shell exist? is this path a directory?) stays
 * with the engine, which reports it against the terminal the user asked for.
 */

/** Setting key -> the shape `contributes.settings` declares. */
const SETTING_KEYS = {
  defaultShell: "defaultShell",
  defaultDirectory: "defaultDirectory",
  openOnView: "openOnView",
};

/**
 * @param {Record<string, unknown>} settings values from `pi.plugin.getSettings()`
 * @returns {{ profileId: string | null, directory: string | null, openOnView: boolean }}
 *   `profileId: null` means "the first shell this machine offers"; `directory:
 *   null` means "the open project, then home".
 */
function terminalDefaults(settings = {}) {
  const values = settings && typeof settings === "object" ? settings : {};
  const shell = read(values[SETTING_KEYS.defaultShell]);
  const directory = read(values[SETTING_KEYS.defaultDirectory]);
  return {
    // Profile ids are lowercase by construction (`profileId` in shells.js
    // lowercases the program name), and `auto` is what a blank select produces,
    // so both are normalized here instead of failing a hand-edited file later
    // with "shell AUTO is not installed".
    profileId: normalizedShell(shell),
    directory: directory || null,
    // Only an explicit `false` turns auto-open off: a missing key (fresh install,
    // settings file written by an older version) keeps the shipped behaviour.
    openOnView: values[SETTING_KEYS.openOnView] !== false,
  };
}

/**
 * What to ask the engine for: the page's choice where it made one, the user's
 * settings everywhere else. `undefined` is what the engine reads as "pick the
 * default", so a blank field has to become undefined rather than `""`.
 */
function openRequest(input, defaults = terminalDefaults()) {
  const asked = input && typeof input === "object" ? input : {};
  return {
    cwd:
      typeof asked.cwd === "string" && asked.cwd.trim()
        ? asked.cwd
        : (defaults.directory ?? undefined),
    profileId: asked.profileId || defaults.profileId || undefined,
    cols: asked.cols,
    rows: asked.rows,
  };
}

function normalizedShell(shell) {
  const id = shell.toLowerCase();
  return id && id !== "auto" ? id : null;
}

function read(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SETTING_KEYS, openRequest, terminalDefaults };