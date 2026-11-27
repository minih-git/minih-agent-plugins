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
  frameHref,
  isRemoteUrl,
  linkifyText,
} from "../view/policy.js";
import { hostOf, linkDisguise, linkEventIntercept, parseMailto } from "../view/links.js";
import { SANITIZE_CONFIG, extractStyles } from "../view/sanitize.js";
import { NEWSLETTER_HTML } from "./helpers/newsletter.mjs";
import { codeText, strings } from "../view/strings.js";

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
const frameSource = readFileSync(join(root, "view/frame.js"), "utf8");
const sanitizeSource = readFileSync(join(root, "view/sanitize.js"), "utf8");

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

test("the frame is same-origin and scriptless: allow-same-origin, never allow-scripts", () => {
  // Same-origin is what lets the panel read the document and answer a click inside
  // it. The pair `allow-scripts allow-same-origin` is the combination that would let
  // a message script the panel, so it may never appear — in the string, or anywhere
  // the panel builds one.
  assert.equal(FRAME_SANDBOX, "allow-same-origin");
  for (const forbidden of ["allow-scripts", "allow-popups", "allow-top-navigation", "allow-forms"]) {
    assert.equal(FRAME_SANDBOX.includes(forbidden), false, forbidden);
    // A sandbox attribute the panel ever writes may not carry any of them. A comment
    // that names the forbidden token is fine; the attribute is what matters.
    assert.doesNotMatch(appSource, new RegExp(`sandbox="[^"]*${forbidden}`), `app.js sets ${forbidden}`);
    assert.doesNotMatch(
      appSource,
      new RegExp(`setAttribute\\("sandbox",\\s*"[^"]*${forbidden}`),
      `app.js sets ${forbidden}`,
    );
  }
  assert.match(appSource, /setAttribute\("sandbox", FRAME_SANDBOX\)/);
  // The origin is only useful because the panel watches the document it loaded.
  assert.match(appSource, /import \{ bindFrame \} from "\.\/frame\.js"/);
  assert.match(appSource, /frame\.addEventListener\("load"/);
  assert.match(frameSource, /doc\.addEventListener\("click", follow, true\)/);
  assert.match(frameSource, /doc\.addEventListener\("auxclick", follow, true\)/);
  assert.match(frameSource, /doc\.addEventListener\("keydown", follow, true\)/);
  // Every one of them cancels the navigation before it decides anything.
  assert.match(frameSource, /event\.preventDefault\(\);\n    event\.stopPropagation\(\);/);
  // And the frame is measured to its content, not fixed to the pane.
  assert.match(frameSource, /doc\.documentElement\?\.scrollHeight/);
  assert.match(frameSource, /new ResizeObserver/);
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
test("a link keeps only an address the panel will act on", () => {
  // What survives sanitizing is what a click can carry. Anything else is removed
  // outright, because an attribute the panel refuses to act on is still one the
  // browser would act on if some path ever missed the interception.
  assert.equal(frameHref("https://example.com/invoice/9"), "https://example.com/invoice/9");
  assert.equal(frameHref("http://example.com"), "http://example.com");
  assert.equal(frameHref("mailto:help@example.com?subject=Invoice"), "mailto:help@example.com?subject=Invoice");
  for (const refused of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<b>hi",
    "file:///etc/passwd",
    "/relative/path",
    "relative.html",
    "#anchor",
    "//tracker.example/x",
    "",
  ]) {
    assert.equal(frameHref(refused), "", JSON.stringify(refused));
  }
  // It is the sanitizer that applies it, before the frame is built.
  assert.match(sanitizeSource, /const kept = frameHref\(anchor\.getAttribute\("href"\) \?\? ""\);/);
  assert.match(sanitizeSource, /anchor\.setAttribute\("href", kept\);/);
  assert.match(sanitizeSource, /anchor\.removeAttribute\("href"\);/);
  // A message never chooses where a link opens: no `target`, and a plain `rel`.
  assert.match(sanitizeSource, /anchor\.removeAttribute\("target"\);/);
  assert.match(sanitizeSource, /anchor\.setAttribute\("rel", "noreferrer noopener"\);/);
  assert.equal(Array.isArray(SANITIZE_CONFIG.ADD_ATTR), false, "target is not re-added by the sanitizer");
});

test("a mailto link becomes the composer's fields, and nothing else", () => {
  assert.deepEqual(
    parseMailto("mailto:ann@example.com?cc=cara@example.com&subject=Re%3A%20INV-9931&body=Hello%0AWorld"),
    {
      to: ["ann@example.com"],
      cc: ["cara@example.com"],
      bcc: [],
      subject: "Re: INV-9931",
      body: "Hello\nWorld",
    },
  );
  // Two recipients in the path, and a `+` is a plus (RFC 6068 escapes a space).
  assert.deepEqual(parseMailto("mailto:a@b.example,b@c.example?subject=1+1").to, ["a@b.example", "b@c.example"]);
  assert.equal(parseMailto("mailto:a@b.example?subject=1+1").subject, "1+1");
  // A link does not get to attach a file or pre-set the thread it answers.
  const extra = parseMailto("mailto:a@b.example?attach=%2Fetc%2Fpasswd&in-reply-to=%3Cx%40y%3E");
  assert.deepEqual(Object.keys(extra), ["to", "cc", "bcc", "subject", "body"]);
  // Not a mailto at all.
  assert.equal(parseMailto("https://example.com"), null);
  assert.equal(parseMailto(""), null);
});

test("a link whose words name another site than the one it opens is flagged", () => {
  assert.equal(hostOf("https://Login.Your-Bank.com/x"), "login.your-bank.com");
  assert.equal(hostOf("mailto:a@b.example"), "");
  assert.equal(hostOf("not a url"), "");
  // The words say one bank, the address opens another: that is the phish.
  assert.equal(linkDisguise("https://your-bank.com/login", "https://evil.example/x"), true);
  assert.equal(linkDisguise("your-bank.com/login", "https://evil.example/x"), true);
  // A subdomain of the same site is not a lie, and neither is prose with no
  // address in it — most links are written as "Click here".
  assert.equal(linkDisguise("https://your-bank.com/login", "https://login.your-bank.com/x"), false);
  assert.equal(linkDisguise("Click here to pay", "https://evil.example/x"), false);
  assert.equal(linkDisguise("Invoice INV-9931", "https://evil.example/x"), false);
  // Two-label public suffixes: sharing `co.uk` is not sharing a site.
  assert.equal(linkDisguise("https://bank.co.uk", "https://evil.co.uk/x"), true);
  assert.equal(linkDisguise("https://bank.co.uk", "https://pay.bank.co.uk/x"), false);
  // A mailto has no host to disagree about.
  assert.equal(linkDisguise("https://evil.example", "mailto:a@b.example"), false);
});

test("only a link's own activation is intercepted: copy, select and scroll are not", () => {
  // Opening a link: a click, a middle click, Enter on a focused link.
  assert.equal(linkEventIntercept({ type: "click" }, true), true);
  assert.equal(linkEventIntercept({ type: "auxclick", button: 1 }, true), true);
  assert.equal(linkEventIntercept({ type: "keydown", key: "Enter" }, true), true);
  // Everything else a mail body is used for stays with the browser: ⌘C/Ctrl+C over a
  // selected invoice number, select-all, Space to scroll, the arrow keys, a right
  // click, a click on plain text, Enter outside a link.
  assert.equal(linkEventIntercept({ type: "keydown", key: "c", metaKey: true }, true), false);
  assert.equal(linkEventIntercept({ type: "keydown", key: "c", ctrlKey: true }, true), false);
  assert.equal(linkEventIntercept({ type: "keydown", key: "a", metaKey: true }, true), false);
  assert.equal(linkEventIntercept({ type: "keydown", key: " " }, true), false);
  assert.equal(linkEventIntercept({ type: "keydown", key: "ArrowDown" }, true), false);
  assert.equal(linkEventIntercept({ type: "keydown", key: "Enter", shiftKey: true }, true), false);
  assert.equal(linkEventIntercept({ type: "keydown", key: "Enter" }, false), false);
  assert.equal(linkEventIntercept({ type: "click" }, false), false);
  assert.equal(linkEventIntercept({ type: "auxclick", button: 2 }, true), false);
  assert.equal(linkEventIntercept({ type: "mousedown" }, true), false);
  assert.equal(linkEventIntercept(null, true), false);
  // The frame asks that question *before* it cancels anything: cancelling first and
  // checking afterwards is what made the body impossible to copy from.
  assert.match(frameSource, /if \(!linkEventIntercept\(event, Boolean\(anchor\)\)\) \{/);
  const follow = frameSource.slice(frameSource.indexOf("const follow = (event) => {"));
  assert.ok(
    follow.indexOf("linkEventIntercept") < follow.indexOf("event.preventDefault()"),
    "the decision comes before the cancellation",
  );
  // An image map is a link too, and the sanitizer gives it the same address rule.
  assert.match(frameSource, /closest\("a\[href\], area\[href\]"\)/);
  assert.match(sanitizeSource, /querySelectorAll\("a, area"\)/);
  // A focused body still answers the panel's shortcuts, and nothing else.
  assert.match(frameSource, /onKey\?\.\(event\)/);
  assert.match(appSource, /onKey: handleKey/);
});

test("the reading pane no longer lists links, because a link works where it is written", () => {
  // No second list under the body: the address stays in the message, and the panel
  // answers the click (`frame.js`).
  assert.equal(/message\.body\?\.links/.test(appSource), false);
  assert.equal(/extra-list/.test(appSource), false);
  assert.match(appSource, /onOpen: \(url\) => void followLink\(url\)/);
  assert.match(appSource, /async function followLink\(url\)/);
  assert.match(appSource, /if \(kind === "mailto"\) \{\n    await openMailto\(url\);/);
  // The two destinations, and nothing else.
  assert.match(appSource, /if \(kind === "http"\) await openExternal\(url\);/);
  // A mailto becomes a draft in this panel, with its fields filled in.
  assert.match(appSource, /const fields = parseMailto\(url\);/);
  assert.match(appSource, /to: fields\.to\.map\(\(address\) => \(\{ name: "", address \}\)\)/);
  assert.match(appSource, /subject: fields\.subject/);
  // Where the link really goes is shown while the cursor is on it.
  assert.match(indexSource, /id="reader-link-status"/);
  assert.match(appSource, /const disguised = classifyLink\(url\) === "http" && linkDisguise\(anchor\?\.textContent \?\? "", url\);/);
  assert.match(appSource, /t\(\)\.linkDisguise\(url\)/);
  assert.match(ruleBlock(".reader-link-status"), /position: sticky/);
  // One scrolling column: the body grows, the attachments follow it, nothing has
  // its own scrollbar or a fixed slice of the window.
  assert.match(ruleBlock(".reader-message"), /overflow: auto/);
  assert.doesNotMatch(ruleBlock(".reader-extras"), /max-height/);
  assert.doesNotMatch(ruleBlock(".reader-extras"), /overflow: auto/);
  assert.match(ruleBlock(".reader-body"), /flex: 0 0 auto/);
  // A plain-text body keeps its link buttons, in place.
  assert.match(appSource, /onClick: \(\) => void openExternal\(segment\.url\)/);
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

test("the panel explains a proxy failure in both languages", () => {
  const en = strings("en");
  const zh = strings("zh-CN");
  // Every key exists in both tables, codes included: a missing sentence would
  // otherwise fall back to a generic one for Chinese users only.
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.deepEqual(Object.keys(en.codes).sort(), Object.keys(zh.codes).sort());
  assert.match(codeText("en", "PROXY_FAILED"), /proxy/);
  assert.match(codeText("zh-CN", "PROXY_FAILED"), /代理/);
  assert.match(codeText("en", "PROXY_AUTH_FAILED"), /username or password/);
  assert.match(codeText("zh-CN", "PROXY_AUTH_FAILED"), /用户名或密码/);
  // The card's tooltip says which proxy, from the three published fields.
  assert.equal(en.viaProxy({ host: "127.0.0.1", port: 7897 }), "via proxy 127.0.0.1:7897");
  assert.equal(zh.viaProxy({ host: "127.0.0.1", port: 7897 }), "经代理 127.0.0.1:7897");
});

/**
 * A conditional child must go through `el()`, which drops `null`, and never into
 * a native `append`/`replaceChildren`, which would stringify it: 0.4.0 shipped an
 * account row reading `archive@163.comnull` because of exactly that.
 */
test("the sidebar never hands a null child to the DOM", () => {
  assert.match(appSource, /function unreadBadge\(/, "the badge is built by a helper that returns null");
  assert.doesNotMatch(
    appSource,
    /main\.append\([\s\S]{0,600}?: null\s*,?\s*\)/,
    "a native append must not receive a conditional null",
  );
  // `el()` is the one place that filters: the account rows use it for every child.
  assert.match(appSource, /function unreadBadge\(count, table\) \{\n  if \(!count\) return null;/);
});


test("the composer is a module of its own, drawn into its own container", () => {
  assert.ok(statSync(join(root, "view/compose.js"), { throwIfNoEntry: false })?.isFile());
  // The page owns one element for it and nothing inside: the composer builds its
  // own form, so the panel's markup stays one screen of structure.
  assert.match(indexSource, /<div class="compose-backdrop is-hidden" id="compose" role="dialog"/);
  assert.match(appSource, /import \{ createComposer \} from "\.\/compose\.js";/);
  assert.match(appSource, /composer = createComposer\(nodes\.composeLayer,/);
  // The topbar button is the fifth way in, and it is in the markup.
  assert.match(indexSource, /id="btn-compose"/);
});

test("the composer takes every key while it is open, and Escape asks before discarding", () => {
  // A modal surface: the panel's own shortcuts must not fire behind it, or a `c`
  // typed into a subject line would open a second composer.
  assert.match(appSource, /if \(composer\?\.isOpen\) \{/);
  assert.match(appSource, /composer\.handleKey\(event\);/);
  const composeSource = readFileSync(join(root, "view/compose.js"), "utf8");
  assert.match(composeSource, /if \(event\.key !== "Escape"\) return false;/);
  assert.match(composeSource, /requestClose\(\);\n\s+return true;/);
  // The confirmation is a card inside the composer, not `window.confirm`.
  assert.equal(composeSource.includes("window.confirm"), false);
  assert.match(composeSource, /compose\.discardTitle/);
});

test("a failed send keeps the draft, and never shows the plugin's English text", () => {
  const composeSource = readFileSync(join(root, "view/compose.js"), "utf8");
  // The code is what the panel can translate; the raw message would be an English
  // sentence from the plugin process, in a Chinese panel.
  assert.match(composeSource, /state\.error = codeText\(locale\(\), error\?\.code, t\(\)\.sendFailed\);/);
  // A rejection leaves the fields as they were: `close()` is only called on success.
  assert.match(composeSource, /const result = await onSend\(\{/);
  assert.match(composeSource, /close\(\);\n      onClosed\(result \?\? \{\}\);/);
});

test("a reply is sent from the mailbox that received the message, never from another one", () => {
  const composeSource = readFileSync(join(root, "view/compose.js"), "utf8");
  // Falling back to an account that can send would silently change who answers.
  assert.match(composeSource, /A reply goes out from the account that received the message/);
  assert.match(composeSource, /const wanted = source\.accountId/);
  assert.match(composeSource, /state\.accountId = \(wanted \?\? fallback\)\?\.instanceId \?\? "";/);
  // And an account that cannot send keeps the composer open with the reason, with
  // Send disabled rather than hidden.
  assert.match(composeSource, /sendButton\.disabled = state\.sending \|\| over \|\| !account\?\.canSend;/);
});

test("an attachment is named by its part in the panel, not by its row", () => {
  const appSource = readFileSync(join(root, "view/app.js"), "utf8");
  // The panel's list and the server's structure number parts differently the
  // moment a message carries an inline image, so the section number the body
  // already has is what a save sends — and what the card is keyed by.
  assert.match(appSource, /const id = `\$\{message\.accountId\}:\$\{message\.key\}:\$\{file\.part\}`;/);
  assert.match(appSource, /part: file\.part,\n      filename: file\.filename,/);
  assert.match(appSource, /call\("inbox\.saveAttachment"/);
  const composeSource = readFileSync(join(root, "view/compose.js"), "utf8");
  // A forward ticks parts too: a ticked neighbour must never travel instead.
  assert.match(composeSource, /state\.forwardSelection\.has\(file\.part\)/);
  assert.match(
    composeSource,
    /attachments: files\.map\(\(file\) => \(\{ part: file\.part, filename: file\.filename \}\)\)/,
  );
});

test("the panel's words cover sending and saving in both languages", () => {
  for (const locale of ["en", "zh-CN"]) {
    const table = strings(locale);
    for (const key of ["reply", "replyAll", "forward", "newMessage", "send", "sending", "discard", "attach", "noRecipient", "originalAttachments"]) {
      assert.equal(typeof table.compose[key], "string", `${locale}: compose.${key} is not a sentence`);
      assert.ok(String(table.compose[key]).length > 0, `${locale}: compose.${key} is empty`);
    }
    for (const reason of ["send-disabled", "send-no-server", "send-no-preset"]) {
      assert.ok(String(table.compose.blocked[reason]).length > 0, `${locale}: ${reason} has no sentence`);
    }
    for (const key of ["sent", "saveAttachment", "savingAttachment", "sendFailed", "saveFailed", "replyHint"]) {
      assert.ok(String(table[key]).length > 0, `${locale}: ${key} is empty`);
    }
    // Every refusal the host can report has a sentence of its own.
    for (const code of [
      "MAIL_SEND_NOT_CONFIGURED",
      "MAIL_FROM_MISMATCH",
      "MAIL_BCC_HEADER",
      "MAIL_TOO_LARGE",
      "MAIL_RATE_LIMITED",
      "MAIL_EIGHT_BIT_UNSUPPORTED",
      "AUTH_FAILED",
      "SENDER_REJECTED",
      "RECIPIENT_REJECTED",
      "MESSAGE_REJECTED",
      "SMTP_FAILED",
      "STARTTLS_UNAVAILABLE",
      "TLS_CERTIFICATE",
      "ATTACHMENT_NOT_FOUND",
      "ATTACHMENT_TOO_LARGE",
      "ATTACHMENT_MISMATCH",
      "INVALID_ARGUMENT",
      "SAVE_AS_BUSY",
      "SAVE_AS_FAILED",
      "MESSAGE_NOT_OPEN",
    ]) {
      assert.equal(codeText(locale, code, undefined) !== codeText(locale, "FAILED", undefined), true, `${locale}: ${code} falls back to the generic sentence`);
    }
  }
});

test("nothing in the panel still claims attachments are never downloaded or mail never sent", () => {
  const table = strings("en");
  assert.equal(table.attachments, "Attachments");
  assert.equal(strings("zh-CN").attachments, "附件");
  assert.doesNotMatch(indexSource, /only listed|not downloaded/i);
});


test("the bulk-read toolbar wraps on narrow panels and has localized action copy", () => {
  assert.match(indexSource, /id="btn-read-all"/);
  assert.match(appSource, /nodes\.readAll\.addEventListener\("click"/);
  assert.match(styleSource, /@media \(max-width: 699px\) \{\s*\.topbar \{\s*flex-wrap: wrap;/);
  assert.match(styleSource, /\.topbar-actions \{\s*flex-wrap: wrap;\s*max-width: 100%;/);
  for (const locale of ["en", "zh-CN"]) {
    const table = strings(locale);
    for (const key of ["markAllRead", "markAllReadHint", "markingAllRead", "allMarkedRead", "markAllReadFailed"]) {
      assert.equal(typeof table[key], "string", `${locale}.${key}`);
      assert.ok(table[key].length);
    }
  }
});

test("the panel shows what the body cache holds and can empty it, in both languages", () => {
  // The settings page is built from the manifest and cannot hold a button, so the
  // size of what a click left on disk, and the one action that empties it, live in
  // the panel — under the mailbox list, not in the reading pane.
  assert.match(indexSource, /id="cache-title"/);
  assert.match(indexSource, /id="cache-size"/);
  assert.match(indexSource, /id="btn-clear-cache"/);
  assert.match(appSource, /nodes\.cacheSize\.textContent = cache\.entries/);
  assert.match(appSource, /formatBytes\(cache\.bytes, state\.locale\)/);
  assert.match(appSource, /call\("inbox\.clearBodyCache"\)/);
  // Emptying it is not undoable, so it asks first — in the panel's own card, the
  // same one a POP3 delete uses, never `window.confirm`.
  assert.match(appSource, /state\.confirmCache = true/);
  assert.match(appSource, /table\.cacheConfirmTitle/);
  assert.match(appSource, /table\.cacheConfirmBody/);
  assert.doesNotMatch(appSource, /window\.confirm\(/);
  for (const locale of ["en", "zh-CN"]) {
    const table = strings(locale);
    for (const key of [
      "cacheTitle",
      "cacheEmpty",
      "cacheClear",
      "cacheClearing",
      "cacheCleared",
      "cacheFailed",
      "cacheConfirmTitle",
      "cacheConfirmBody",
      "cacheConfirmYes",
      "cacheConfirmNo",
    ]) {
      assert.equal(typeof table[key], "string", `${locale}.${key} is not a sentence`);
      assert.ok(table[key].length > 0, `${locale}.${key} is empty`);
    }
    // The line itself carries the size and the count, so neither is invented by
    // the panel.
    assert.equal(typeof table.cacheLine, "function", `${locale}.cacheLine`);
    assert.match(table.cacheLine("1.2 MB", 3), /1\.2 MB/);
    assert.match(table.cacheLine("900 B", 1), /900 B/);
    // Both languages say plainly that the bytes are on this computer, in the clear,
    // bounded and expiring — the promise the manifest used to make in reverse.
    assert.match(table.cacheConfirmBody, /200 MB/);
    assert.match(table.cacheConfirmBody, /30/);
  }
  assert.match(strings("en").cacheConfirmBody, /plain text/);
  assert.match(strings("zh-CN").cacheConfirmBody, /明文/);
  // The line paints its own surface: rows scroll underneath a sticky footer.
  assert.match(styleSource, /\.cache-foot \{[^}]*position: sticky;/);
  assert.match(styleSource, /\.cache-foot \{[^}]*background: var\(--bg-panel\);/);
});
