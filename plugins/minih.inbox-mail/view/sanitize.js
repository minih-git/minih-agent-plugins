/**
 * Turning one message's HTML into the frame's document.
 *
 * DOMPurify does the sanitizing — it is the only code here trusted to decide what
 * is dangerous — and this file only does the two jobs the sanitizer is not for:
 *
 * - **Links leave the frame.** Every `href` is removed after being collected, so
 *   a click inside the scriptless frame cannot navigate anywhere. The collected
 *   URLs are offered to the user as buttons that the host opens in the real
 *   browser.
 * - **Images do not leave the machine.** A remote `src` is replaced by a 1x1
 *   transparent pixel and remembered, so the default view makes no request; the
 *   "show remote images" variant puts the original source back.
 *
 * The frame's CSP is the enforcement for both (see `policy.js`); this file makes
 * the default view look deliberate instead of broken.
 */

import DOMPurify from "./vendor/purify.es.mjs";
import { TRANSPARENT_PIXEL, classifyLink, isRemoteUrl } from "./policy.js";

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

const CONFIG = {
  WHOLE_DOCUMENT: false,
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target"],
  FORBID_TAGS,
  FORBID_ATTR,
};

/**
 * `{ html, blockedHtml, links, remoteImages }`.
 *
 * `blockedHtml` is the default view (remote images swapped for a transparent
 * pixel); `html` is the same document with the original sources restored, used
 * only after the user presses "show remote images" for this one message.
 */
export function prepareBody(rawHtml) {
  const clean = DOMPurify.sanitize(String(rawHtml ?? ""), CONFIG);
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${clean}</body></html>`, "text/html");
  const links = [];
  const seen = new Set();
  for (const anchor of doc.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href) {
      const kind = classifyLink(href);
      if (kind && !seen.has(href)) {
        seen.add(href);
        links.push({
          url: href,
          kind,
          text: (anchor.textContent || href).trim().slice(0, 160) || href,
        });
      }
    }
    anchor.removeAttribute("href");
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
  return { blockedHtml, html: doc.body.innerHTML, links, remoteImages };
}
