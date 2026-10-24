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