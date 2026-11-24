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

module.exports = {
  PROVIDERS,
  catalogue,
  domainOf,
  endpoints,
  findProvider,
  hosts,
  inferProviderId,
  providerFor,
};