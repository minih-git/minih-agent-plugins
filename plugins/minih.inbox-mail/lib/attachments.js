"use strict";

/**
 * Which MIME part of one message holds an attachment, as the server numbers it.
 *
 * A download must not fetch the whole message: `UID FETCH <uid> BODY.PEEK[<part>]`
 * asks for exactly the bytes the user clicked, and the number in the brackets is
 * the one **RFC 3501** gives. Since 0.5.0 that number is the attachment's identity
 * everywhere — the panel's list, the save request and a forwarded attachment all
 * name a part, never a position in a list — because two parsers walk the same
 * message for different reasons: `lib/body.js` reads the bytes the panel shows and
 * `lib/attachments.js` reads the server's `BODYSTRUCTURE`. A list index means
 * different things to them the moment a message carries an inline image, a
 * `text/calendar` part or an unnamed part, and an index that shifts is a file the
 * user did not ask for.
 *
 * Two rules follow from the grammar (RFC 3501 §7.4.2) and are the whole reason
 * this is a module of its own:
 *
 * - a body is either a **leaf** (`type`, `subtype`, parameters, id, description,
 *   encoding, octets, …) or a **multipart**, which is a list whose first element
 *   is itself a list — the first child — and whose last element is its subtype;
 * - parts are numbered 1, 2, 3 in document order inside a multipart and nest as
 *   `1.2`; a message that is not multipart has one part, `1`.
 *
 * A `message/rfc822` part counts as an attachment (it is a forwarded message the
 * user can save) and is fetched whole, which is what saving an `.eml` should be.
 */

const body = require("./body");

/** How large one saved attachment may be: the same bound the save dialog applies. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** A structure this deep or this wide is not a message anyone typed. */
const MAX_PARTS = 200;
/** A section number, exactly as `BODY.PEEK[...]` accepts it. */
const PART_PATTERN = /^\d+(\.\d+)*$/;

function text(value, upper = false) {
  const result = typeof value === "string" ? value : "";
  return upper ? result.toUpperCase() : result;
}

/**
 * `("CHARSET" "UTF-8" "NAME*" "…")` -> a map, with RFC 2231 names already folded.
 *
 * A parameter list is name/value pairs in order, and RFC 2231 splits a long or
 * non-ASCII value into `name*0*`, `name*1*`, … A file name sent by a Chinese mail
 * client arrives that way and nowhere else, so reading only `filename` would report
 * an attachment with no name — which is exactly what makes a name comparison
 * impossible later.
 */
function params(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  const continuations = new Map();
  for (let index = 0; index + 1 < list.length; index += 2) {
    const key = text(list[index]).toLowerCase();
    const value = text(list[index + 1]);
    if (!key) continue;
    const extended = /^([^*]+)\*(\d+)\*?$/.exec(key);
    if (extended) {
      const holder = continuations.get(extended[1]) ?? new Map();
      holder.set(Number(extended[2]), { value, encoded: key.endsWith("*") });
      continuations.set(extended[1], holder);
      continue;
    }
    if (key.endsWith("*")) {
      // `filename*=UTF-8''…`: a whole value, charset first.
      map.set(key.slice(0, -1), decodeExtendedValue(value));
      continue;
    }
    map.set(key, value);
  }
  for (const [name, holder] of continuations) {
    const ordered = [...holder.entries()].sort((a, b) => a[0] - b[0]);
    const joined = ordered.map(([, entry]) => entry.value).join("");
    map.set(name, ordered[0][1].encoded ? decodeExtendedValue(joined) : joined);
  }
  return map;
}

/**
 * `UTF-8''%E6%8A%A5%E5%91%8A.pdf` -> `报告.pdf`.
 *
 * The percent-encoded part is decoded as UTF-8, which is what a client that sends
 * `filename*=UTF-8''…` sends; a value that is not valid percent-encoding is used as
 * it stands rather than thrown away, because a broken name is still better than
 * none.
 */
function decodeExtendedValue(value) {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(String(value ?? ""));
  const source = match ? match[3] : String(value ?? "");
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

/** `("ATTACHMENT" ("FILENAME" "x.pdf"))`, wherever it sits in the extension fields. */
function dispositionOf(node) {
  // The mandatory fields come first: type, subtype, parameters, id, description,
  // encoding, octets, then `lines` for a TEXT part. The extensions follow.
  const start = text(node[0], true) === "TEXT" ? 8 : 7;
  for (let index = start; index < node.length; index += 1) {
    const candidate = node[index];
    if (!Array.isArray(candidate)) continue;
    const kind = text(candidate[0], true);
    if (kind === "ATTACHMENT" || kind === "INLINE") return candidate;
  }
  return null;
}

function isMultipart(node) {
  return Array.isArray(node) && Array.isArray(node[0]);
}

function leafOf(node, part) {
  const type = text(node[0]).toLowerCase() || "application";
  const subtype = text(node[1]).toLowerCase() || "octet-stream";
  const mimeType = `${type}/${subtype}`;
  const encoding = text(node[5]).toLowerCase();
  const size = Number(text(node[6])) || 0;
  const disposition = dispositionOf(node);
  const dispositionParams = disposition ? params(disposition[1]) : new Map();
  const typeParams = params(node[2]);
  const name =
    dispositionParams.get("filename") ||
    typeParams.get("name") ||
    (mimeType === "message/rfc822" ? "attached-message.eml" : "");
  const attached = Boolean(disposition && text(disposition[0], true) === "ATTACHMENT") || Boolean(name);
  return { part, type: mimeType, encoding, size, name, attached };
}

/**
 * Every leaf of one `BODYSTRUCTURE`, in document order, with its part number.
 *
 * Nothing is filtered out here: a part that is not an attachment is still a part,
 * and a caller that asks for `1.2` gets `1.2` even when `1.2` is the body's own
 * `text/html`. Filtering belongs to the caller, which knows what it wants.
 *
 * @param structure the parsed `BODYSTRUCTURE` (or `BODY`) list from a FETCH.
 * @returns `[{ part, type, encoding, size, name, attached }]`
 */
function partsOf(structure, prefix = "", depth = 0) {
  // An empty list is not a leaf: it has neither a type nor children, so nothing
  // in it can be called a part.
  if (!Array.isArray(structure) || !structure.length || depth > 8) return [];
  if (!isMultipart(structure)) {
    return [leafOf(structure, prefix ? prefix.replace(/\.$/, "") : "1")];
  }
  const out = [];
  for (let index = 0; index < structure.length; index += 1) {
    // A multipart ends with its subtype as a string; anything after it is
    // extension data (its own disposition, language), not another part.
    if (typeof structure[index] === "string") break;
    const child = structure[index];
    if (!Array.isArray(child)) continue;
    const part = `${prefix}${index + 1}`;
    for (const entry of partsOf(child, `${part}.`, depth + 1)) {
      out.push(entry);
      if (out.length >= MAX_PARTS) return out;
    }
  }
  return out;
}

/** Whether one value is a section number this plugin will put in a command. */
function isPart(value) {
  return PART_PATTERN.test(String(value ?? ""));
}

/**
 * The leaf the server numbers `part`, or `null`.
 *
 * The number is compared as written (`1.2` ≠ `1.20`, `1` ≠ `1.1`), which is why it
 * is a string throughout and never parsed into a number.
 */
function partAt(structure, part) {
  const wanted = String(part ?? "").trim();
  if (!isPart(wanted)) return null;
  return partsOf(structure).find((entry) => entry.part === wanted) ?? null;
}

/**
 * Whether two names for the same part agree.
 *
 * An empty name on either side is not a disagreement: a message can carry a part
 * the panel called `attachment` and the server called nothing, and refusing to
 * save it over that would be worse than the small risk of a wrong name in a
 * dialog the user reads anyway.
 */
function sameName(left, right) {
  const one = String(left ?? "").trim().toLowerCase();
  const other = String(right ?? "").trim().toLowerCase();
  if (!one || !other) return true;
  return one === other;
}

/** What one part's base64 or quoted-printable bytes decode to. */
function decodePart(bytes, encoding) {
  return body.decodeTransfer(bytes, encoding);
}

/**
 * The name a saved file should be suggested with, bounded and printable.
 *
 * The host reduces whatever is suggested to one path segment, but a name with
 * control characters or a path separator would still be a surprise in the dialog.
 *
 * A part the sender never named is described by its type in the pane — `image/png`
 * — and a type is not a file name: `png` with no stem is not what anyone wants to
 * see in a save dialog, so the suggestion becomes `attachment.png`.
 */
function suggestedName(name, fallback = "attachment") {
  const raw = String(name ?? "").trim();
  const mime = /^[a-z0-9.+-]+\/([a-z0-9]{1,8})$/i.exec(raw);
  const source = mime ? `attachment.${mime[1].toLowerCase()}` : raw;
  const text = source
    .split(/[/\\]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (!text || text === "." || text === "..") return fallback;
  return text.length > 180 ? text.slice(-180) : text;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  PART_PATTERN,
  decodePart,
  isPart,
  partAt,
  partsOf,
  sameName,
  suggestedName,
};