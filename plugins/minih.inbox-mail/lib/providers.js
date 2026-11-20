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
 */

const PROVIDERS = [
  {
    id: "qq",
    label: "QQ Mail",
    host: "imap.qq.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    // "POP/IMAP和Exchange服务的设置方法": IMAP imap.qq.com, port 993, SSL,
    // login with the 16-digit authorization code.
    source: "https://help.mail.qq.com/detail/108/1090/",
  },
  {
    id: "netease163",
    label: "NetEase 163",
    host: "imap.163.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    // "网易邮箱服务器参数如何设置？": IMAP imap.163.com, SSL port 993.
    source:
      "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63",
  },
  {
    id: "netease126",
    label: "NetEase 126",
    host: "imap.126.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    // Same table as 163: the 126 column names imap.126.com on SSL port 993.
    source:
      "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63",
  },
  {
    id: "gmail",
    label: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    // Gmail's IMAP/SMTP reference: IMAP imap.gmail.com, port 993, implicit SSL.
    source: "https://developers.google.com/gmail/imap/imap-smtp",
  },
  {
    id: "tencentExmail",
    label: "Tencent Exmail",
    host: "imap.exmail.qq.com",
    port: 993,
    implicitTls: true,
    auth: "password",
    // "常用邮件客户端软件POP/IMAP/EXCHANGE协议设置": imap.exmail.qq.com, SSL,
    // port 993.
    source: "https://open.work.weixin.qq.com/help2/pc/19886",
  },
  {
    id: "outlook",
    label: "Outlook / Hotmail",
    host: "outlook.office365.com",
    port: 993,
    implicitTls: true,
    auth: "oauth2",
    // Microsoft's POP/IMAP settings page: IMAP server outlook.office365.com,
    // port 993, SSL/TLS, authentication method "OAuth2/Modern Auth".
    source:
      "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
  },
];

/** The default provider, and the one an empty or unknown setting falls back to. */
const DEFAULT_PROVIDER_ID = "qq";

function findProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * Resolve the setting to a provider record.
 *
 * An unknown id falls back to the default rather than to nothing: the setting is
 * a dropdown, so an unknown value means an older or newer sheet, not a user
 * trying to name a server of their own.
 */
function providerFor(id) {
  return findProvider(id) ?? findProvider(DEFAULT_PROVIDER_ID);
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
  DEFAULT_PROVIDER_ID,
  endpoints,
  findProvider,
  hosts,
  providerFor,
};