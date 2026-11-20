"use strict";

/**
 * IMAP4rev1 wire parsing, and nothing else.
 *
 * The host performs the login, so the first byte this plugin sees is whatever
 * the server sends after the tagged `OK`, and the last thing it sends is
 * `LOGOUT`. Everything in between is a byte stream that arrives in arbitrary
 * chunks: a response may be split across two TCP reads, and two responses may
 * arrive in one. `createParser().push(chunk)` therefore buffers until a whole
 * response is present and hands back complete token lists, in order.
 *
 * Two details make a naive line splitter wrong, and both are load-bearing here:
 *
 * - A literal is `{123}\r\n` followed by exactly 123 raw bytes that may contain
 *   CRLF, brackets and anything else. It can itself be split across reads, so
 *   the parser waits for the declared length.
 * - A section such as `BODY[HEADER.FIELDS (FROM SUBJECT)]` carries spaces and
 *   parentheses inside `[...]`. Those brackets are part of one atom, not list
 *   delimiters.
 *
 * Values are returned as `latin1` strings so no byte is lost on the way to
 * `lib/mime.js`, which decides the charset; literals stay `Buffer`s because
 * their charset is declared inside them, not on the wire.
 */

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const LPAREN = 0x28;
const RPAREN = 0x29;
const DQUOTE = 0x22;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const PLUS = 0x2b;
const BACKSLASH = 0x5c;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

function isDigit(byte) {
  return byte >= 0x30 && byte <= 0x39;
}

/** `{n}` or `{n+}` followed by CRLF. `null` means "need more bytes". */
function parseLiteral(buf, start) {
  let i = start + 1;
  let digits = "";
  while (i < buf.length && isDigit(buf[i])) {
    digits += String.fromCharCode(buf[i]);
    i += 1;
  }
  if (!digits) return { invalid: true };
  if (i >= buf.length) return null;
  if (buf[i] === PLUS) {
    i += 1;
    if (i >= buf.length) return null;
  }
  if (buf[i] !== RBRACE) return { invalid: true };
  i += 1;
  if (i >= buf.length) return null;
  if (buf[i] === CR) {
    if (i + 1 >= buf.length) return null;
    if (buf[i + 1] !== LF) return { invalid: true };
    i += 2;
  } else if (buf[i] === LF) {
    i += 1;
  } else {
    return { invalid: true };
  }
  const size = Number(digits);
  if (buf.length < i + size) return null;
  return { value: buf.subarray(i, i + size), next: i + size };
}

/** A quoted string, unescaped, back as latin1 so the bytes survive. */
function parseQuoted(buf, start) {
  const bytes = [];
  let i = start;
  while (i < buf.length) {
    const byte = buf[i];
    if (byte === BACKSLASH) {
      if (i + 1 >= buf.length) return null;
      bytes.push(buf[i + 1]);
      i += 2;
      continue;
    }
    if (byte === DQUOTE) {
      return { value: Buffer.from(bytes).toString("latin1"), next: i + 1 };
    }
    bytes.push(byte);
    i += 1;
  }
  return null;
}

/**
 * An atom, including a `[...]` section suffix.
 *
 * A tracker is worth nothing if it cannot read a response, so the bracket depth
 * is tracked here rather than in the caller: `BODY[HEADER.FIELDS (DATE)]` is one
 * atom, while `BODY[]` and `HEADER.FIELDS` alone would be split by a tokenizer
 * that stopped at the first space.
 */
function parseAtom(buf, start) {
  let i = start;
  let depth = 0;
  while (i < buf.length) {
    const byte = buf[i];
    if (depth > 0) {
      if (byte === LBRACKET) depth += 1;
      else if (byte === RBRACKET) depth -= 1;
      i += 1;
      continue;
    }
    if (byte === LBRACKET) {
      depth = 1;
      i += 1;
      continue;
    }
    if (byte === SP || byte === CR || byte === LF || byte === LPAREN || byte === RPAREN) break;
    i += 1;
  }
  // A trailing fragment may still grow into a longer atom, so it is incomplete
  // rather than final: `BODY[HEADER` must not be handed out as a section name.
  if (i >= buf.length) return null;
  if (i === start) return null;
  return { value: buf.toString("latin1", start, i), next: i };
}

/** A parenthesised list, recursively. `next` points just past the `)`. */
function parseList(buf, start) {
  const values = [];
  let i = start;
  for (;;) {
    while (i < buf.length && buf[i] === SP) i += 1;
    if (i >= buf.length) return null;
    const byte = buf[i];
    if (byte === RPAREN) return { value: values, next: i + 1 };
    if (byte === CR || byte === LF) {
      // A list cannot contain a bare line break; treat it as the end so a broken
      // peer cannot spin the parser forever.
      return { value: values, next: i };
    }
    const token = parseToken(buf, i);
    if (!token) return null;
    values.push(token.value);
    i = token.next;
  }
}

function parseToken(buf, start) {
  const byte = buf[start];
  if (byte === LPAREN) return parseList(buf, start + 1);
  if (byte === DQUOTE) return parseQuoted(buf, start + 1);
  if (byte === LBRACE) {
    const literal = parseLiteral(buf, start);
    if (literal === null) return null;
    if (literal.invalid) {
      const atom = parseAtom(buf, start);
      return atom;
    }
    return literal;
  }
  return parseAtom(buf, start);
}

/** One complete response: tokens, plus the offset just past its CRLF. */
function parseResponse(buf, start) {
  const tokens = [];
  let i = start;
  for (;;) {
    while (i < buf.length && buf[i] === SP) i += 1;
    if (i >= buf.length) return null;
    const byte = buf[i];
    if (byte === CR) {
      if (i + 1 >= buf.length) return null;
      if (buf[i + 1] === LF) return { value: tokens, next: i + 2 };
      i += 1;
      continue;
    }
    if (byte === LF) return { value: tokens, next: i + 1 };
    if (byte === RPAREN) {
      // Unbalanced `)`: end the response here instead of looping on it.
      return { value: tokens, next: i + 1 };
    }
    const token = parseToken(buf, i);
    if (!token) return null;
    tokens.push(token.value);
    i = token.next;
  }
}

function createParser() {
  let buffer = Buffer.alloc(0);
  return {
    /** Feed one chunk; get back every response that is now complete. */
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
      const responses = [];
      for (;;) {
        const parsed = parseResponse(buffer, 0);
        if (!parsed) break;
        responses.push(parsed.value);
        buffer = buffer.subarray(parsed.next);
      }
      return responses;
    },
    /** Bytes held back for an incomplete response; used by the parser's tests. */
    pending() {
      return buffer.length;
    },
  };
}

/** `cont` for a continuation, `untagged` for `*`, otherwise the command tag. */
function kindOf(tokens) {
  const first = tokens[0];
  if (typeof first !== "string") return "unknown";
  if (first === "+") return "cont";
  if (first === "*") return "untagged";
  return "tagged";
}

/** `[UIDVALIDITY 42]` and friends, as `{ name, args }`. */
function parseResponseCode(tokens, from) {
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== "string") continue;
    const match = /^\[([A-Za-z0-9-]+)(?:\s+(.*))?\]$/.exec(token);
    if (!match) continue;
    return { name: match[1].toUpperCase(), args: match[2] ?? "" };
  }
  return null;
}

function addressFromList(list) {
  if (!Array.isArray(list)) return null;
  const [name, , mailbox, host] = list;
  const text = (value) => (typeof value === "string" ? value : "");
  const address = host ? `${text(mailbox)}@${text(host)}` : text(mailbox);
  return { name: text(name), address };
}

function addressesFromList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(addressFromList).filter((entry) => entry && entry.address);
}

/**
 * ENVELOPE is ten positional fields; only the six this plugin uses are read, and
 * they are read by position because that is the only thing the server sends.
 */
function parseEnvelope(list) {
  if (!Array.isArray(list)) return null;
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    date: text(list[0]),
    subject: text(list[1]),
    from: addressesFromList(list[2]),
    sender: addressesFromList(list[3]),
    replyTo: addressesFromList(list[4]),
    messageId: text(list[9]).trim(),
  };
}

function readFetchItems(list) {
  const item = { flags: [], uid: null, internalDate: null, envelope: null, headers: null };
  for (let i = 0; i < list.length; i += 1) {
    const key = list[i];
    const value = list[i + 1];
    if (typeof key !== "string") continue;
    const upper = key.toUpperCase();
    if (upper === "UID") {
      item.uid = typeof value === "string" ? Number(value) : null;
      i += 1;
      continue;
    }
    if (upper === "FLAGS") {
      item.flags = Array.isArray(value) ? value.filter((flag) => typeof flag === "string") : [];
      i += 1;
      continue;
    }
    if (upper === "INTERNALDATE") {
      item.internalDate = typeof value === "string" ? value : null;
      i += 1;
      continue;
    }
    if (upper === "ENVELOPE") {
      item.envelope = parseEnvelope(value);
      i += 1;
      continue;
    }
    // The server echoes the section without the `.PEEK` that asked for it, so
    // the check is on the prefix, not on an exact name.
    if (upper.startsWith("BODY[") || upper.startsWith("RFC822.HEADER")) {
      item.headers = Buffer.isBuffer(value) ? value : null;
      i += 1;
      continue;
    }
  }
  return item;
}

/**
 * One untagged response as a small record.
 *
 * Only the shapes this plugin acts on get a `kind` of their own; everything else
 * is `other` with its tokens kept, so nothing a server sends is silently
 * misread as data.
 */
function parseUntagged(tokens) {
  const second = tokens[1];
  // `* 5 EXISTS` and `* 12 FETCH (…)` begin with a decimal count, which is an
  // atom on the wire and therefore a string here.
  if (typeof second === "string" && /^[0-9]+$/.test(second)) {
    const count = Number(second);
    const third = typeof tokens[2] === "string" ? tokens[2].toUpperCase() : "";
    if (third === "EXISTS") return { kind: "exists", count };
    if (third === "EXPUNGE") return { kind: "expunge", count };
    if (third === "RECENT") return { kind: "recent", count };
    if (third === "FETCH") return { kind: "fetch", index: count, item: readFetchItems(tokens[3] ?? []) };
    return { kind: "other", name: third, tokens };
  }
  if (typeof second === "string") {
    const upper = second.toUpperCase();
    if (upper === "OK" || upper === "NO" || upper === "BAD" || upper === "BYE" || upper === "PREAUTH") {
      const code = parseResponseCode(tokens, 2);
      const number = code ? /^([0-9]+)$/.exec(code.args.trim()) : null;
      return {
        kind: "status",
        status: upper,
        code: code ? code.name : null,
        value: number ? Number(number[1]) : null,
        text: tokens
          .slice(2)
          .filter((token) => typeof token === "string")
          .join(" "),
      };
    }
    if (upper === "CAPABILITY") {
      return {
        kind: "capability",
        values: tokens.slice(2).filter((token) => typeof token === "string"),
      };
    }
    if (upper === "SEARCH") {
      return {
        kind: "search",
        uids: tokens.slice(2).filter((token) => typeof token === "string").map(Number),
      };
    }
    return { kind: "other", name: upper, tokens };
  }
  return { kind: "other", name: "", tokens };
}

/**
 * The status line of a tagged response, `A1 OK [READ-WRITE] done`.
 *
 * A `NO` or `BAD` is a failure the caller must see: a refused `SELECT` and a
 * refused `FETCH` are different problems, and the second is not a mailbox that
 * happens to be empty.
 */
function parseTagged(tokens) {
  const status = typeof tokens[1] === "string" ? tokens[1].toUpperCase() : "";
  return {
    status,
    text: tokens
      .slice(1)
      .filter((token) => typeof token === "string")
      .join(" "),
  };
}

module.exports = {
  createParser,
  kindOf,
  parseEnvelope,
  parseResponseCode,
  parseTagged,
  parseUntagged,
  readFetchItems,
};
