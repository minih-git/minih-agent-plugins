"use strict";

/**
 * Everything the plugin says, and how long it may be.
 *
 * The notification centre has hard limits (200 code points of title, 2,000 of
 * body) and the plugin has two rules of its own: a row names the account it came
 * from, and a row carries the sender, the subject and the time, never the body of
 * the mail. Both live here so the formatting can be tested without a host, and so
 * no other file has to remember either rule.
 */

/** Title and body ceilings the host enforces. */
const MAX_TITLE = 200;
const MAX_BODY = 2000;
/** Senders listed in one digest before it says "and N more". */
const DIGEST_LINES = 8;

const TEXT = {
  en: {
    commandTitle: "Check the mailboxes now",
    checkedWithMail: (count, accounts) =>
      `Checked ${accounts === 1 ? "1 mailbox" : `${accounts} mailboxes`}: ${count} new message${count === 1 ? "" : "s"}`,
    checkedEmpty: (accounts) =>
      `Checked ${accounts === 1 ? "1 mailbox" : `${accounts} mailboxes`}: no new mail`,
    checking: "Checking the mailboxes…",
    notConnected: "The mailboxes are not connected yet; they will be checked shortly",
    noSubject: "(no subject)",
    digestTitle: (count) => `${count} new message${count === 1 ? "" : "s"}`,
    digestMore: (count) => `and ${count} more`,
    unknownSender: "unknown sender",
    needsSetup: "Mailbox not connected",
    needsProvider: "Choose a mail provider",
    needsProviderBody: (label) =>
      `${label || "This account"} has no mail service yet, so it is not connected. Open Settings → Plugins → Inbox mail and edit the account: pick your provider there, or “Custom server” and fill in its address.`,
    reasons: {
      missing:
        "The plugin has no mailbox credential yet. Add one from the Inbox panel in the sidebar, or in Settings.",
      rejected:
        "The mailbox refused the sign-in. Check the provider for this account in the Inbox panel and generate a new authorization code.",
      oauth2:
        "This provider now requires OAuth2 for IMAP, and the app cannot do that yet. Pick another provider for this account.",
      starttls:
        "This mail server does not offer STARTTLS, and the app does not sign in without encryption. In the account settings choose SSL for this mailbox and use the encrypted port your administrator gave you (993 for IMAP, 995 for POP3).",
      tls:
        "The encrypted connection to this mail server could not be established: its certificate did not verify, or that port is not the encrypted one. Check the server, the port and the encryption in the account settings.",
      unsupported:
        "This app version does not have the host capabilities this plugin needs (Desktop 1.10.0 or newer).",
      other:
        "The mailbox could not be reached. The next attempt is automatic.",
    },
  },
  "zh-CN": {
    commandTitle: "立即检查邮箱",
    checkedWithMail: (count, accounts) => `已检查 ${accounts} 个账号：新邮件 ${count} 封`,
    checkedEmpty: (accounts) => `已检查 ${accounts} 个账号：没有新邮件`,
    checking: "正在检查邮箱…",
    notConnected: "邮箱还没连上，稍后会自动检查",
    noSubject: "（无主题）",
    digestTitle: (count) => `新邮件 ${count} 封`,
    digestMore: (count) => `还有 ${count} 封`,
    unknownSender: "未知发件人",
    needsSetup: "邮箱尚未连接",
    needsProvider: "请选择邮箱服务商",
    needsProviderBody: (label) =>
      `${label || "这个账号"}还没指定邮箱服务，所以暂时不连接。请打开 设置 → 插件 → 邮箱收件 编辑这个账号：选择你的服务商，或者选「自定义服务器」并填写服务器信息。`,
    reasons: {
      missing: "插件还没有邮箱凭据。请在侧栏「收件箱」面板或设置里添加一个账号。",
      rejected: "邮箱拒绝了登录。请核对这个账号在「收件箱」面板里的服务商，并重新生成授权码。",
      oauth2: "该服务商现在要求 IMAP 使用 OAuth2，应用暂不支持。请为这个账号换一个服务商。",
      starttls:
        "这个邮件服务器不提供 STARTTLS，而应用不会在未加密的连接上登录。请在账号设置里把这封邮箱的加密方式改成 SSL，并使用管理员给你的加密端口（IMAP 993，POP3 995）。",
      tls: "无法与这个邮件服务器建立加密连接：证书没有通过校验，或者那个端口并不是加密端口。请核对账号设置里的服务器、端口和加密方式。",
      unsupported: "当前应用版本缺少本插件需要的宿主能力（需要桌面 1.10.0 及以上）。",
      other: "暂时无法连接邮箱，稍后会自动重试。",
    },
  },
};

/** The strings for one app locale: `zh-CN` for every Chinese shell, else English. */
function messages(locale) {
  return TEXT[locale] ?? TEXT.en;
}

/** Collapse whitespace and cut to the host's limit, with an ellipsis. */
function clamp(value, limit) {
  return cut(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    limit,
  );
}

/**
 * The same, for a body that is a list.
 *
 * A digest is one line per sender, so its newlines are structure, not noise: the
 * only whitespace collapsed here is the horizontal kind inside a line.
 */
function clampLines(value, limit) {
  const source = String(value ?? "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return cut(source, limit);
}

function cut(source, limit) {
  return source.length > limit ? `${source.slice(0, limit - 1)}…` : source;
}

function formatTime(at, locale) {
  if (!Number.isFinite(at)) return "";
  try {
    return new Date(at).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * `Sender · 14 Nov, 10:00` on one line and the account on the next.
 *
 * With several mailboxes in one notification centre, "who is this about" has two
 * answers — the sender and the account — and a row that gives only the first
 * makes the user open it to find out which mailbox is talking.
 */
function alertBody(message, text, locale, accountLabel) {
  const sender = message.from?.name || message.from?.address || text.unknownSender;
  const when = formatTime(message.receivedAt, locale);
  const first = when ? `${sender} · ${when}` : sender;
  return clampLines(accountLabel ? `${first}\n${accountLabel}` : first, MAX_BODY);
}

/** One line per sender and subject, then the account that received them. */
function digestBody(entries, text, accountLabel) {
  const lines = entries.slice(0, DIGEST_LINES).map((entry) => {
    const sender = entry.from?.name || entry.from?.address || text.unknownSender;
    return `${sender} · ${entry.subject || text.noSubject}`;
  });
  if (entries.length > DIGEST_LINES) lines.push(text.digestMore(entries.length - DIGEST_LINES));
  if (accountLabel) lines.push(accountLabel);
  return clampLines(lines.join("\n"), MAX_BODY);
}

/** The digest's title, which is the one place the count and the account meet. */
function digestTitle(count, text, accountLabel) {
  const base = text.digestTitle(count);
  return clamp(accountLabel ? `${base} · ${accountLabel}` : base, MAX_TITLE);
}

/** Why nothing is arriving, in the user's language. */
function setupReason(code, text) {
  switch (String(code ?? "")) {
    case "CREDENTIAL_NOT_CONFIGURED":
    case "CREDENTIAL_INSTANCE_REQUIRED":
      return text.reasons.missing;
    case "CREDENTIAL_REJECTED":
    case "CREDENTIAL_UNSUPPORTED":
      return text.reasons.rejected;
    case "PROVIDER_NEEDS_OAUTH":
    case "PROVIDER_UNSELECTED":
      return text.reasons.oauth2;
    case "STARTTLS_UNAVAILABLE":
      return text.reasons.starttls;
    case "TLS_FAILED":
    case "TLS_CERTIFICATE":
      return text.reasons.tls;
    case "UNSUPPORTED":
      return text.reasons.unsupported;
    default:
      return text.reasons.other;
  }
}


/** What the check command says afterwards, for every account it looked at. */
function checkedToast(status, text) {
  const accounts = Number.isInteger(status?.accounts) ? status.accounts : 1;
  if (!status?.checked) return status?.watched ? text.checking : text.notConnected;
  return status.handled > 0 ? text.checkedWithMail(status.handled, accounts) : text.checkedEmpty(accounts);
}

module.exports = {
  DIGEST_LINES,
  MAX_BODY,
  MAX_TITLE,
  TEXT,
  alertBody,
  checkedToast,
  clamp,
  clampLines,
  digestBody,
  digestTitle,
  formatTime,
  messages,
  setupReason,
};
