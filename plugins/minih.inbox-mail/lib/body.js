"use strict";

/**
 * A message body, parsed far enough to show it.
 *
 * The plugin fetches one raw message when the user opens it in the Inbox panel,
 * and this file turns those bytes into the two things the panel can display: the
 * plain-text alternative and the HTML alternative, plus a list of attachment
 * names. Nothing here writes anywhere, and nothing here renders: the HTML is
 * handed to the panel, which sanitizes it and puts it in a scriptless frame.
 *
 * The parser covers what real mail uses and no more: `multipart/*` (including
 * nested), base64 and quoted-printable transfer encodings, and the charsets
 * Chinese mail actually arrives in. Bytes are carried as `latin1` strings so no
 * byte is lost while splitting on boundaries, and every text part is decoded with
 * `TextDecoder` in its declared charset by `lib/mime.js`.
 *
 * A message is untrusted input. A part count, a nesting depth and a filename
 * length are all bounded, so a crafted message cannot make this file allocate
 * without limit or produce a filename that breaks the panel's layout.
 */

const mime = require("./mime");

/** How many MIME parts one message may have before the rest is ignored. */
const MAX_PARTS = 120;
/** How deep `multipart/mixed` inside `multipart/alternative` may nest. */
const MAX_DEPTH = 6;
const MAX_FILENAME = 200;

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

/**
 * Split a MIME entity into its header block and its body.
 *
 * The separator is the first empty line; a message whose headers use bare LF is
 * accepted too, because that is what a broken sender produces and refusing it
 * would show the user an error instead of their mail.
 */
function splitEntity(bytes) {
  const buffer = asBytes(bytes);
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { header: buffer.subarray(0, crlf), body: buffer.subarray(crlf + 4) };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { header: buffer.subarray(0, lf), body: buffer.subarray(lf + 2) };
  return { header: buffer, body: Buffer.alloc(0) };
}

/** `text/plain; charset="utf-8"` -> `{ value, params }`, quoted values unwrapped. */
function parseStructured(value) {
  const source = String(value ?? "");
  const parts = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\" && quoted && i + 1 < source.length) {
      current += source[i + 1];
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  const params = new Map();
  for (const entry of parts.slice(1)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim().toLowerCase();
    const raw = entry.slice(eq + 1).trim();
    if (!key) continue;
    params.set(key, raw);
  }
  return { value: (parts[0] ?? "").trim().toLowerCase(), params };
}

/** `base64`, `quoted-printable`, or "the bytes are the content". */
function decodeTransfer(bytes, encoding) {
  const name = String(encoding ?? "").trim().toLowerCase();
  if (name === "base64") {
    const text = asBytes(bytes).toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
    if (!text) return Buffer.alloc(0);
    return Buffer.from(text, "base64");
  }
  if (name === "quoted-printable") return decodeQuotedPrintable(bytes);
  return asBytes(bytes);
}

/**
 * Quoted-printable, at byte level.
 *
 * `=XX` is one byte, `=\r\n` (or a bare `=\n`) is a soft line break that
 * disappears, and everything else is literal. Getting the soft break wrong is
 * what turns a long paragraph into a string of stray equals signs, so it is
 * handled before the two-character case.
 */
function decodeQuotedPrintable(bytes) {
  const source = asBytes(bytes);
  const out = Buffer.alloc(source.length);
  let written = 0;
  for (let i = 0; i < source.length; i += 1) {
    const byte = source[i];
    if (byte !== 0x3d) {
      out[written] = byte;
      written += 1;
      continue;
    }
    const next = source[i + 1];
    if (next === 0x0d && source[i + 2] === 0x0a) {
      i += 2;
      continue;
    }
    if (next === 0x0a) {
      i += 1;
      continue;
    }
    const hex = String.fromCharCode(next ?? 0, source[i + 2] ?? 0);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[written] = parseInt(hex, 16);
      written += 1;
      i += 2;
      continue;
    }
    out[written] = byte;
    written += 1;
  }
  return out.subarray(0, written);
}

/**
 * The parts of a multipart body, split on the boundary the header declared.
 *
 * A boundary can appear inside a base64 part in principle, which is why the
 * delimiter check requires the marker at the start of a line and never matches
 * inside a part's content: splitting on the text `--boundary` at line starts is
 * exactly what the format guarantees.
 *
 * The CRLF before a delimiter belongs to the delimiter, not to the part, so each
 * part is trimmed of the one trailing line break the format adds.
 */
function splitMultipart(bytes, boundary) {
  const text = asBytes(bytes).toString("latin1");
  if (!boundary) return [];
  const marker = `--${boundary}`;
  const parts = [];
  let index = text.indexOf(marker);
  if (index < 0) return [];
  while (index >= 0) {
    // Only a line start counts: a boundary inside a value is content.
    const atLineStart = index === 0 || text[index - 2] === "\r" || text[index - 1] === "\n";
    const after = text.slice(index, index + marker.length + 2);
    if (!atLineStart) {
      index = text.indexOf(marker, index + 1);
      continue;
    }
    if (after.startsWith(`${marker}--`)) break;
    let start = index + marker.length;
    if (text.startsWith("\r\n", start)) start += 2;
    else if (text[start] === "\n") start += 1;
    const next = text.indexOf(`\n${marker}`, start);
    if (next < 0) {
      parts.push(Buffer.from(text.slice(start), "latin1"));
      break;
    }
    const chunk = text.slice(start, next);
    // The line break before the delimiter is the delimiter's; the one on the
    // previous line is not part of the content either.
    parts.push(Buffer.from(chunk.endsWith("\r") ? chunk.slice(0, -1) : chunk, "latin1"));
    index = next + 1;
  }
  return parts;
}

/** A filename the panel can print: no control characters, bounded length. */
function cleanFilename(value, fallback) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const decoded = mime.decodeEncodedWords(text);
  if (!decoded) return fallback;
  return decoded.length > MAX_FILENAME ? decoded.slice(0, MAX_FILENAME) : decoded;
}

/** RFC 2231 continuation (`filename*0*`) is rare; the plain `filename*` is not. */
function filenameFrom(disposition, contentType) {
  const extended = disposition.params.get("filename*") ?? contentType.params.get("name*");
  if (extended) {
    const match = /^[^']*'[^']*'(.*)$/.exec(extended);
    try {
      return cleanFilename(decodeURIComponent(match ? match[1] : extended), "");
    } catch {
      return cleanFilename(extended, "");
    }
  }
  return cleanFilename(
    disposition.params.get("filename") ?? contentType.params.get("name"),
    "",
  );
}

function textOf(headers, body) {
  const contentType = parseStructured(mime.headerValue(headers, "content-type") || "text/plain");
  const charset = contentType.params.get("charset") ?? "utf-8";
  const decoded = decodeTransfer(body, mime.headerValue(headers, "content-transfer-encoding"));
  return mime.decodeBytes(decoded, charset);
}

function walk(entity, state, depth) {
  if (depth > MAX_DEPTH || state.parts >= MAX_PARTS) return;
  state.parts += 1;
  const headers = mime.parseHeaders(entity.header);
  const contentType = parseStructured(mime.headerValue(headers, "content-type") || "text/plain");
  const disposition = parseStructured(mime.headerValue(headers, "content-disposition"));
  const type = contentType.value || "text/plain";

  if (type.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    for (const part of splitMultipart(entity.body, boundary)) {
      if (state.parts >= MAX_PARTS) return;
      walk(splitEntity(part), state, depth + 1);
    }
    return;
  }

  const filename = filenameFrom(disposition, contentType);
  const isAttachment =
    disposition.value === "attachment" || Boolean(filename) || type === "message/rfc822";
  if (isAttachment) {
    const decoded = decodeTransfer(entity.body, mime.headerValue(headers, "content-transfer-encoding"));
    state.attachments.push({
      filename: filename || (type === "message/rfc822" ? "attached-message.eml" : "attachment"),
      size: decoded.length,
    });
    return;
  }
  if (type === "text/plain") {
    if (state.text === null) state.text = textOf(headers, entity.body);
    return;
  }
  if (type === "text/html") {
    if (state.html === null) state.html = textOf(headers, entity.body);
    return;
  }
  // A part the panel cannot show is still something the user may want to know
  // about; it is listed by name and size, and never fetched twice.
  state.attachments.push({ filename: filename || type, size: entity.body.length });
}

/**
 * One raw message -> `{ text, html, attachments }`.
 *
 * Both text alternatives are returned when the message has both: the panel shows
 * the plain one first and offers the HTML one, which is what the user asked for
 * ("show text/plain by preference").
 */
function parseMessage(raw) {
  const entity = splitEntity(raw);
  const state = { text: null, html: null, attachments: [], parts: 0 };
  walk(entity, state, 0);
  return { text: state.text, html: state.html, attachments: state.attachments };
}

module.exports = {
  MAX_DEPTH,
  MAX_PARTS,
  decodeQuotedPrintable,
  decodeTransfer,
  parseMessage,
  parseStructured,
  splitEntity,
  splitMultipart,
};
