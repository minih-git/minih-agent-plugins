"use strict";

/**
 * The mailboxes a user can pick, and nothing else.
 *
 * The user decided that a mailbox is chosen from a list instead of typed in, so
 * every entry here is a literal `host` / `port` pair that also appears in
 * `manifest.net.tcp` — the host refuses any other endpoint, and a user cannot
 * reach a server this file does not name.
 *
 * Each entry carries the official page its parameters came from, because the
 * ports are the part of this plugin most likely to rot: a provider that changes
 * one must be re-verified against its own documentation, not against a habit.
 *
 * `implicitTls` is always true. The host performs the IMAP login itself and only
 * over implicit TLS: it never writes `STARTTLS` and never upgrades a plain
 * socket, so an endpoint on port 143 with `tls: false` could never be used by
 * this plugin anyway.
 *
 * `auth` records what the provider accepts for a *password* login, which is the
 * only login the host can perform (`AUTHENTICATE PLAIN` or `LOGIN`; there is no
 * XOAUTH2). `oauth2` means the provider has retired basic authentication for
 * IMAP, so the plugin reports it as unavailable instead of handing the user a
 * slot that can never log in.
 *
 * Since 0.2.0 one plugin can hold several mailboxes, so the provider is no
 * longer a setting: each account records its own provider id, inferred from the
 * address's domain when that is unambiguous and picked by the user in the Inbox
 * panel otherwise (`inferProviderId`, `findProvider`).
 */

/**
 * A server the user typed is the other half of this file.
 *
 * Since 0.3.0 an account may carry its own endpoint — a company Exchange, an
 * IMAP server at a small host, a POP3-only mailbox — and that endpoint lives in
 * the credential instance, not here and not in a setting. This file only turns
 * the four non-secret fields the host publishes into a descriptor and a label;
 * the host is what validates them, and the host is what injects that instance's
 * password into that endpoint and no other. Nothing below widens the preset
 * allowlist: `PROVIDERS`, `endpoints()` and `hosts()` still describe the
 * servers a reviewer can check, and a custom endpoint reaches none of them.
 */

const PROVIDERS = [
  {
    id: "qq",
    label: "QQ Mail",
    title: { en: "QQ Mail", "zh-CN": "QQ 邮箱" },
    host: "imap.qq.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    webmail: "https://mail.qq.com/",
    // "POP/IMAP和Exchange服务的设置方法": IMAP imap.qq.com, port 993, SSL,
    // login with the 16-digit authorization code.
    source: "https://help.mail.qq.com/detail/108/1090/",
  },
  {
    id: "netease163",
    label: "NetEase 163",
    title: { en: "NetEase 163", "zh-CN": "网易 163 邮箱" },
    host: "imap.163.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    webmail: "https://mail.163.com/",
    // "网易邮箱服务器参数如何设置？": IMAP imap.163.com, SSL port 993.
    source:
      "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63",
  },
  {
    id: "netease126",
    label: "NetEase 126",
    title: { en: "NetEase 126", "zh-CN": "网易 126 邮箱" },
    host: "imap.126.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    webmail: "https://mail.126.com/",
    // Same table as 163: the 126 column names imap.126.com on SSL port 993.
    source:
      "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63",
  },
  {
    id: "gmail",
    label: "Gmail",
    title: { en: "Gmail", "zh-CN": "Gmail" },
    host: "imap.gmail.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    webmail: "https://mail.google.com/",
    // Gmail's IMAP/SMTP reference: IMAP imap.gmail.com, port 993, implicit SSL.
    source: "https://developers.google.com/gmail/imap/imap-smtp",
  },
  {
    id: "tencentExmail",
    label: "Tencent Exmail",
    title: { en: "Tencent Exmail", "zh-CN": "腾讯企业邮" },
    host: "imap.exmail.qq.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    webmail: "https://exmail.qq.com/",
    // "常用邮件客户端软件POP/IMAP/EXCHANGE协议设置": imap.exmail.qq.com, SSL,
    // port 993.
    source: "https://open.work.weixin.qq.com/help2/pc/19886",
  },
  {
    id: "outlook",
    label: "Outlook / Hotmail",
    title: { en: "Outlook / Hotmail (needs OAuth2, unavailable)", "zh-CN": "Outlook / Hotmail（需 OAuth2，暂不支持）" },
    host: "outlook.office365.com",
    port: 993,
    implicitTls: true,
    auth: "oauth2",
    webmail: "https://outlook.live.com/",
    // Microsoft's POP/IMAP settings page: IMAP server outlook.office365.com,
    // port 993, SSL/TLS, authentication method "OAuth2/Modern Auth".
    source:
      "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
  },
];

/** The id the panel shows for an account whose server the user typed. */
const CUSTOM_PROVIDER_ID = "custom";
/**
 * The credential field the account form fills in.
 *
 * The provider is chosen when the account is created, not afterwards: the host
 * requires every declared field to be non-empty, so it is a required dropdown in
 * its own form, and the plugin only reads the value back through `publicFields`.
 * `custom` is a value of that field, not a provider entry — it means "the server
 * is in this same instance", which is the account the user typed.
 */
const PROVIDER_FIELD = "provider";
/** The provider entries the dropdown offers, in the order the panel shows them. */
const PROVIDER_OPTIONS = [
  { value: "qq" },
  { value: "netease163" },
  { value: "netease126" },
  { value: "gmail" },
  { value: "tencentExmail" },
  // Outlook is deliberately absent: it needs OAuth2 for IMAP, which the host
  // cannot do, and offering it would hand the user a slot that never logs in.
  { value: CUSTOM_PROVIDER_ID },
];
/** The protocols the credential slot's `userEndpoint` admits. */
const USER_PROTOCOLS = ["imap", "pop3"];
/** The transports the host can perform a login over; plaintext is not one. */
const USER_SECURITY = ["tls", "starttls"];
/**
 * The ports the host's dialog defaults to, per protocol and transport.
 *
 * Kept here so the plugin can describe a custom account the way the form
 * describes it. The value that is used is always the one stored in the
 * instance, never this table: a server on 143 with STARTTLS is the user's
 * decision, not something this file may round to 993.
 */
const DEFAULT_PORTS = {
  "imap/tls": 993,
  "imap/starttls": 143,
  "pop3/tls": 995,
  "pop3/starttls": 110,
};

/** A bare hostname or an IP literal: no scheme, port, path, space or wildcard. */
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const IPV6 = /^\[?[0-9a-f:.]+\]?$/;

function plausibleHost(value) {
  if (!value || value.length > 253) return false;
  if (/\s/.test(value)) return false;
  return HOSTNAME.test(value) || IPV6.test(value);
}

/**
 * The domain-to-provider table used when an account is first seen.
 *
 * Only domains that belong to exactly one provider are listed: a custom company
 * domain tells nothing about its mail service, and guessing there would point
 * the plugin at a server that refuses the login and looks like a wrong password.
 */
const DOMAIN_PROVIDERS = new Map([
  ["qq.com", "qq"],
  ["foxmail.com", "qq"],
  ["vip.qq.com", "qq"],
  ["163.com", "netease163"],
  ["126.com", "netease126"],
  ["gmail.com", "gmail"],
  ["googlemail.com", "gmail"],
]);

function findProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** The provider a stored id names, or `null` when it names none. */
function providerFor(id) {
  return findProvider(id);
}

/** Every provider the panel offers, in a stable order, with its localized name. */
function catalogue(locale) {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    title: provider.title[locale] ?? provider.title.en,
    available: provider.auth === "password",
    webmail: provider.webmail,
  }));
}

/** The mailbox domain of an address, lower-cased, or `""`. */
function domainOf(address) {
  const text = String(address ?? "").trim().toLowerCase();
  const at = text.lastIndexOf("@");
  return at > 0 ? text.slice(at + 1) : "";
}

/**
 * The provider an email address's domain belongs to, or `null`.
 *
 * A null result is not a failure: it is a custom domain, and the panel asks the
 * user to pick one before the account is connected.
 */
function inferProviderId(address) {
  const domain = domainOf(address);
  if (!domain) return null;
  const id = DOMAIN_PROVIDERS.get(domain) ?? null;
  return id && findProvider(id) ? id : null;
}

/** One `manifest.net.tcp` entry per provider, deduplicated by `host:port`. */
function endpoints() {
  const seen = new Set();
  const list = [];
  for (const provider of PROVIDERS) {
    const key = `${provider.host}:${provider.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ host: provider.host, port: provider.port, tls: provider.implicitTls });
  }
  return list;
}

/** Every host a credential slot must be allowed to be injected into. */
function hosts() {
  return [...new Set(PROVIDERS.map((provider) => provider.host))];
}

/**
 * Which service one account belongs to, in the order the addendum fixed.
 *
 *   1. an endpoint in the instance (`server` set)      → custom, whatever else says
 *   2. the `provider` field chosen in the account form → that provider
 *   3. `provider: custom` without a server             → the account needs a server
 *   4. the provider a 0.2.0 panel stored               → that provider
 *   5. the address's domain                            → that provider, else nothing
 *
 * Steps 3–5 are what keep a 0.2.0 account usable: it was created before the field
 * existed, so it has neither a `provider` value nor an endpoint, and its old
 * choice lives in the plugin's own file.
 */
function resolveAccount({ endpoint = null, fieldProvider = "", storedProvider = "", email = "" } = {}) {
  if (endpoint) return { custom: endpoint, provider: null, missingServer: false };
  const field = String(fieldProvider ?? "").trim();
  if (field === CUSTOM_PROVIDER_ID) return { custom: null, provider: null, missingServer: true };
  // Only a value the dropdown actually offers counts: the host refuses anything
  // else on save, and a hand-edited file must not become a provider choice.
  const offered = PROVIDER_OPTIONS.some((option) => option.value === field);
  const chosen = offered ? findProvider(field) : null;
  if (chosen) return { custom: null, provider: chosen, missingServer: false };
  const stored = findProvider(String(storedProvider ?? "").trim());
  if (stored) return { custom: null, provider: stored, missingServer: false };
  const inferredId = inferProviderId(email);
  const inferred = inferredId ? findProvider(inferredId) : null;
  return { custom: null, provider: inferred, missingServer: false };
}

/**
 * The endpoint an instance carries because the user filled one in, or `null`.
 *
 * All four fields are published by the host in `publicFields` (the password is
 * the only secret), and the host validates them when the form is saved: a bare
 * hostname or IP literal, a port in 1..65535, one of the declared protocols and
 * one of the two transports. Empty `server` is the preset path and the normal
 * case, so anything unusable is treated as "no custom server" — the plugin
 * never invents an endpoint, and a half-filled instance is a host bug rather
 * than a reason to guess.
 */
function customEndpointOf(publicFields) {
  const fields = publicFields && typeof publicFields === "object" && !Array.isArray(publicFields)
    ? publicFields
    : {};
  const host = String(fields.server ?? "").trim().toLowerCase();
  if (!host) return null;
  if (!plausibleHost(host)) return null;
  const protocol = String(fields.protocol ?? "").trim().toLowerCase();
  if (!USER_PROTOCOLS.includes(protocol)) return null;
  const security = String(fields.security ?? "").trim().toLowerCase();
  if (!USER_SECURITY.includes(security)) return null;
  const port = Number(String(fields.port ?? "").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { id: CUSTOM_PROVIDER_ID, host, port, protocol, security };
}

/**
 * The proxy an account reaches its server through, or `null`.
 *
 * The host performs the proxy handshake, so this file only reads the three
 * non-secret fields it publishes (`proxyType`, `proxyHost`, `proxyPort`) to label
 * the account and to say *which* proxy failed. The username and password stay in
 * the host's credential store and are never published: nothing here may depend on
 * them, and there is no field for them to leak through.
 */
function proxyOf(publicFields) {
  const fields = publicFields && typeof publicFields === "object" && !Array.isArray(publicFields)
    ? publicFields
    : {};
  const type = String(fields.proxyType ?? "").trim().toLowerCase();
  if (!type) return null;
  if (type !== "http" && type !== "socks5") return null;
  const host = String(fields.proxyHost ?? "").trim().toLowerCase();
  if (!plausibleHost(host)) return null;
  const port = Number(String(fields.proxyPort ?? "").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { type, host, port };
}

/** `http://127.0.0.1:7897` — one label for the panel, the notices and the logs. */
function proxyLabel(proxy) {
  if (!proxy) return "";
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}

/** What changes when the user edits the account: protocol, transport, host, port. */
function endpointKey(endpoint) {
  if (!endpoint) return "";
  return `${endpoint.protocol}/${endpoint.security}://${endpoint.host}:${endpoint.port}`;
}

/**
 * The one line a custom account is labelled with in the panel.
 *
 * `Custom server mail.example.com:993 · IMAP · SSL`: the host, the port and the
 * two facts a user needs to compare against what their administrator told them.
 */
function customTitle(endpoint, locale) {
  const zh = String(locale ?? "").startsWith("zh");
  const protocol = endpoint.protocol === "pop3" ? "POP3" : "IMAP";
  const security = endpoint.security === "starttls" ? "STARTTLS" : "SSL";
  return `${zh ? "自定义服务器" : "Custom server"} ${endpoint.host}:${endpoint.port} · ${protocol} · ${security}`;
}

module.exports = {
  CUSTOM_PROVIDER_ID,
  DEFAULT_PORTS,
  PROVIDER_FIELD,
  PROVIDER_OPTIONS,
  PROVIDERS,
  USER_PROTOCOLS,
  USER_SECURITY,
  catalogue,
  customEndpointOf,
  customTitle,
  domainOf,
  endpointKey,
  endpoints,
  findProvider,
  hosts,
  inferProviderId,
  providerFor,
  proxyLabel,
  proxyOf,
  resolveAccount,
};