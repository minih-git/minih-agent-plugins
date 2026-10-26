/**
 * What the Router panel needs to know, kept free of the plugin host so a plain
 * `node --test` run can check it.
 *
 * Three jobs: turn the address the user typed into a base URL, read an
 * `/api/auth/session` answer, and decide which page that identity belongs on.
 * Nothing here talks to the network and nothing here keeps the credential.
 */

/** Control-plane page paths, mirroring the Router's own `page_routes.json`. */
const ADMIN_ENTRY = "/";
const KEY_USAGE_ENTRY = "/key-usage";

/**
 * Normalize the configured control-plane address.
 *
 * A bare host gets `https://`, because the published gateways are TLS and a
 * user typing `router.example.com` means "the site", not a file path. Anything
 * that already names a scheme is kept as typed as long as it is http(s), so a
 * local instance can stay on plain http. Query strings and fragments are
 * refused: they would silently drop every path this plugin appends.
 *
 * @param {unknown} raw value from `contributes.settings.baseUrl`
 * @returns {{ ok: true, baseUrl: string } | { ok: false, code: "empty" | "invalid-url", detail?: string }}
 */
function normalizeBaseUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, code: "empty" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, code: "invalid-url", detail: "not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "invalid-url", detail: url.protocol.replace(":", "") };
  }
  if (!url.hostname) return { ok: false, code: "invalid-url", detail: "no host" };
  if (url.search || url.hash) return { ok: false, code: "invalid-url", detail: "query" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${path}` };
}

/**
 * Read the `{ code, message, data }` envelope the Router answers every control
 * route with, and keep only what the panel draws.
 *
 * A 200 with an unreadable body is reported as such rather than as a network
 * failure: in practice it means the address points at something that is not a
 * Router (a proxy error page, another service on that port).
 *
 * @param {string} bodyText raw response body
 * @returns {{ ok: true, session: RouterSession } | { ok: false, code: "bad-response" | "not-authenticated" }}
 */
function parseSessionEnvelope(bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: "bad-response" };
  }
  const data = payload && typeof payload === "object" ? payload.data : null;
  if (!data || typeof data !== "object") return { ok: false, code: "bad-response" };
  // `authenticated` is the Router's own answer. A body without it is some other
  // service answering 200, not a session this panel can trust.
  if (data.authenticated !== true) return { ok: false, code: "not-authenticated" };
  const session = {
    principalType: data.principal_type === "admin" ? "admin" : "access_key",
    keyName: text(data.key_name),
    keyPrefix: text(data.key_prefix),
    keySuffix: text(data.key_suffix),
    status: text(data.status),
    rpmLimit: positive(data.rpm_limit),
    expiresAtMs: positive(data.expires_at_ms),
  };
  return { ok: true, session };
}

/**
 * The page this identity is allowed to open.
 *
 * The Router's own frontend already sends an access key to `/key-usage` and
 * refuses it every other page; asking for the admin root anyway would land on a
 * redirect the user has to watch. Admin tokens keep the console.
 *
 * @param {string} baseUrl normalized base URL
 * @param {"admin" | "access_key"} principalType
 * @returns {{ admin: boolean, url: string }}
 */
function consoleTarget(baseUrl, principalType) {
  const admin = principalType === "admin";
  return { admin, url: `${baseUrl}${admin ? ADMIN_ENTRY : KEY_USAGE_ENTRY}` };
}

/**
 * What the panel may show: no credential, no raw response.
 *
 * @param {RouterSession | null} session
 * @param {string} baseUrl
 * @returns {null | { admin: boolean, url: string, keyName: string, keyHint: string, status: string, rpmLimit: number | null, expiresAtMs: number | null }}
 */
function panelIdentity(session, baseUrl) {
  if (!session) return null;
  const target = consoleTarget(baseUrl, session.principalType);
  return {
    admin: target.admin,
    url: target.url,
    keyName: session.keyName,
    keyHint: keyHint(session.keyPrefix, session.keySuffix),
    status: session.status,
    rpmLimit: session.rpmLimit,
    expiresAtMs: session.expiresAtMs,
  };
}

/** `sk-abcd…wxyz` when the Router reports both ends, else whatever it gave. */
function keyHint(prefix, suffix) {
  if (prefix && suffix) return `${prefix}…${suffix}`;
  return prefix || suffix || "";
}

/**
 * One call's worth of panel state. The caller supplies the credential-bearing
 * request so this stays pure.
 *
 * @param {{ baseUrl: unknown, credential: unknown, openOnView: unknown, raw?: Record<string, unknown> }} settings
 * @param {(input: { url: string, headers: Record<string, string> }) => Promise<{ status: number, bodyText: string }>} request
 * @returns {Promise<PanelStatus>}
 */
async function readStatus(settings, request) {
  const raw = settings && typeof settings === "object" ? settings : {};
  const base = normalizeBaseUrl(raw.baseUrl);
  const credential = typeof raw.credential === "string" ? raw.credential.trim() : "";
  const openOnView = raw.openOnView === true;
  if (!base.ok) return { ok: false, code: base.code, detail: base.detail ?? "", configured: false, openOnView };
  if (!credential) return { ok: false, code: "no-credential", configured: false, baseUrl: base.baseUrl, openOnView };

  let response;
  try {
    response = await request({
      url: `${base.baseUrl}/api/auth/session`,
      headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
    });
  } catch (error) {
    return {
      ok: false,
      code: "network",
      detail: messageOf(error),
      configured: true,
      baseUrl: base.baseUrl,
      openOnView,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: "unauthorized", configured: true, baseUrl: base.baseUrl, openOnView };
  }
  if (response.status !== 200) {
    return {
      ok: false,
      code: "http-error",
      status: response.status,
      configured: true,
      baseUrl: base.baseUrl,
      openOnView,
    };
  }

  const parsed = parseSessionEnvelope(response.bodyText);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, configured: true, baseUrl: base.baseUrl, openOnView };
  }
  return {
    ok: true,
    configured: true,
    baseUrl: base.baseUrl,
    openOnView,
    identity: panelIdentity(parsed.session, base.baseUrl),
  };
}

/**
 * @typedef {{
 *   principalType: "admin" | "access_key",
 *   keyName: string,
 *   keyPrefix: string,
 *   keySuffix: string,
 *   status: string,
 *   rpmLimit: number | null,
 *   expiresAtMs: number | null,
 * }} RouterSession
 *
 * @typedef {{
 *   ok: boolean,
 *   configured: boolean,
 *   openOnView: boolean,
 *   code?: string,
 *   detail?: string,
 *   status?: number,
 *   baseUrl?: string,
 *   identity?: null | {
 *     admin: boolean,
 *     url: string,
 *     keyName: string,
 *     keyHint: string,
 *     status: string,
 *     rpmLimit: number | null,
 *     expiresAtMs: number | null,
 *   },
 * }} PanelStatus
 */

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** RPM limits and expiry timestamps are absent unless the Router stores them. */
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

module.exports = {
  normalizeBaseUrl,
  parseSessionEnvelope,
  consoleTarget,
  panelIdentity,
  readStatus,
  KEY_USAGE_ENTRY,
  ADMIN_ENTRY,
};