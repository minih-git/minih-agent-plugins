import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FRAME_SANDBOX,
  bodyMode,
  buildFrameDocument,
  classifyLink,
  frameCsp,
  isRemoteUrl,
  linkifyText,
} from "../view/policy.js";
import { SANITIZE_CONFIG, extractStyles } from "../view/sanitize.js";
import { NEWSLETTER_HTML } from "./helpers/newsletter.mjs";

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
  const document = buildFrameDocument({ html: "<p>hi</p>", allowImages: false });
  assert.match(document, /^<!doctype html>/);
  assert.match(document, /http-equiv="Content-Security-Policy"/);
  assert.ok(document.includes(frameCsp(false)));
  assert.ok(document.includes("<p>hi</p>"));
  // White paper, whatever the app theme is: a mail was designed for one.
  assert.match(document, /color-scheme: light/);
  assert.match(document, /background: #ffffff/);
  assert.doesNotMatch(document, /#1b1d21;\s*margin|background: #1b1d21/);
});

test("the frame does not draw a grid over a table layout", () => {
  const document = buildFrameDocument({ html: NEWSLETTER_HTML, allowImages: false });
  // The forced `td, th { border; padding }` is what put a border on every cell of
  // a newsletter's nested tables.
  assert.doesNotMatch(document, /td,\s*th\s*\{/);
  assert.doesNotMatch(document, /border: 1px solid; padding/);
  // A wide mail still cannot force a horizontal scroll.
  assert.match(document, /img \{ max-width: 100%/);
  assert.match(document, /table \{ border-collapse: collapse; max-width: 100%/);
});

test("the message's own stylesheet survives, after the frame's defaults", () => {
  const styles = extractStyles(NEWSLETTER_HTML);
  assert.equal(styles.length, 1);
  assert.match(styles[0], /\.paper\s*\{/);
  assert.match(styles[0], /color:\s*#063/, "an author colour is kept as written");
  const document = buildFrameDocument({ html: NEWSLETTER_HTML, styles, allowImages: false });
  const base = document.indexOf("color-scheme: light");
  const author = document.indexOf(".paper");
  assert.ok(base >= 0 && author > base, "the author sheet comes after the defaults, so it wins");
  // DOMPurify would have dropped the block entirely: that is why it is lifted out
  // of the raw document instead of coming from the sanitizer.
  assert.equal((SANITIZE_CONFIG.ADD_TAGS ?? []).includes("style"), false);
});

test("a stylesheet cannot pull anything in", () => {
  const styles = extractStyles(
    "<style>@import url(https://tracker.example/a.css); p { background: url(https://tracker.example/p.gif) }</style>",
  );
  assert.equal(styles.length, 1);
  assert.doesNotMatch(styles[0], /@import/);
  // The url() stays in the CSS; the frame's CSP (`img-src data:`) is what stops it.
  assert.match(styles[0], /url\(https:\/\/tracker\.example\/p\.gif\)/);
});

test("a message with both parts is shown as HTML, and the toggle reaches the text", () => {
  const message = { text: "plain", html: "<p>html</p>" };
  assert.equal(bodyMode(message), "html");
  assert.equal(bodyMode(message, true), "text");
  // No HTML part: there is nothing to toggle to.
  assert.equal(bodyMode({ text: "plain" }), "text");
  assert.match(appSource, /bodyMode\(message, reader\.showText\)/);
  assert.match(appSource, /reader\.showText = !reader\.showText/);
});

test("a plain-text body becomes wrapped prose with links the host opens", () => {
  const segments = linkifyText("Hello\nhttps://example.com/a\nthanks");
  assert.deepEqual(segments, [
    { text: "Hello\n" },
    { url: "https://example.com/a", text: "https://example.com/a" },
    { text: "\nthanks" },
  ]);
  // No markup: a plain-text body never goes near the frame.
  assert.equal(linkifyText("<b>not html</b>").every((segment) => !segment.url), true);
  assert.match(appSource, /function renderText\(text\)/);
  assert.match(appSource, /onClick: \(\) => void openExternal\(segment\.url\)/);
  // And it is prose, not a monospace block.
  const textBlock = ruleBlock(".mail-text");
  assert.match(textBlock, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(textBlock, /font-family:\s*(monospace|ui-monospace)/);
  assert.doesNotMatch(appSource, /el\("pre", \{ class: "mail-text"/);
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
