import { parseDocument } from "./vendor/yaml.mjs";

/**
 * Frontmatter handling built on the vendored `yaml` package.
 *
 * Unlike the 0.1.x single-line parser, this reads block lists correctly and
 * keeps the parsed `Document` so a frontmatter patch (§8 of ADR 0001) can
 * preserve the order, formatting, and comments of untouched keys.
 */

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(?:\r?\n|$)/m;

/**
 * Split a note into its frontmatter block and body.
 * Returns `{ present, text, body, bodyStart }` where `text` is the YAML source
 * between the markers (without them) and `body` starts right after the closing
 * marker, byte-for-byte as in the original content.
 */
export function extractFrontmatter(content) {
  const open = OPEN.exec(content);
  if (!open) return { present: false, text: "", body: content, bodyStart: 0 };
  const start = open[0].length;
  const rest = content.slice(start);
  const close = CLOSE.exec(rest);
  if (!close) return { present: false, text: "", body: content, bodyStart: 0 };
  return {
    present: true,
    text: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
    bodyStart: start + close.index + close[0].length,
  };
}

/**
 * Parse a note's frontmatter. A note whose frontmatter fails to parse keeps
 * `data: {}` and is flagged `invalid` — it is never rejected on read.
 */
export function parseFrontmatter(content) {
  const block = extractFrontmatter(content);
  if (!block.present) {
    return { present: false, data: {}, doc: null, invalid: false, error: null, body: content };
  }
  try {
    const doc = parseDocument(block.text);
    const errors = doc.errors ?? [];
    if (errors.length > 0) {
      return { present: true, data: {}, doc, invalid: true, error: errors[0].message, body: block.body };
    }
    let data = doc.toJS();
    if (data === null || typeof data !== "object" || Array.isArray(data)) data = {};
    return { present: true, data, doc, invalid: false, error: null, body: block.body };
  } catch (error) {
    return {
      present: true,
      data: {},
      doc: null,
      invalid: true,
      error: error instanceof Error ? error.message : String(error),
      body: block.body,
    };
  }
}

/**
 * Apply a `{ key: newValue | null }` patch through the parsed YAML Document so
 * other keys, their order, and comments survive. Returns the new frontmatter
 * source (without the `---` markers, trailing newline included) or `null` when
 * nothing changed. The body is never touched here.
 */
export function patchFrontmatterSource(parsed, patch) {
  const entries = Object.entries(patch ?? {});
  if (entries.length === 0) return null;
  if (parsed.present && parsed.doc && !parsed.invalid) {
    const doc = parsed.doc;
    let changed = false;
    for (const [key, value] of entries) {
      if (value === null || value === undefined) {
        if (doc.has(key)) {
          doc.delete(key);
          changed = true;
        }
        continue;
      }
      doc.set(key, value);
      changed = true;
    }
    if (!changed) return null;
    let text = String(doc);
    if (text !== "" && !text.endsWith("\n")) text = `${text}\n`;
    return text;
  }
  // No frontmatter (or unreadable): build a fresh block from the patch.
  const fresh = {};
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined) fresh[key] = value;
  }
  const doc = parseDocument("");
  for (const [key, value] of Object.entries(fresh)) doc.set(key, value);
  let text = String(doc);
  if (text !== "" && !text.endsWith("\n")) text = `${text}\n`;
  return text;
}

/** Compose a full note from a frontmatter source and an untouched body. */
export function composeNote(frontmatterText, body) {
  const bodyText = body === "" ? "" : body;
  return `---\n${frontmatterText}---\n${bodyText}`;
}
