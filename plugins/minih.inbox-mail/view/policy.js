/**
 * The rules the reading pane is built on, as plain data and pure functions.
 *
 * Two of them are security decisions and are therefore kept out of the DOM code,
 * where they have no reason to vary:
 *
 * - **No script, no origin.** A message body is shown in an `<iframe sandbox="">`
 *   — an empty sandbox, so not `allow-scripts` and not `allow-same-origin`. The
 *   frame gets an opaque origin, cannot reach the panel, and cannot run anything
 *   even if the sanitizer let a `<script>` through.
 * - **No remote load by default.** The frame carries its own CSP: `default-src
 *   'none'` plus inline styles, and `img-src data:` only. A tracking pixel is a
 *   network request to the sender, so nothing remote loads until the user presses
 *   "show remote images" for that one message.
 *
 * `buildFrameDocument` is what the panel assigns to `srcdoc`; the Node tests
 * assert the policy strings, and the browser check asserts the frame really
 * behaves this way.
 */

/** The iframe's sandbox: empty on purpose (no scripts, no same-origin). */
export const FRAME_SANDBOX = "";

/** CSP for a body whose images are blocked (the default). */
export const FRAME_CSP_BLOCKED =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** CSP after the user asked for this message's remote images. */
export const FRAME_CSP_IMAGES =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: https: http:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Frame typography, kept minimal: the message's own styles win where they exist. */
const FRAME_CSS = {
  dark: {
    color: "#e6e8ec",
    background: "#1b1d21",
    muted: "#9aa0aa",
    rule: "rgba(255,255,255,0.14)",
    link: "#a9c6ff",
  },
  light: {
    color: "#1b1d21",
    background: "#ffffff",
    muted: "#5d6470",
    rule: "rgba(0,0,0,0.12)",
    link: "#1a56c4",
  },
};

/** True for a URL that would leave the machine: http(s) or protocol-relative. */
export function isRemoteUrl(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text.startsWith("http://") || text.startsWith("https://") || text.startsWith("//");
}

/** What the panel may hand to the OS browser, or `null` for anything else. */
export function classifyLink(value) {
  const text = String(value ?? "").trim();
  if (/^https?:\/\//i.test(text)) return "http";
  if (/^mailto:/i.test(text)) return "mailto";
  return null;
}

export function frameCsp(allowImages) {
  return allowImages ? FRAME_CSP_IMAGES : FRAME_CSP_BLOCKED;
}

/**
 * The whole document the frame loads, with the body already sanitized.
 *
 * `sandbox` frames inherit nothing, so the CSP has to travel inside the document
 * as a meta tag: it is the only policy that applies to a `srcdoc` frame beyond the
 * host page's own.
 */
export function buildFrameDocument({ html, allowImages, theme }) {
  const colors = FRAME_CSS[theme === "light" ? "light" : "dark"];
  const style = `
    :root { color-scheme: ${theme === "light" ? "light" : "dark"}; }
    html, body { margin: 0; }
    body {
      padding: 18px 22px 24px;
      background: ${colors.background};
      color: ${colors.color};
      font: 14px/1.6 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
      overflow-wrap: anywhere;
    }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; }
    td, th { border: 1px solid ${colors.rule}; padding: 4px 8px; }
    pre, code { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
    blockquote {
      margin: 8px 0; padding: 2px 0 2px 12px;
      border-left: 2px solid ${colors.rule}; color: ${colors.muted};
    }
    a { color: ${colors.link}; text-decoration: none; }
    hr { border: 0; border-top: 1px solid ${colors.rule}; margin: 18px 0; }
  `;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(allowImages)}">`,
    `<style>${style}</style>`,
    "</head><body>",
    String(html ?? ""),
    "</body></html>",
  ].join("");
}

/** A 1x1 transparent GIF, used to replace a blocked remote image. */
export const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
