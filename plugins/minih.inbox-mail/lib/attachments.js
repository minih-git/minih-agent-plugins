"use strict";

/**
 * Which MIME part of one message holds an attachment, as the server numbers it.
 *
 * A download must not fetch the whole message: `UID FETCH <uid> BODY.PEEK[<part>]`
 * asks for exactly the bytes the user clicked, and the number in the brackets is
 * the one `BODYSTRUCTURE` gives. That is why this module reads the structure the
 * server sent rather than trusting the panel's list — the structure is the
 * server's own statement about its own message.
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

function text(value, upper = false) {
  const result = typeof value === "string" ? value : "";
  return upper ? result.toUpperCase() : result;
}

function params(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (let index = 0; index + 1 < list.length; index += 2) {
    const key = text(list[index]).toLowerCase();
    const value = text(list[index + 1]);
    if (key) map.set(key, value);
  }
  return map;
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
 * @param structure the parsed `BODYSTRUCTURE` (or `BODY`) list from a FETCH.
 * @returns `[{ part, type, encoding, size, name, attached }]`
 */
function partsOf(structure, prefix = "", depth = 0) {
  if (!Array.isArray(structure) || depth > 8) return [];
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

/**
 * The attachment at `index` (the position in the panel's list), or `null`.
 *
 * An `inline` part with a file name counts, because that is how a phone attaches
 * a photo, and the panel lists it for the same reason.
 */
function attachmentAt(structure, index) {
  const wanted = Number(index);
  if (!Number.isInteger(wanted) || wanted < 0) return null;
  const attachments = partsOf(structure).filter((entry) => entry.attached);
  return attachments[wanted] ?? null;
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
 */
function suggestedName(name, fallback = "attachment") {
  const text = String(name ?? "")
    .split(/[/\\]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (!text || text === "." || text === "..") return fallback;
  return text.length > 180 ? text.slice(-180) : text;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  attachmentAt,
  decodePart,
  partsOf,
  suggestedName,
};