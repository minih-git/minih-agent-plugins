"use strict";

/**
 * The one-line preview the Inbox list shows under a subject.
 *
 * Since 0.4.0 a new message is fetched with a capped `BODY.PEEK[TEXT]<0.4096>`
 * (IMAP) or a `TOP n 12` (POP3), and this file turns those first bytes into at
 * most `MAX_SUMMARY` characters of plain text. Three rules shape it:
 *
 * - **Best effort, never an error.** A fragment is the beginning of a message,
 *   not the whole one: a cut MIME boundary, a half-encoded word, a charset the
 *   process does not know. Every one of those loses its part and keeps the rest,
 *   because a missing preview is a cosmetic problem and a thrown error is not.
 * - **Nothing that is not text.** A base64 part cannot be decoded from its first
 *   bytes, so it is dropped rather than shown as noise; markup is stripped, MIME
 *   boundary and part headers are removed, and whitespace is collapsed.
 * - **The same bound as `lib/store.js`.** 140 characters is what the state file's
 *   envelope keeps; a longer preview would be cut twice.
 *
 * What comes out is stored, so it is also written as data rather than as mail:
 * no markup, no control characters, no leading or trailing space.
 */

const body = require("./body");
const mime = require("./mime");

/** Kept equal to `store.MAX_SUMMARY`; a test asserts the two agree. */
const MAX_SUMMARY = 140;
/** How many text parts of a multipart message may contribute to one preview. */
const MAX_PARTS = 4;
/** Whitespace as a mail actually carries it, including the non-breaking kind. */
const WHITESPACE = /[\s\u00a0\u200b\u200c\u200d\ufeff]+/g;
/** Control characters a preview must not carry into the panel. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function charsetOf(contentType) {
  return body.parseStructured(contentType).params.get("charset") ?? "utf-8";
}

/** Fold every run of whitespace to one space and trim the ends. */
function plainText(value) {
  return String(value ?? "")
    .replace(CONTROL, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

/** Cut to the bound without splitting a surrogate pair or leaving a space. */
function clip(value, limit = MAX_SUMMARY) {
  const text = plainText(value);
  if (text.length <= limit) return text;
  let cut = limit;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut).trimEnd();
}

/**
 * An HTML fragment as text.
 *
 * A full HTML parser is not needed and would be the wrong tool: this is a
 * preview, so block-level tags become a space, everything else disappears, and
 * the handful of entities a mail body actually uses are decoded. `&amp;` last, so
 * `&amp;lt;` stays `&lt;` instead of turning into a tag.
 */
function stripMarkup(value) {
  return String(value ?? "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d{1,6});/g, (match, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, code) => {
      const point = parseInt(code, 16);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/**
 * One MIME part's body as text.
 *
 * `base64` returns nothing: the decoded form of a fragment is not the beginning
 * of the text, it is a fragment in the middle of a base64 stream. Saying so
 * quietly is better than previewing random letters.
 */
function partText(bytes, contentType, transferEncoding) {
  const type = String(contentType ?? "text/plain").toLowerCase();
  const encoding = String(transferEncoding ?? "").trim().toLowerCase();
  if (encoding === "base64") return "";
  const decoded = encoding === "quoted-printable" ? body.decodeQuotedPrintable(bytes) : bytes;
  const text = mime.decodeBytes(decoded, charsetOf(type));
  return type.includes("html") ? stripMarkup(text) : text;
}

/**
 * The preview of a message from the first bytes of its text.
 *
 * @param bytes  the fragment the server sent (`BODY[TEXT]` or a `TOP` body)
 * @param source `{ contentType, transferEncoding }` of the *message*, read from
 *   its headers: only a non-multipart message has a single encoding of its own.
 */
function summarizeFragment(bytes, source = {}) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "", "utf8");
  if (!raw.length) return "";
  const contentType = String(source.contentType ?? "text/plain");
  const top = body.parseStructured(contentType);
  if (top.value.startsWith("multipart/")) {
    const boundary = top.params.get("boundary");
    const chunks = [];
    for (const part of body.splitMultipart(raw, boundary)) {
      if (chunks.length >= MAX_PARTS) break;
      const entity = body.splitEntity(part);
      const headers = mime.parseHeaders(entity.header);
      const disposition = mime.headerValue(headers, "content-disposition").toLowerCase();
      if (disposition.startsWith("attachment")) continue;
      const type = mime.headerValue(headers, "content-type") || "text/plain";
      if (!/^text\//i.test(type.trim())) continue;
      const text = partText(entity.body, type, mime.headerValue(headers, "content-transfer-encoding"));
      if (plainText(text)) chunks.push(text);
    }
    return clip(chunks.join(" "));
  }
  return clip(partText(raw, contentType, source.transferEncoding));
}

module.exports = {
  MAX_PARTS,
  MAX_SUMMARY,
  clip,
  plainText,
  stripMarkup,
  summarizeFragment,
};