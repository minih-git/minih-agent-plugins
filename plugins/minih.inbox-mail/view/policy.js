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
 * Two more are about reading a mail rather than about security: an HTML message is
 * shown on white paper whatever the app theme is (a mail was designed for one), and
 * a plain-text message becomes text with clickable links instead of a monospace
 * `<pre>`.
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

/**
 * The paper a message is shown on.
 *
 * A mail is written for a white page: newsletters, invoices and the rest pick
 * their own colours assuming one. Tinting it with the app's dark theme is what
 * turns a readable mail into light text on a white table, and overriding the
 * author's colours is what turns a designed mail into a grey one. So the page is
 * always white with dark default text, `color-scheme: light` so native controls
 * and scrollbars match, and nothing here touches a colour the message sets itself.
 */
const PAPER = {
  color: "#1b1d21",
  background: "#ffffff",
  muted: "#5d6470",
  rule: "rgba(0,0,0,0.12)",
  link: "#1a56c4",
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
export function buildFrameDocument({ html, styles = [], allowImages }) {
  // No forced cell borders or padding: a newsletter is a table layout, and a rule
  // on every `td`/`th` draws a grid over a design that never asked for one. `img`
  // and `table` are capped only so a wide mail cannot force a horizontal scroll.
  const base = `
    :root { color-scheme: light; }
    html, body { margin: 0; background: ${PAPER.background}; }
    body {
      padding: 18px 22px 24px;
      background: ${PAPER.background};
      color: ${PAPER.color};
      font: 14px/1.6 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
      overflow-wrap: anywhere;
    }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; }
    pre, code { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
    blockquote {
      margin: 8px 0; padding: 2px 0 2px 12px;
      border-left: 2px solid ${PAPER.rule}; color: ${PAPER.muted};
    }
    a { color: ${PAPER.link}; text-decoration: none; }
    hr { border: 0; border-top: 1px solid ${PAPER.rule}; margin: 18px 0; }
  `;
  // The message's own `<style>` blocks go after ours, so its rules win on equal
  // specificity and its colours are never overridden. The frame's CSP still
  // decides what may load: `style-src 'unsafe-inline'` allows inline sheets only,
  // and `img-src` is what blocks a remote background image.
  const authorStyle = styles.length ? `<style>\n${styles.join("\n")}\n</style>` : "";
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(allowImages)}">`,
    `<style>${base}</style>`,
    authorStyle,
    "</head><body>",
    String(html ?? ""),
    "</body></html>",
  ].join("");
}

/**
 * Which alternative of a message the reading pane shows.
 *
 * `html` when the message has an HTML part and the user has not asked for the
 * text one: a mail written with a design should be seen with it, and the text
 * alternative is the fallback and the escape hatch, not the default.
 */
export function bodyMode({ text, html } = {}, showText = false) {
  if (!html) return "text";
  return showText ? "text" : "html";
}

/**
 * A plain-text body split into text and links, for the reading pane.
 *
 * The frame is not used for plain text — there is no markup to sandbox — so the
 * links are found here and rendered as panel buttons, which keeps the one rule
 * that matters: a link opens in the user's browser through the host, never inside
 * the panel.
 */
export function linkifyText(value) {
  const source = String(value ?? "");
  const segments = [];
  let last = 0;
  for (const match of source.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = match[0];
    // Trailing punctuation belongs to the sentence, not to the address.
    const trimmed = url.replace(/[).,;:!?]+$/, "");
    if (match.index > last) segments.push({ text: source.slice(last, match.index) });
    segments.push({ url: trimmed, text: trimmed });
    last = match.index + trimmed.length;
  }
  if (last < source.length) segments.push({ text: source.slice(last) });
  return segments;
}

/** A 1x1 transparent GIF, used to replace a blocked remote image. */
export const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";