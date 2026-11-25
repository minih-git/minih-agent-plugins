"use strict";

/**
 * The message a send request carries: headers, body and attachments, as bytes.
 *
 * The host delivers whatever `pi.mail.send` is given; it does not compose, and it
 * refuses a message it cannot deliver safely. So this file owns every decision
 * the wire format requires, and it stays pure: strings and buffers in, one
 * `multipart/mixed` (or single-part) message out, no clock that a test cannot
 * pass in, no I/O, no host API.
 *
 * Four rules are load-bearing and each one is here for a reason:
 *
 * - **Everything is 7-bit.** The host refuses 8-bit content unless the server
 *   advertises `8BITMIME` (`MAIL_EIGHT_BIT_UNSUPPORTED`) rather than silently
 *   rewriting it, and most servers do not. So headers carry RFC 2047 encoded
 *   words, the text is quoted-printable, and every attachment is base64: no byte
 *   above 126 ever reaches `DATA`, and the same message works everywhere.
 * - **No `Bcc:` header, ever.** Blind recipients belong in the SMTP envelope; the
 *   host refuses a message that carries the header (`MAIL_BCC_HEADER`), and a
 *   plugin that wrote one would leak exactly the addresses it was trusted with.
 * - **The `From:` is the account's own address.** The host refuses anything else
 *   (`MAIL_FROM_MISMATCH`) — a display name may differ, the address may not.
 * - **CRLF everywhere, and a boundary nothing in the body can collide with.** A
 *   boundary that appears inside a part splits the message in two.
 *
 * Nothing here is about the panel: this module has no DOM, no strings table, and
 * no locale-specific sentence outside the two attribution lines a reply and a
 * forward open with.
 */

const crypto = require("node:crypto");

/** The most recipients one message may name, after de-duplication (the host's cap). */
const MAX_RECIPIENTS = 50;
/** The most one message may weigh, in bytes (the host's cap). */
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** How many references an `References:` line keeps: enough for a thread, bounded. */
const MAX_REFERENCES = 20;
/** The characters a header value may contain without RFC 2047 encoding. */
const ASCII_PRINTABLE = /^[\t\x20-\x7e]*$/;
/** One address: a local part, one `@`, and a plausible domain. */
const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** One address, trimmed and without a display name, or `""`. */
function bareAddress(value) {
  const text = String(value ?? "").trim();
  const angled = /<([^<>]+)>\s*$/.exec(text);
  return (angled ? angled[1] : text).trim();
}

/** Whether one value is an address this plugin will put in an envelope. */
function isAddress(value) {
  const text = bareAddress(value);
  if (!text || text.length > 320) return false;
  if (text.includes(" ")) return false;
  return ADDRESS.test(text);
}

/**
 * One `To:`-style value as entries: `"Ann Lee" <ann@example.com>, bob@example.com`.
 *
 * The parser is deliberately small: a quoted display name, an angle-addr, and a
 * bare address cover every message this plugin writes or quotes. A header it
 * cannot read is skipped rather than thrown on — a reply to a message with one
 * broken address should still open the composer.
 */
function parseAddressHeader(value) {
  const source = String(value ?? "");
  const entries = [];
  let current = "";
  let quoted = false;
  const commit = () => {
    const text = current.trim();
    current = "";
    if (!text) return;
    const angled = /^(.*)<([^<>]+)>\s*$/.exec(text);
    if (angled) {
      const name = angled[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
      const address = angled[2].trim();
      if (isAddress(address)) entries.push({ name, address });
      return;
    }
    if (isAddress(text)) entries.push({ name: "", address: text });
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && quoted && index + 1 < source.length) {
      current += source[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if ((char === "," || char === ";") && !quoted) {
      commit();
      continue;
    }
    current += char;
  }
  commit();
  return entries;
}

/**
 * A recipient list the caller typed, cleaned and checked.
 *
 * Splitting happens on comma, semicolon and line break as well as whitespace, so
 * a pasted `a@b.com c@d.com` fills two chips in the panel exactly like
 * `a@b.com, c@d.com` does (`view/model.js` keeps the same split for the chips).
 *
 * @returns `{ entries, invalid }` — every entry deduplicated by lower-cased
 *   address, and the values this module will not put in an envelope.
 */
function parseRecipients(value) {
  const list = Array.isArray(value) ? value : [value];
  const entries = [];
  const invalid = [];
  const seen = new Set();
  for (const item of list) {
    if (item && typeof item === "object") {
      const address = bareAddress(item.address);
      if (!isAddress(address)) {
        if (address) invalid.push(address);
        continue;
      }
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: String(item.name ?? "").trim(), address });
      continue;
    }
    for (const piece of String(item ?? "").split(/[,;\r\n]+/)) {
      const text = piece.trim();
      if (!text) continue;
      const parsed = parseAddressHeader(text);
      if (!parsed.length) {
        invalid.push(text);
        continue;
      }
      for (const entry of parsed) {
        const key = entry.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
  }
  return { entries, invalid };
}

/**
 * A display name as a header-safe token.
 *
 * A name with a comma, an angle bracket or a quote is written as a quoted string,
 * which is what keeps `Doe, Jane <jane@example.com>` one recipient instead of
 * two; a name without them is written as a phrase.
 */
function formatAddress(entry) {
  const name = String(entry?.name ?? "").trim();
  const address = bareAddress(entry?.address);
  if (!name) return address;
  if (ASCII_PRINTABLE.test(name) && /[",<>@;:.[\]\\]/.test(name)) {
    return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  }
  if (ASCII_PRINTABLE.test(name)) return `${name} <${address}>`;
  const encoded = encodeHeaderValue(name);
  return `${encoded} <${address}>`;
}

/**
 * A header value, folded so no line grows past the conventional 78 characters.
 *
 * Non-ASCII text becomes RFC 2047 `B` encoded words: the UTF-8 bytes are split
 * on character boundaries into words of at most 39 bytes (52 base64 characters,
 * plus the 12-character wrapper, so one word never exceeds 64 characters and
 * `Subject: ` still leaves the line under 78), and the words are separated by a
 * fold. Adjacent encoded words joined by whitespace are one string to a decoder,
 * which is exactly how a long Chinese subject travels.
 */
function encodeHeaderValue(value) {
  const text = String(value ?? "");
  if (ASCII_PRINTABLE.test(text)) return text;
  const words = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, "utf8") > 39) {
      words.push(chunk);
      chunk = char;
    } else {
      chunk += char;
    }
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** Fold one ASCII value on spaces so every line stays within `width`. */
function foldAscii(prefix, value, width = 78) {
  const words = String(value).split(/\s+/).filter(Boolean);
  if (!words.length) return `${prefix}`;
  const lines = [];
  let line = prefix;
  for (const word of words) {
    const candidate = line.endsWith(" ") || line === prefix ? `${line}${word}` : `${line} ${word}`;
    if (candidate.length > width && line.trim() && line !== prefix) {
      lines.push(line);
      line = ` ${word}`;
      continue;
    }
    line = candidate;
  }
  lines.push(line);
  return lines.join("\r\n");
}

/**
 * One `Name: value` header, folded.
 *
 * An encoded-word value is folded between words by `encodeHeaderValue` already;
 * an ASCII value is folded here on its own spaces. A name whose first word would
 * overflow the line starts on a continuation line instead, which keeps the
 * header within the limit and is what every mail client does with a long subject.
 */
function headerLine(name, value) {
  const prefix = `${name}: `;
  const text = String(value ?? "");
  if (!text) return null;
  if (ASCII_PRINTABLE.test(text)) {
    const encodedWords = /=\?[^?]+\?[BbQq]\?[^?]*\?=/.test(text);
    return encodedWords ? `${prefix}${text}` : foldAscii(prefix, text);
  }
  const encoded = encodeHeaderValue(text);
  const words = encoded.split("\r\n ");
  const lines = [words[0].length + prefix.length <= 78 ? `${prefix}${words[0]}` : `${prefix}\r\n ${words[0]}`];
  for (const word of words.slice(1)) lines.push(` ${word}`);
  return lines.join("\r\n");
}

/**
 * Quoted-printable, line by line, at byte level.
 *
 * `=` and every byte outside printable ASCII are written as `=XX`; a trailing
 * space or tab is encoded too, because a transport is allowed to strip it; and a
 * line longer than 76 characters is broken with a soft break (`=` + CRLF) so no
 * line exceeds the limit. The body arrives as text and leaves as 7-bit ASCII with
 * CRLF endings, which is what `DATA` expects.
 */
function encodeQuotedPrintable(text) {
  const normalized = String(text ?? "").replace(/\r\n|\r|\n/g, "\n");
  const lines = normalized.split("\n");
  const out = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, "utf8");
    let encodedLine = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      const last = index === bytes.length - 1;
      let token;
      if ((byte === 0x20 || byte === 0x09) && last) {
        token = `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      } else if (byte === 0x3d || byte < 0x20 || byte > 0x7e) {
        token = `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      } else {
        token = String.fromCharCode(byte);
      }
      // 76 characters is the limit; keeping one in reserve leaves room for the
      // soft break itself.
      if (encodedLine.length + token.length > 75) {
        out.push(`${encodedLine}=`);
        encodedLine = "";
      }
      encodedLine += token;
    }
    out.push(encodedLine);
  }
  return out.join("\r\n");
}

/** base64 in 76-character lines, as `Content-Transfer-Encoding: base64` wants. */
function encodeBase64(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  if (!bytes.length) return "\r\n";
  const text = bytes.toString("base64");
  const lines = [];
  for (let index = 0; index < text.length; index += 76) lines.push(text.slice(index, index + 76));
  return lines.join("\r\n");
}

/**
 * A file name as an RFC 2231 parameter.
 *
 * `filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf` for a short name: the charset, an
 * empty language, and the percent-encoded bytes. A name whose encoding would push
 * the header over the line limit is split into continuations (`filename*0*`,
 * `filename*1*`, …), never inside a `%XX` triplet — a split there would corrupt
 * the very bytes the encoding exists to preserve.
 */
function rfc2231Parameter(name, value, { limit = 60 } = {}) {
  const encoded = encodeURIComponent(String(value ?? "")).replace(
    /['()*!~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const prefix = "UTF-8''";
  if (prefix.length + encoded.length <= limit) return `${name}*=${prefix}${encoded}`;
  const chunks = [];
  let current = "";
  for (let index = 0; index < encoded.length; ) {
    const triplet = encoded[index] === "%" ? encoded.slice(index, index + 3) : encoded[index];
    if (current.length + triplet.length > limit) {
      chunks.push(current);
      current = "";
    }
    current += triplet;
    index += triplet.length;
  }
  if (current) chunks.push(current);
  return chunks
    .map((chunk, position) => `${name}*${position}*=${position === 0 ? prefix : ""}${chunk}`)
    .join(";\r\n ");
}

/** An attachment's `Content-Type` / `Content-Disposition` pair for one file. */
function attachmentHeaders(file) {
  const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(file?.type ?? "")) ? String(file.type) : "application/octet-stream";
  const name = String(file?.name ?? "").trim() || "attachment";
  // An ASCII name travels as a plain quoted parameter (every client reads that);
  // anything else is RFC 2231, which is the only form that survives a Chinese
  // file name.
  const ascii = ASCII_PRINTABLE.test(name) && !/["\\;]/.test(name);
  const typeParam = ascii ? `name="${name}"` : rfc2231Parameter("name", name);
  const dispositionParam = ascii ? `filename="${name}"` : rfc2231Parameter("filename", name);
  return { type, typeParam, dispositionParam, name };
}

/**
 * `Wed, 14 Nov 2026 10:00:00 +0800`.
 *
 * A `Date` header is local time plus the sender's own offset: a message stamped
 * `Z` is wrong by a working day for half the planet, and a mail client shows it.
 */
function formatDate(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (number) => String(number).padStart(2, "0");
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return (
    `${days[value.getDay()]}, ${pad(value.getDate())} ${months[value.getMonth()]} ${value.getFullYear()} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())} ` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  );
}

/** `<9f2c1a4b3d@example.com>`: unique per message, in the sender's own domain. */
function makeMessageId(address, { now = Date.now(), random = crypto.randomBytes(6) } = {}) {
  const domain = String(address ?? "").split("@")[1] || "localhost";
  return `<${now.toString(36)}.${random.toString("hex")}@${domain}>`;
}

/**
 * The subject a reply or a forward carries.
 *
 * The prefix goes on once: replying to a reply must not build `Re: Re:`, and
 * `Re[2]:` (what Outlook writes) is recognised as a prefix rather than doubled.
 */
function replySubject(subject) {
  const text = String(subject ?? "").trim();
  return /^re(\[\d+\])?:/i.test(text) ? text : `Re: ${text}`;
}

function forwardSubject(subject) {
  const text = String(subject ?? "").trim();
  return /^fwd?:/i.test(text) ? text : `Fwd: ${text}`;
}

/**
 * The `References:` list for a reply: the original thread plus the message being
 * answered, trimmed to the last `MAX_REFERENCES` ids.
 *
 * RFC 5322 §3.6.4: `In-Reply-To` is the parent's id, `References` is the chain
 * that led to it. A client that sends only `In-Reply-To` still threads in Gmail;
 * a client that sends neither starts a new conversation, which is the bug this
 * function exists to prevent.
 */
function referencesFor({ references = [], inReplyTo = "" } = {}) {
  const ids = [];
  const push = (value) => {
    for (const token of String(value ?? "").split(/\s+/)) {
      const id = token.trim();
      if (!id) continue;
      if (!/^<[^<>@\s]+@[^<>\s]+>$/.test(id)) continue;
      if (ids.includes(id)) continue;
      ids.push(id);
    }
  };
  push(references);
  if (Array.isArray(references)) for (const entry of references) push(entry);
  push(inReplyTo);
  return ids.slice(-MAX_REFERENCES);
}

/** HTML to the plain text a quoted reply shows: no tags, no script, no styles. */
function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `> ` in front of every line, which is what a quote looks like in text mail. */
function quoteLines(text) {
  return String(text ?? "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** The attribution line a reply opens its quote with, in the panel's language. */
function attribution({ from, date, locale = "en" }) {
  const name = from?.name || from?.address || "";
  const when = String(date ?? "");
  if (String(locale).startsWith("zh")) return `于 ${when}，${name} 写道：`;
  return `On ${when}, ${name} wrote:`;
}

/**
 * The quoted body of a reply: a blank line, the attribution, then the original.
 *
 * An HTML-only message has no text part, so the quoted text is the HTML with its
 * tags removed — a reply that quotes raw markup is worse than one that quotes
 * nothing, and this plugin has no HTML composer to quote into.
 */
function replyBody({ text = "", html = "", from, date, locale = "en" } = {}) {
  const original = String(text ?? "").trim() || htmlToText(html);
  return `\n\n${attribution({ from, date, locale })}\n${quoteLines(original)}\n`;
}

/** The header summary and body a forward carries (`---------- Forwarded message ----------`). */
function forwardBody({ from, date, to = [], cc = [], subject = "", text = "", html = "", locale = "en" } = {}) {
  const zh = String(locale).startsWith("zh");
  const label = (name, fallback) => (zh ? fallback : name);
  const lines = [
    zh ? "---------- 转发的邮件 ----------" : "---------- Forwarded message ----------",
    `${label("From", "发件人")}: ${from?.name ? `${from.name} <${from.address}>` : from?.address ?? ""}`,
    `${label("Date", "时间")}: ${date ?? ""}`,
    `${label("Subject", "主题")}: ${subject ?? ""}`,
  ];
  const toNames = (Array.isArray(to) ? to : []).map((entry) => entry?.name || entry?.address).filter(Boolean);
  if (toNames.length) lines.push(`${label("To", "收件人")}: ${toNames.join(", ")}`);
  const ccNames = (Array.isArray(cc) ? cc : []).map((entry) => entry?.name || entry?.address).filter(Boolean);
  if (ccNames.length) lines.push(`${label("Cc", "抄送")}: ${ccNames.join(", ")}`);
  const original = String(text ?? "").trim() || htmlToText(html);
  return `\n\n${lines.join("\n")}\n\n${original}\n`;
}

/**
 * One MIME part header whose parameters can push it past the line limit.
 *
 * `Content-Disposition: attachment; filename*=UTF-8''…` is easily 90 characters,
 * so the parameter list is folded at the separator: a header may break anywhere
 * between parameters, and `;\r\n ` is where a mail client expects the break.
 */
function foldParameters(name, value, params, width = 78) {
  const list = (params ?? []).filter(Boolean);
  let line = `${name}: ${value}`;
  const lines = [];
  for (const param of list) {
    const candidate = `${line}; ${param}`;
    if (candidate.length > width) {
      lines.push(`${line};`);
      line = ` ${param}`;
      continue;
    }
    line = candidate;
  }
  lines.push(line);
  return lines.join("\r\n");
}

/**
 * One message, ready for `pi.mail.send`.
 *
 * @param input.from          `{ name, address }` — the account's own address.
 * @param input.to/cc/bcc     recipient values, already parsed or still text.
 * @param input.text          the plain-text body, in UTF-8, as typed.
 * @param input.attachments   `[{ name, type, data }]`, `data` bytes.
 * @returns `{ mime, envelope, messageId, subject }`.
 */
function buildMessage({
  from,
  to = [],
  cc = [],
  bcc = [],
  subject = "",
  text = "",
  attachments = [],
  date = new Date(),
  messageId,
  inReplyTo = "",
  references = [],
  boundary,
  now = Date.now(),
  random,
} = {}) {
  const sender = bareAddress(from?.address ?? from);
  if (!isAddress(sender)) throw coded("BAD_SENDER", "the sending account has no usable address");
  const recipients = parseRecipients(to);
  const copies = parseRecipients(cc);
  const blinds = parseRecipients(bcc);
  const invalid = [...recipients.invalid, ...copies.invalid, ...blinds.invalid];
  if (invalid.length) {
    throw coded("INVALID_RECIPIENT", `not a usable address: ${invalid.join(", ")}`);
  }
  if (!recipients.entries.length) throw coded("NO_RECIPIENTS", "a message needs at least one recipient");
  const allRecipients = [...recipients.entries, ...copies.entries, ...blinds.entries];
  const distinct = new Set(allRecipients.map((entry) => entry.address.toLowerCase()));
  if (distinct.size > MAX_RECIPIENTS) {
    throw coded("TOO_MANY_RECIPIENTS", `one message may name ${MAX_RECIPIENTS} recipients`);
  }

  const files = (Array.isArray(attachments) ? attachments : []).map((file) => {
    const data = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data ?? []);
    return { ...attachmentHeaders(file), data };
  });
  const totalAttachmentBytes = files.reduce((sum, file) => sum + file.data.length, 0);
  if (totalAttachmentBytes > MAX_MESSAGE_BYTES) {
    throw coded("MAIL_TOO_LARGE", "the attachments are larger than one message may be");
  }

  const id = messageId || makeMessageId(sender, { now, random });
  const headers = [];
  const push = (name, value) => {
    const line = headerLine(name, value);
    if (line) headers.push(line);
  };
  push("From", formatAddress({ name: from?.name, address: sender }));
  push("To", recipients.entries.map(formatAddress).join(", "));
  if (copies.entries.length) push("Cc", copies.entries.map(formatAddress).join(", "));
  // A `Bcc:` header is never written: the blind recipients travel in the
  // envelope below, and the host refuses the header for exactly this reason.
  push("Subject", subject);
  push("Date", formatDate(date));
  push("Message-ID", id);
  const chain = referencesFor({ references, inReplyTo });
  if (inReplyTo && /^<[^<>@\s]+@[^<>\s]+>$/.test(String(inReplyTo).trim())) {
    push("In-Reply-To", String(inReplyTo).trim());
  }
  if (chain.length) push("References", chain.join(" "));
  push("MIME-Version", "1.0");

  const marker = boundary || `=_minih_${crypto.randomBytes(8).toString("hex")}`;
  const encodedText = encodeQuotedPrintable(text);
  const textHeaders = "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable";

  let body;
  if (files.length) {
    push("Content-Type", `multipart/mixed; boundary="${marker}"`);
    const parts = [
      `--${marker}\r\n${textHeaders}\r\n\r\n${encodedText}`,
      ...files.map((file) =>
        [
          `--${marker}`,
          foldParameters("Content-Type", file.type, [file.typeParam]),
          foldParameters("Content-Disposition", "attachment", [file.dispositionParam]),
          "Content-Transfer-Encoding: base64",
          "",
          encodeBase64(file.data),
        ].join("\r\n"),
      ),
      `--${marker}--`,
    ];
    body = parts.join("\r\n");
  } else {
    push("Content-Type", "text/plain; charset=UTF-8");
    push("Content-Transfer-Encoding", "quoted-printable");
    body = encodedText;
  }

  const mime = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8");
  if (mime.length > MAX_MESSAGE_BYTES) {
    throw coded("MAIL_TOO_LARGE", "the message is larger than one message may be");
  }
  return {
    mime,
    messageId: id,
    subject: String(subject ?? ""),
    envelope: {
      from: sender,
      to: recipients.entries.map((entry) => entry.address),
      cc: copies.entries.map((entry) => entry.address),
      bcc: blinds.entries.map((entry) => entry.address),
    },
    size: mime.length,
  };
}

module.exports = {
  ADDRESS,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  attribution,
  bareAddress,
  buildMessage,
  encodeBase64,
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatAddress,
  formatDate,
  foldParameters,
  forwardBody,
  forwardSubject,
  htmlToText,
  isAddress,
  makeMessageId,
  parseAddressHeader,
  parseRecipients,
  quoteLines,
  referencesFor,
  replyBody,
  replySubject,
  rfc2231Parameter,
};