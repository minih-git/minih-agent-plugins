import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOCKED_SELECTOR,
  MAX_SELECTION_CHARS,
  anchorOfRange,
  anchorOfRect,
  isBlockedElement,
  isTranslateShortcut,
  normalizeSelectedText,
  placeFloating,
  readSelectionSnapshot,
} from "../renderer/selection.mjs";

const rect = (top, left, width = 120, height = 18) => ({
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

/** A window whose only job is to answer one selection. */
function fakeWindow({ text, anchor = rect(100, 40), blocked = false, connected = true }) {
  const range = {
    commonAncestorContainer: { nodeType: 1, closest: () => (blocked ? {} : null) },
    startContainer: { isConnected: connected },
    getClientRects: () => [anchor],
    getBoundingClientRect: () => anchor,
    cloneRange: () => range,
  };
  const selection = {
    isCollapsed: text === "",
    rangeCount: text === "" ? 0 : 1,
    toString: () => text,
    getRangeAt: () => range,
  };
  return { getSelection: () => selection };
}

test("a selection is trimmed and kept verbatim otherwise", () => {
  assert.equal(normalizeSelectedText("  The model answered in English.  ").text, "The model answered in English.");
  assert.equal(normalizeSelectedText("a\r\nb").text, "a\nb");
});

test("nothing worth translating yields an empty text", () => {
  for (const value of ["", "   \n ", "a", " . ", null, undefined, 7]) {
    assert.equal(normalizeSelectedText(value).text, "", `unexpected text for ${JSON.stringify(value)}`);
  }
});

test("a long selection is capped and flagged", () => {
  const long = normalizeSelectedText("word ".repeat(MAX_SELECTION_CHARS));
  assert.equal(long.text.length, MAX_SELECTION_CHARS);
  assert.equal(long.truncated, true);
});

test("an anchor is a plain rect, and a broken one is nothing", () => {
  assert.deepEqual(anchorOfRect(rect(10, 20, 30, 40)), {
    top: 10,
    left: 20,
    right: 50,
    bottom: 50,
    width: 30,
    height: 40,
  });
  assert.equal(anchorOfRect(null), null);
  assert.equal(anchorOfRect({ top: Number.NaN, left: 0 }), null);
});

test("the shortcut is Option+E or Alt+E on the physical key", () => {
  const press = (over = {}) => ({ altKey: true, code: "KeyE", key: "e", ...over });
  assert.equal(isTranslateShortcut(press()), true);
  // macOS turns Option+E into a dead key: `key` is "Dead", `code` still is not.
  assert.equal(isTranslateShortcut(press({ key: "Dead" })), true);
  // A synthetic event without `code` still works through the letter.
  assert.equal(isTranslateShortcut({ altKey: true, key: "E" }), true);
  assert.equal(isTranslateShortcut({ altKey: true, key: "e" }), true);
});

test("every other press is left alone", () => {
  assert.equal(isTranslateShortcut({ code: "KeyE", key: "e" }), false, "no Alt");
  assert.equal(isTranslateShortcut({ altKey: true, ctrlKey: true, code: "KeyE" }), false);
  assert.equal(isTranslateShortcut({ altKey: true, metaKey: true, code: "KeyE" }), false);
  assert.equal(isTranslateShortcut({ altKey: true, shiftKey: true, code: "KeyE" }), false);
  assert.equal(isTranslateShortcut({ altKey: true, code: "KeyQ", key: "q" }), false);
  // Holding the key down translates once, not on every repeat.
  assert.equal(isTranslateShortcut({ altKey: true, code: "KeyE", repeat: true }), false);
  // An IME owns the keystroke while it is composing.
  assert.equal(isTranslateShortcut({ altKey: true, code: "KeyE", isComposing: true }), false);
  assert.equal(isTranslateShortcut(null), false);
  assert.equal(isTranslateShortcut(undefined), false);
});

test("the pill goes below the selection when there is room", () => {
  const placement = placeFloating({
    anchor: anchorOfRect(rect(100, 40, 120, 18)),
    size: { width: 70, height: 26 },
    viewport: { width: 1200, height: 800 },
  });
  assert.deepEqual(placement, { top: 126, left: 40 });
});

test("a selection near the bottom flips the box above itself", () => {
  const placement = placeFloating({
    anchor: anchorOfRect(rect(760, 40, 120, 18)),
    size: { width: 70, height: 26 },
    viewport: { width: 1200, height: 800 },
  });
  assert.equal(placement.top, 726);
});

test("a box is kept inside the window, not off the right edge", () => {
  const placement = placeFloating({
    anchor: anchorOfRect(rect(100, 1180, 20, 18)),
    size: { width: 400, height: 200 },
    viewport: { width: 1200, height: 800 },
  });
  assert.equal(placement.left, 792);
  assert.ok(placement.top >= 8 && placement.top + 200 <= 792);
});

test("a card taller than the window still starts inside it", () => {
  const placement = placeFloating({
    anchor: anchorOfRect(rect(400, 40, 120, 18)),
    size: { width: 400, height: 900 },
    viewport: { width: 1200, height: 800 },
  });
  assert.equal(placement.top, 8);
});

test("fields, editors and the plugin's own card are not sources of prose", () => {
  assert.equal(isBlockedElement({ closest: () => null }), false);
  assert.equal(isBlockedElement({ closest: () => ({}) }), true);
  assert.equal(isBlockedElement(null), true);
  assert.match(BLOCKED_SELECTOR, /\[contenteditable\]/);
  assert.match(BLOCKED_SELECTOR, /\.xterm/);
});

test("the snapshot carries the text, where it is, and a range to follow it", () => {
  const snapshot = readSelectionSnapshot(fakeWindow({ text: "Thinking models answer in English." }));
  assert.equal(snapshot.text, "Thinking models answer in English.");
  assert.equal(snapshot.anchor.top, 100);
  assert.ok(snapshot.range);
  assert.equal(snapshot.truncated, false);
});

test("a selection inside a blocked area, or a dismantled one, is ignored", () => {
  assert.equal(readSelectionSnapshot(fakeWindow({ text: "Inside the composer", blocked: true })), null);
  assert.equal(readSelectionSnapshot(fakeWindow({ text: "" })), null);
  assert.equal(readSelectionSnapshot(fakeWindow({ text: "A gone row", connected: false })), null);
  assert.equal(readSelectionSnapshot({ getSelection: () => null }), null);
  assert.equal(readSelectionSnapshot(undefined), null);
});

test("a saved range answers where it is now, and dies with its node", () => {
  assert.equal(anchorOfRange(null), null);
  assert.equal(anchorOfRange({ startContainer: { isConnected: false }, getClientRects: () => [rect(0, 0)] }), null);
  assert.deepEqual(
    anchorOfRange({ startContainer: {}, getClientRects: () => [rect(5, 6, 7, 8)] }),
    { top: 5, left: 6, right: 13, bottom: 13, width: 7, height: 8 },
  );
});