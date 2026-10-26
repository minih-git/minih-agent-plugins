/**
 * Reading a selection and placing a floating box under it.
 *
 * Everything except `readSelectionSnapshot` is plain data in, plain data out, so
 * the rules — what counts as translatable, and where a box goes when the
 * selection sits at the edge of the window — are unit tested in node without a
 * browser.
 *
 * Read-only throughout: nothing here writes to the DOM, and the transcript's
 * selection is the host's own; this module only looks at it.
 */

/** Longest selection one translation carries; the plugin process caps too. */
export const MAX_SELECTION_CHARS = 8000;

/**
 * Areas where a selection is not prose to translate: form fields, editors (the
 * composer, the CodeMirror views), the terminal, and this plugin's own card.
 */
export const BLOCKED_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  ".xterm",
  ".cm-editor",
  "[data-pi-translate-ui]",
].join(", ");

/**
 * The text of a selection, or `""` when there is nothing worth sending.
 * CRLF is normalized so the model sees the same text on every platform, and a
 * very long selection is capped instead of being refused: a reader who selected
 * three paragraphs still gets the first part translated, with `truncated` set
 * so the card can say so.
 */
export function normalizeSelectedText(raw) {
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) return { text: "" };
  // One letter or one punctuation mark is not prose; a stray click-drag in the
  // margins would otherwise pop a pill over the interface.
  if (text.replace(/\s/g, "").length < 2) return { text: "" };
  if (text.length > MAX_SELECTION_CHARS) {
    return { text: text.slice(0, MAX_SELECTION_CHARS), truncated: true };
  }
  return { text };
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** A DOMRect-like value reduced to what placement needs; `null` when empty. */
export function anchorOfRect(rect) {
  if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.left)) return null;
  const width = Number.isFinite(rect.width) ? rect.width : 0;
  const height = Number.isFinite(rect.height) ? rect.height : 0;
  return {
    top: rect.top,
    left: rect.left,
    right: Number.isFinite(rect.right) ? rect.right : rect.left + width,
    bottom: Number.isFinite(rect.bottom) ? rect.bottom : rect.top + height,
    width,
    height,
  };
}

/**
 * Where a floating box of `size` goes for `anchor`: below the anchor when it
 * fits, above it otherwise, and always inside the window. `margin` keeps it off
 * the window edges; the host's own selection pill sits above a selection, so
 * "below" is the default and the two do not overlap.
 */
export function placeFloating({ anchor, size, viewport, gap = 8, margin = 8 }) {
  if (!anchor || !size || !viewport) return null;
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const fitsAbove = above >= margin;
  let top = fitsBelow || !fitsAbove ? below : above;
  top = clamp(top, margin, viewport.height - margin - size.height);
  const left = clamp(anchor.left, margin, viewport.width - margin - width);
  return { top, left };
}

function elementOf(node) {
  if (!node) return null;
  if (node.nodeType === 1) return node;
  return node.parentElement ?? node.parentNode ?? null;
}

/** True inside a field, an editor, the terminal, or this plugin's own card. */
export function isBlockedElement(element) {
  if (!element || typeof element.closest !== "function") return true;
  return element.closest(BLOCKED_SELECTOR) !== null;
}

/**
 * The current selection as `{ text, anchor, range, truncated }`, or `null`.
 * A cloned range travels with the snapshot: the card keeps following its
 * selection while the transcript scrolls, which the DOM itself can answer long
 * after the live selection was replaced by the next click.
 */
export function readSelectionSnapshot(win) {
  const selection = win?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const normalized = normalizeSelectedText(selection.toString());
  if (!normalized.text) return null;
  const range = selection.getRangeAt(0);
  if (isBlockedElement(elementOf(range.commonAncestorContainer))) return null;
  const anchor = anchorOfRange(range);
  if (!anchor) return null;
  return { text: normalized.text, truncated: normalized.truncated === true, anchor, range: range.cloneRange() };
}

/** Where a saved range is right now, or `null` when it was unmounted. */
export function anchorOfRange(range) {
  if (!range || typeof range.getClientRects !== "function") return null;
  if (range.startContainer?.isConnected === false) return null;
  const rects = range.getClientRects();
  const last = rects && rects.length ? rects[rects.length - 1] : null;
  return anchorOfRect(last ?? (typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null));
}