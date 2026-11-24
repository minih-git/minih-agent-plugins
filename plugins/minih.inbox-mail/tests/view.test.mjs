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
