import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "view", "terminal.css"), "utf8");

test("a hidden element cannot keep its box", () => {
  // `#start` sets `display: flex`, and an author `display` rule outranks the UA
  // sheet's `[hidden] { display: none }`. Without an author-level rule the start
  // form stayed on screen next to a running terminal and kept its flex space,
  // squeezing the panes into the bottom of the page.
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "the stylesheet needs an author-level [hidden] rule",
  );
  // The rule is only load-bearing while elements the page hides also set
  // `display`; if this stops being true the comment above is wrong.
  assert.match(css, /#start\s*\{[^}]*display:\s*flex/);
});

test("the start dialog floats over the panes instead of sharing their flow", () => {
  // A dialog in the page flow resized a running terminal every time it opened,
  // which is what made the old inline form look broken; it must be an overlay.
  assert.match(css, /#modal\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(
    css,
    /#start\s*\{[^}]*flex:\s*0 0 auto/,
    "the form must not claim a share of the page's flex flow",
  );
});
test("the terminal theme only uses colors xterm can parse", () => {
  // xterm parses its own theme colors and cannot read CSS functions. A value it
  // cannot parse degrades to an opaque block: `color-mix(...)` for the selection
  // became white on a white background, so selecting text showed no highlight.
  const values = [...css.matchAll(/--term-[\w-]+:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(values.length >= 8, `expected both palettes, found ${values.length}`);
  for (const value of values) {
    assert.match(value, /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i, value);
  }
});
