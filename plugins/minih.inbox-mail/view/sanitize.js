/**
 * Turning one message's HTML into the frame's document.
 *
 * DOMPurify does the sanitizing — it is the only code here trusted to decide what
 * is dangerous — and this file only does the two jobs the sanitizer is not for:
 *
 * - **A link carries an address the panel will act on, and nothing else.** An
 *   `http`, `https` or `mailto` address is kept (see `frameHref`), every other one
 *   is removed, and `target` goes with them so nothing can open a window of its
 *   own. The click is answered by the panel, which hands the address to the host's
 *   browser or opens the composer for a `mailto:` — never by the frame navigating.
 * - **Images do not leave the machine.** A remote `src` is replaced by a 1x1
 *   transparent pixel and remembered, so the default view makes no request; the
 *   "show remote images" variant puts the original source back.
 *
 * The frame's CSP and the panel's own are the enforcement for both (see
 * `policy.js`); this file makes the default view look deliberate instead of broken.
 *
 * It also keeps the message's own stylesheet: see `extractStyles`.
 */

import DOMPurify from "./vendor/purify.es.mjs";
import { TRANSPARENT_PIXEL, classifyLink, frameHref, isRemoteUrl } from "./policy.js";

/** Elements a mail body has no business carrying into a panel. */
const FORBID_TAGS = [
  "script",
  "noscript",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "video",
  "audio",
  "source",
  "track",
  "svg",
  "math",
];

/** Attributes that fetch, submit or navigate, whatever the element. */
const FORBID_ATTR = ["srcset", "imagesrcset", "ping", "formaction", "xlink:href", "action"];

/**
 * The sanitizer's configuration, exported so a test can state the one fact that
 * matters here: `style` is not in the allowlist, so DOMPurify removes a mail's
 * `<style>` blocks. That is why `extractStyles` exists.
 *
 * `target` is deliberately absent: a link in a message never chooses where it
 * opens, and `prepareBody` removes the attribute in case a message carries one.
 */
export const SANITIZE_CONFIG = {
  WHOLE_DOCUMENT: false,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS,
  FORBID_ATTR,
};

const CONFIG = SANITIZE_CONFIG;

/**
 * The message's own stylesheets, taken out of the raw HTML.
 *
 * DOMPurify drops `<style>` (it is not in its allowlist), which is why a
 * newsletter used to arrive stripped of its design. The block is lifted here
 * instead, scrubbed of the two things that could reach the network or the frame's
 * own origin — `@import` and `expression()`/`javascript:` — and handed to the frame
 * as a stylesheet. The CSP still governs loads (`style-src 'unsafe-inline'` allows
 * inline sheets only, `img-src data:` blocks a remote background image), and an
 * author colour is never overridden because the sheet comes after the frame's own.
 */
export function extractStyles(rawHtml) {
  const source = String(rawHtml ?? "");
  const styles = [];
  for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = match[1]
      .replace(/@import[^;]*;?/gi, "")
      .replace(/expression\s*\(/gi, "(")
      .replace(/javascript:/gi, "")
      // A closing tag inside CSS would end the injected `<style>` early.
      .replace(/<\/style/gi, "<\\/style")
      .trim();
    if (css) styles.push(css);
  }
  return styles;
}

/**
 * `{ html, blockedHtml, styles, links, remoteImages }`.
 *
 * `blockedHtml` is the default view (remote images swapped for a transparent
 * pixel); `html` is the same document with the original sources restored, used
 * only after the user presses "show remote images" for this one message.
 */
export function prepareBody(rawHtml) {
  // The styles come from the raw document, not from the sanitized one: DOMPurify
  // removes `<style>`, and a mail with a design is the common case.
  const styles = extractStyles(rawHtml);
  const clean = DOMPurify.sanitize(String(rawHtml ?? ""), CONFIG);
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${clean}</body></html>`, "text/html");
  // `links` is kept for the tests and for a caller that wants an address list; the
  // panel no longer renders it, because a link now works where it is written.
  const links = [];
  const seen = new Set();
  // `area` is here because an image map is a link too: it gets the same rule, and
  // the panel's click handling matches either element. Removing its `href` instead
  // would make a mapped image in a newsletter simply dead.
  for (const anchor of doc.querySelectorAll("a, area")) {
    const kept = frameHref(anchor.getAttribute("href") ?? "");
    if (kept) {
      const kind = classifyLink(kept);
      if (!seen.has(kept)) {
        seen.add(kept);
        links.push({
          url: kept,
          kind,
          text: (anchor.textContent || kept).trim().slice(0, 160) || kept,
        });
      }
      anchor.setAttribute("href", kept);
      // Nothing in a message opens a window of its own: the panel answers the click
      // and decides what happens, and `rel` says so even if something else follows it.
      anchor.setAttribute("rel", "noreferrer noopener");
    } else {
      anchor.removeAttribute("href");
    }
    anchor.removeAttribute("target");
  }
  let remoteImages = 0;
  for (const image of doc.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!isRemoteUrl(src)) continue;
    remoteImages += 1;
    image.setAttribute("data-remote-src", src);
    image.setAttribute("src", TRANSPARENT_PIXEL);
  }
  const blockedHtml = doc.body.innerHTML;
  for (const image of doc.querySelectorAll("img[data-remote-src]")) {
    image.setAttribute("src", image.getAttribute("data-remote-src"));
    image.removeAttribute("data-remote-src");
  }
  return { blockedHtml, html: doc.body.innerHTML, styles, links, remoteImages };
}
