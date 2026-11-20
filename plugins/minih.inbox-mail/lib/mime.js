"use strict";

/**
 * Header decoding: RFC 2047 encoded words and the charsets Chinese mail uses.
 *
 * A subject is never sent as plain UTF-8 on the wire. It arrives either as
 * `=?UTF-8?B?5L2g5aW9?=` or, from older clients in this part of the world, as
 * `=?GBK?B?…?=` or `=?gb2312?Q?…?=`. Showing the raw encoded word to a user is
 * the failure this file exists to prevent, so every name and subject the plugin
 * reports goes through `decodeHeaderValue` first.
 *
 * Nothing here parses bodies: this plugin fetches header fields only, with
 * `BODY.PEEK`, and never asks a server for message content.
 */

/**
 * Charset aliases worth folding.
 *
 * `gb2312` and `gbk` both become `gb18030`, which is a strict superset of each
 * and the only one of the three Node's `TextDecoder` is required to support.
 * An encoded word that declares `gb2312` in practice carries GBK or GB18030
 * bytes, so widening is the decoding that matches the sender's intent.
 */
const CHARSET_ALIASES = new Map([
  ["gb2312", "gb18030"],
  ["gb_2312", "gb18030"],
  ["gb_2312-80", "gb18030"],
  ["gbk", "gb18030"],
  ["x-gbk", "gb18030"],
  ["cp936", "gb18030"],
  ["windows-936", "gb18030"],
  ["utf8", "utf-8"],
  ["utf-8n", "utf-8"],
  ["big5", "big5"],
  ["x-big5", "big5"],
  ["iso-8859-1", "iso-8859-1"],
  ["latin1", "iso-8859-1"],
]);

function normalizeCharset(charset) {
  const name = String(charset ?? "").trim().toLowerCase().replace(/^"|"$/g, "");
  if (!name) return "utf-8";
  return CHARSET_ALIASES.get(name) ?? name;
}

/**
 * Bytes to text in a declared charset.
 *
 * An unknown charset, or bytes the charset cannot represent, fall back to UTF-8
 * rather than throwing: one badly labelled word must not turn an entire message
 * into an error the user cannot act on. `TextDecoder` without `fatal` replaces
 * the undecodable bytes instead of raising, which is what a mail client shows.
 */
function decodeBytes(bytes, charset) {
  const name = normalizeCharset(charset);
  try {
    return new TextDecoder(name, { fatal: false }).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
}

/** RFC 2047 `Q` encoding: `_` is a space and `=XX` is one byte. */
function decodeQEncoding(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeWord(charset, encoding, text) {
  const enc = String(encoding).toUpperCase();
  let bytes;
  if (enc === "B") {
    const base64 = text.replace(/\s+/g, "");
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      return text;
    }
  } else {
    bytes = decodeQEncoding(text);
  }
  return decodeBytes(bytes, charset);
}

/**
 * A `latin1` run that still holds 8-bit bytes is raw UTF-8 in practice.
 *
 * Some senders put a literal UTF-8 subject in the header without any encoded
 * word. Those bytes reached this module as `latin1`, so they are converted back
 * only when one is present.
 */
function decodeRawRun(text) {
  if (!/[\u0080-\u00ff]/.test(text)) return text;
  return decodeBytes(Buffer.from(text, "latin1"), "utf-8");
}

const ENCODED_WORD = /=\?([^?*\s]+)\?([bBqQ])\?([^?]*)\?=/g;

/**
 * Decode every encoded word in one header value.
 *
 * Whitespace between two adjacent encoded words is not a word gap — the sender
 * split one long string — so it is dropped, which is what RFC 2047 asks for.
 */
function decodeEncodedWords(value) {
  const source = String(value ?? "");
  const out = [];
  let last = 0;
  let previousWasEncoded = false;
  ENCODED_WORD.lastIndex = 0;
  for (;;) {
    const match = ENCODED_WORD.exec(source);
    if (!match) break;
    let between = source.slice(last, match.index);
    const separatorsOnly = /^[ \t]*$/.test(between);
    if (previousWasEncoded && separatorsOnly) between = "";
    out.push(decodeRawRun(between));
    out.push(decodeWord(match[1], match[2], match[3]));
    previousWasEncoded = true;
    last = match.index + match[0].length;
  }
  out.push(decodeRawRun(source.slice(last)));
  return out.join("");
}

/**
 * Split a raw header block into unfolded, lower-cased `name -> value` pairs.
 *
 * The value keeps its `latin1` bytes so `decodeHeaderValue` can decide the
 * charset; the split is on the raw bytes so no multi-byte sequence is broken.
 */
function parseHeaders(buffer) {
  const headers = new Map();
  if (!buffer || !buffer.length) return headers;
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer);
  const lines = text.split(/\r\n|\n|\r/);
  let current = null;
  const commit = () => {
    if (!current) return;
    const colon = current.indexOf(":");
    if (colon <= 0) {
      current = null;
      return;
    }
    const name = current.slice(0, colon).trim().toLowerCase();
    const value = current.slice(colon + 1).trim();
    if (!name) {
      current = null;
      return;
    }
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    current = null;
  };
  for (const line of lines) {
    if (!line) {
      commit();
      continue;
    }
    if (line[0] === " " || line[0] === "\t") {
      // Folded continuation of the previous header (RFC 5322 §2.2.3).
      if (current) current += ` ${line.trim()}`;
      continue;
    }
    commit();
    current = line;
  }
  commit();
  return headers;
}

function headerValue(headers, name) {
  const value = headers.get(String(name).toLowerCase());
  return value === undefined ? "" : decodeEncodedWords(value);
}

module.exports = {
  decodeBytes,
  decodeEncodedWords,
  decodeQEncoding,
  headerValue,
  normalizeCharset,
  parseHeaders,
};
