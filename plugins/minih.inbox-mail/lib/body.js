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

/**
 * One parameter, with RFC 2231 continuations folded.
 *
 * `filename*0*=utf-8''%E6%8A%A5` / `filename*1*=%E5%91%8A.pdf` is how a client
 * escapes a long or non-ASCII file name, and often the only place the name
 * appears. The sections are joined in index order, the same way
 * `lib/attachments.js` reads them from `BODYSTRUCTURE`: both sides have to call
 * one part the same thing, because a name either of them read differently is a
 * name the save and the forward refuse to trust.
 *
 * @returns `{ value, encoded }`, or `null` when the parameter is absent.
 */
function extendedParam(params, name) {
  const direct = params.get(`${name}*`);
  if (direct) return { value: direct, encoded: true };
  const continuations = [];
  for (const [key, value] of params) {
    const match = new RegExp(`^${name}\\*(\\d+)\\*?$`).exec(key);
    if (match) continuations.push({ index: Number(match[1]), encoded: key.endsWith("*"), value });
  }
  if (!continuations.length) return null;
  continuations.sort((a, b) => a.index - b.index);
  return {
    value: continuations.map((entry) => entry.value).join(""),
    // The first section decides: RFC 2231 marks every encoded section, and a name
    // split into plain sections is literal text with nothing to decode.
    encoded: continuations[0].encoded,
  };
}

/** The name of one entity, from its disposition first and its type second. */
function filenameFrom(disposition, contentType) {
  const extended =
    extendedParam(disposition.params, "filename") ?? extendedParam(contentType.params, "name");
  if (!extended) {
    return cleanFilename(
      disposition.params.get("filename") ?? contentType.params.get("name"),
      "",
    );
  }
  if (!extended.encoded) return cleanFilename(extended.value, "");
  const match = /^[^']*'[^']*'(.*)$/.exec(extended.value);
  try {
    return cleanFilename(decodeURIComponent(match ? match[1] : extended.value), "");
  } catch {
    return cleanFilename(extended.value, "");
  }
}

function textOf(headers, body) {
  const contentType = parseStructured(mime.headerValue(headers, "content-type") || "text/plain");
  const charset = contentType.params.get("charset") ?? "utf-8";
  const decoded = decodeTransfer(body, mime.headerValue(headers, "content-transfer-encoding"));
  return mime.decodeBytes(decoded, charset);
}

/**
 * Walk one MIME entity, collecting what the panel shows.
 *
 * `partPrefix` is the IMAP section number this entity occupies, or would pass
 * down to its children. RFC 3501 numbers the parts of a `multipart` 1, 2, 3 in
 * document order and nests them as `1.2`; a message that is not multipart has one
 * part, `1`. The number is carried on every attachment because fetching exactly
 * that part (`UID FETCH <uid> BODY.PEEK[<part>]`) is what saves a download from
 * pulling the whole message, and because the server numbers the tree the same way
 * its `BODYSTRUCTURE` does.
 *
 * `state.collectData` keeps each attachment's decoded bytes, which only a
 * download asks for: listing a message's attachments must not hold their content.
 */
function walk(entity, state, depth, partPrefix) {
  if (depth > MAX_DEPTH || state.parts >= MAX_PARTS) return;
  state.parts += 1;
  const headers = mime.parseHeaders(entity.header);
  const contentType = parseStructured(mime.headerValue(headers, "content-type") || "text/plain");
  const disposition = parseStructured(mime.headerValue(headers, "content-disposition"));
  const type = contentType.value || "text/plain";

  if (type.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    const children = splitMultipart(entity.body, boundary);
    for (let index = 0; index < children.length; index += 1) {
      if (state.parts >= MAX_PARTS) return;
      const part = `${partPrefix}${index + 1}`;
      walk(splitEntity(children[index]), state, depth + 1, `${part}.`);
    }
    return;
  }

  const part = partPrefix ? partPrefix.replace(/\.$/, "") : "1";
  const encoding = mime.headerValue(headers, "content-transfer-encoding");
  const filename = filenameFrom(disposition, contentType);
  const isAttachment =
    disposition.value === "attachment" || Boolean(filename) || type === "message/rfc822";
  if (isAttachment) {
    const decoded = decodeTransfer(entity.body, encoding);
    const entry = {
      filename: filename || (type === "message/rfc822" ? "attached-message.eml" : "attachment"),
      size: decoded.length,
      part,
      type,
      encoding: String(encoding ?? "").trim().toLowerCase(),
    };
    if (state.collectData) entry.data = decoded;
    state.attachments.push(entry);
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
  // about; it is listed by name and size, and its bytes are only decoded when the
  // user asks to save it.
  const entry = {
    filename: filename || type,
    size: entity.body.length,
    part,
    type,
    encoding: String(encoding ?? "").trim().toLowerCase(),
  };
  if (state.collectData) entry.data = decodeTransfer(entity.body, encoding);
  state.attachments.push(entry);
}

/** The header fields a reply or a forward needs, decoded, or `""`. */
const REPLY_HEADERS = ["message-id", "in-reply-to", "references", "reply-to", "from", "to", "cc", "subject", "date"];

/**
 * One raw message -> `{ text, html, attachments, headers }`.
 *
 * Both text alternatives are returned when the message has both: the panel shows
 * the plain one first and offers the HTML one, which is what the user asked for
 * ("show text/plain by preference").
 *
 * `headers` is the handful of values a reply sets its `In-Reply-To` and
 * `References` from. They are read from the same bytes the panel already asked
 * for — opening a message is the only fetch — so a reply costs no second
 * request, and a message whose server never reported these in its `ENVELOPE`
 * still threads correctly.
 *
 * `withData` keeps every attachment's bytes, for the one download click that needs
 * them; without it the list carries names, sizes and part numbers only.
 */
function parseMessage(raw, { withData = false } = {}) {
  const entity = splitEntity(raw);
  const state = { text: null, html: null, attachments: [], parts: 0, collectData: withData };
  walk(entity, state, 0, "");
  const root = mime.parseHeaders(entity.header);
  const headers = {};
  for (const name of REPLY_HEADERS) {
    headers[name] = mime.headerValue(root, name).trim();
  }
  return { text: state.text, html: state.html, attachments: state.attachments, headers };
}

/**
 * The attachment with section number `part` of one raw message, with its bytes.
 *
 * This is the POP3 path: the protocol has no way to ask for one MIME part, so the
 * caller fetches the message (capped) and this function takes out the part the
 * user clicked — chosen by the same section number the panel showed, never by a
 * position in a list. Two parsers walk this message (this one for the panel, and
 * `lib/attachments.js` for the server's `BODYSTRUCTURE`), and an index means
 * different things to each the moment an inline image or an unnamed part is in the
 * message, so the number is the only safe name for a part.
 *
 * `filename` is what the panel called that part. When both sides have a name and
 * they disagree, the answer is `ATTACHMENT_MISMATCH` rather than a file the user
 * did not ask for; an empty name on either side is not a disagreement.
 */
function selectAttachment(raw, part, { maxBytes = 0, filename = "" } = {}) {
  const wanted = String(part ?? "").trim();
  if (!/^\d+(\.\d+)*$/.test(wanted)) {
    throw Object.assign(new Error("a MIME part number is required"), { code: "INVALID_ARGUMENT" });
  }
  const parsed = parseMessage(raw, { withData: true });
  const file = parsed.attachments.find((entry) => entry.part === wanted);
  if (!file) {
    throw Object.assign(new Error("this message has no such attachment"), { code: "ATTACHMENT_NOT_FOUND" });
  }
  const expected = String(filename ?? "").trim().toLowerCase();
  const actual = String(file.filename ?? "").trim().toLowerCase();
  if (expected && actual && expected !== actual) {
    throw Object.assign(new Error("the part at that number is a different attachment"), {
      code: "ATTACHMENT_MISMATCH",
    });
  }
  if (maxBytes > 0 && file.data.length > maxBytes) {
    throw Object.assign(new Error("this attachment is larger than one save may write"), {
      code: "ATTACHMENT_TOO_LARGE",
    });
  }
  return file;
}

module.exports = {
  MAX_DEPTH,
  MAX_PARTS,
  REPLY_HEADERS,
  decodeQuotedPrintable,
  decodeTransfer,
  parseMessage,
  parseStructured,
  selectAttachment,
  splitEntity,
  splitMultipart,
};
