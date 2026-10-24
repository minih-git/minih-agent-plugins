"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const css = fs.readFileSync(path.join(__dirname, "../renderer/panel.css"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(?:^|\n)${escaped}\\s*\\{([^}]+)\\}`, "g"))];
  const match = matches.at(-1);
  assert.ok(match, `${selector} must have a style rule`);
  return match[1];
}

test("the transparent host drag band has a fixed opaque page surface", () => {
  // Body padding only reserves initial space: it scrolls away with the page.
  const mask = rule("body::before");
  assert.match(mask, /content:\s*""/);
  assert.match(mask, /position:\s*fixed/);
  assert.match(mask, /inset:\s*0 0 auto 0/);
  assert.match(mask, /height:\s*var\(--pi-plugin-titlebar-height,\s*46px\)/);
  assert.match(mask, /background:\s*var\(--bg\)/);
});

test("the titlebar surface covers page content without intercepting host controls", () => {
  const mask = rule("body::before");
  const toolbar = rule(".toolbar");
  assert.match(mask, /pointer-events:\s*none/);
  const maskLayer = Number(mask.match(/z-index:\s*(\d+)/)?.[1]);
  const toolbarLayer = Number(toolbar.match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(maskLayer > toolbarLayer, "the titlebar surface stays above scrolling content");
  assert.ok(maskLayer < 2147483647, "the host window controls retain their top layer");
});

test("the page and toolbar retain the same host-controlled top offset", () => {
  assert.match(rule("body"), /padding-top:\s*var\(--pi-plugin-titlebar-height,\s*46px\)/);
  assert.match(rule(".toolbar"), /position:\s*sticky/);
  assert.match(rule(".toolbar"), /top:\s*var\(--pi-plugin-titlebar-height,\s*46px\)/);
});
