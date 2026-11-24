import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FRAME_SANDBOX,
  buildFrameDocument,
  classifyLink,
  frameCsp,
  isRemoteUrl,
} from "../view/policy.js";

/**
 * The reading pane's security policy, asserted where it can be asserted without
 * a browser: the strings that decide what the frame may do.
 *
 * The behaviour itself — a script does not run, a remote image does not load — is
 * checked in a real renderer, because a policy that is only compared to itself
 * proves nothing. What is checked here is that the policy cannot drift by
 * accident: no `allow-scripts`, no remote source in the default CSP, no link the
 * panel would navigate to.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(join(root, "view/app.js"), "utf8");
const indexSource = readFileSync(join(root, "view/index.html"), "utf8");
const styleSource = readFileSync(join(root, "view/styles.css"), "utf8");

/**
 * One declaration block by selector, for asserting a rule without a browser.
 *
 * Anchored to the start of a line: `.reader` also appears inside the grouped
 * `.accounts, .list, .reader` rule, and a substring search would assert on that
 * one instead of the rule that paints the column.
 */
function ruleBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped} \\{[^}]*\\}`, "gm");
  // A selector can be declared more than once (layout, then paint); the union is
  // what the browser applies, so the union is what this asserts on.
  return (styleSource.match(pattern) ?? []).join("\n");
}

test("the frame is an empty sandbox: no scripts, no same origin", () => {
  assert.equal(FRAME_SANDBOX, "");
  assert.equal(appSource.includes("allow-scripts"), false);
  assert.equal(appSource.includes("allow-same-origin"), false);
  assert.match(appSource, /setAttribute\("sandbox", FRAME_SANDBOX\)/);
});

test("the default CSP loads nothing remote, and the image variant is explicit", () => {
  const blocked = frameCsp(false);
  assert.match(blocked, /default-src 'none'/);
  assert.match(blocked, /img-src data:/);
  assert.equal(/https?:/.test(blocked), false, "the default view makes no remote request");
  assert.match(blocked, /form-action 'none'/);
  const allowed = frameCsp(true);
  assert.match(allowed, /img-src data: https: http:/);
  assert.equal(/script-src/.test(blocked), false, "no script source is granted at all");
});

test("a message body is wrapped in a document that carries its own CSP", () => {
  const document = buildFrameDocument({ html: "<p>hi</p>", allowImages: false, theme: "light" });
  assert.match(document, /^<!doctype html>/);
  assert.match(document, /http-equiv="Content-Security-Policy"/);
  assert.ok(document.includes(frameCsp(false)));
  assert.ok(document.includes("<p>hi</p>"));
  assert.match(document, /color-scheme: light/);
  // The dark frame is a different document, not a different attribute.
  assert.match(buildFrameDocument({ html: "", allowImages: false, theme: "dark" }), /color-scheme: dark/);
});

test("only http, https and mailto links are treated as openable", () => {
  assert.equal(classifyLink("https://example.com/a"), "http");
  assert.equal(classifyLink("http://example.com"), "http");
  assert.equal(classifyLink("mailto:a@b.c"), "mailto");
  assert.equal(classifyLink("javascript:alert(1)"), null);
  assert.equal(classifyLink("file:///etc/passwd"), null);
  assert.equal(classifyLink(""), null);
});

test("remote means off the machine, including a protocol-relative URL", () => {
  assert.equal(isRemoteUrl("https://tracker.example/p.gif"), true);
  assert.equal(isRemoteUrl("//tracker.example/p.gif"), true);
  assert.equal(isRemoteUrl("data:image/gif;base64,AAA"), false);
  assert.equal(isRemoteUrl("cid:abc"), false);
  assert.equal(isRemoteUrl(""), false);
});

test("the panel page allows its own scripts and the srcdoc frame, nothing else", () => {
  const csp = /content="([^"]*default-src[^"]*)"/.exec(indexSource)?.[1] ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
});

test("the vendored sanitizer is present, pinned, and licensed", () => {
  const vendor = join(root, "view/vendor");
  const source = readFileSync(join(vendor, "purify.es.mjs"), "utf8");
  assert.match(source, /@license DOMPurify 3\.2\.7/);
  assert.equal(statSync(join(vendor, "DOMPurify-LICENSE.txt")).isFile(), true);
  assert.match(readFileSync(join(vendor, "README.md"), "utf8"), /3\.2\.7/);
  // Sanitizing is not optional and is done before the frame is built.
  assert.match(appSource, /import \{ prepareBody \} from "\.\/sanitize\.js"/);
  assert.match(appSource, /prepareBody\(message\.html \?\? ""\)/);
});

/**
 * The panel is a **docked view**, and the host deliberately makes a view's root
 * transparent (`resetEmbeddedSurfaceChrome` in `electron/preload/plugin-panel.ts`
 * sets an inline `background: transparent` on `html` and `body`) so its own
 * surface shows through. Chromium's default surface is white, so any region that
 * relies on the body background turns white in a dark app — which is exactly how
 * 0.2.0 shipped a white mail column and an unreadable translucent banner in the
 * 1.9.0 candidate. These assertions keep every surface and control owned by the
 * page's own tokens.
 */
test("the page paints its own canvas instead of trusting body to be opaque", () => {
  const app = ruleBlock(".app");
  assert.match(app, /background:\s*var\(--bg\)/, "the app surface must be opaque");
  const list = ruleBlock(".list");
  assert.match(list, /background:\s*var\(--bg\)/, "the mail column must not be transparent");
  // The regions with their own tokens stay opaque too.
  for (const selector of [".topbar", ".accounts", ".reader", ".reader-head", ".reader-body", ".mail:hover"]) {
    const block = ruleBlock(selector);
    assert.match(block, /background:/, `${selector} needs an explicit background`);
    assert.doesNotMatch(block, /background:\s*transparent/, `${selector} must not be transparent`);
  }
});

test("the banner background is opaque in both themes, so its text stays readable", () => {
  assert.match(styleSource, /--banner-bg:\s*color-mix\(in oklab, var\(--accent\)[^;]*var\(--bg-panel\)\)/);
  assert.match(ruleBlock(".banner"), /background:\s*var\(--banner-bg\)/);
  assert.match(ruleBlock(".banner.is-error"), /background:\s*var\(--banner-error-bg\)/);
  assert.doesNotMatch(styleSource, /color-mix\(in oklab, var\(--danger\)[^;]*transparent\)/);
});

test("native controls follow the active theme", () => {
  assert.match(ruleBlock(":root"), /color-scheme:\s*dark/);
  assert.match(ruleBlock(':root[data-theme="light"]'), /color-scheme:\s*light/);
});
