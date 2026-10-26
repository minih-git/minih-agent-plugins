/**
 * Router panel backend.
 *
 * The page cannot reach the Router itself (its CSP allows no outbound request
 * and the host's panel session is confined to `net.domains`), so every call
 * goes through this module: it reads the two settings, asks the control plane
 * who the credential belongs to, and hands the page a summary with no
 * credential in it.
 *
 * The panel never writes to the Router. The only outbound page it can open is
 * the one the Router's own answer allows, built from the stored base URL and a
 * fixed path, so a compromised page cannot turn this into an open-redirect.
 */
const { readStatus } = require("./lib/console-state.js");

/** Channels the page may call. Anything else is refused, not forwarded. */
const CHANNELS = new Set(["router.status", "router.open"]);

/**
 * A reopened panel within this window reuses the last answer instead of asking
 * again. The panel's Refresh passes `force`, so a user watching an expiry or a
 * rotated key is never held back by the cache.
 */
const CACHE_MS = 30_000;

/** @type {{ at: number, payload: object } | null} */
let cached = null;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** The credential-bearing request, routed through the host so `net.anyHost` applies. */
function hostFetch(input) {
  return globalThis.pi.net.fetch({
    url: input.url,
    method: "GET",
    headers: input.headers,
    timeoutMs: 8_000,
    redirect: "error",
  });
}

async function currentSettings() {
  try {
    return await globalThis.pi.plugin.getSettings();
  } catch {
    // A settings read that fails is not "no settings": the panel says it cannot
    // tell, instead of claiming the user never configured anything.
    throw codedError("SETTINGS_UNAVAILABLE", "plugin settings are unavailable");
  }
}

/**
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>} the panel state described in lib/console-state.js
 */
async function status(options = {}) {
  if (!options.force && cached && Date.now() - cached.at < CACHE_MS) return cached.payload;
  const payload = await readStatus(await currentSettings(), hostFetch);
  cached = { at: Date.now(), payload };
  return payload;
}

/**
 * Open the page the Router's answer allows, in the user's browser.
 *
 * The plugin host cannot hand this page to the in-app Browser view: that view
 * belongs to `pi.browser`, and a panel call has no session to reveal it in. The
 * default browser is the honest target instead of a panel that looks embedded
 * but is not.
 */
async function openConsole() {
  const current = await status({ force: true });
  if (!current.ok || !current.identity) {
    throw codedError("NOT_READY", `the Router session is not available: ${current.code ?? "unknown"}`);
  }
  const url = current.identity.url;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw codedError("INVALID_URL", "only http(s) pages can be opened");
  }
  await globalThis.pi.shell.openExternal(url);
  return { url, admin: current.identity.admin };
}

async function onPanelInvoke(channel, payload) {
  const name = String(channel ?? "");
  if (!CHANNELS.has(name)) {
    throw codedError("UNSUPPORTED", `unknown router channel: ${name}`);
  }
  switch (name) {
    case "router.status":
      return status({ force: payload?.force === true });
    case "router.open":
      return openConsole();
    default:
      throw codedError("UNSUPPORTED", `unknown router channel: ${name}`);
  }
}

async function onLoad() {
  // A changed address or credential must not be answered from the old cache.
  globalThis.pi.events?.on?.("plugin:settingsChanged", () => {
    cached = null;
  });
}

module.exports = { onLoad, onPanelInvoke };
