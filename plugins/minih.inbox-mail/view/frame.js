/**
 * The one thing the panel does with a message body's frame: watch it.
 *
 * The frame is `sandbox="allow-same-origin"` with no `allow-scripts` (see
 * `policy.js`), so the panel can read the document and nothing inside it can run.
 * That is enough to give a mail client its ordinary behaviour without trusting the
 * mail:
 *
 * - **A link is answered here, and only a link.** A body is a thing people read
 *   with a mouse and a keyboard: they copy an invoice number out of it, select it
 *   all, scroll it with Space, move the caret with the arrow keys, open a
 *   `<details>` with Enter. None of that may be cancelled. So only an event whose
 *   target is a link is intercepted (`linkEventIntercept` in `links.js`), and only
 *   then does the panel decide what the address means: the host's browser for
 *   `http(s)`, the panel's own composer for `mailto:`. `auxclick` (middle click) and
 *   <kbd>Enter</kbd> on a focused link take the same path — three ways to open one
 *   link, one answer.
 * - **A focused body still answers the panel's shortcuts.** A plain character with
 *   no ⌘/Ctrl/Alt is handed to the panel's key handler, so j, k, r, a, f, c and /
 *   work with the cursor in the message; copy, select-all and navigation keys are
 *   left to the browser.
 * - **Hovering shows where it really goes.** A status line at the bottom of the
 *   reading pane shows the address, and marks it when the link's own words name a
 *   different site than the one it opens (`links.js`).
 * - **The frame is as tall as the message.** A mail is a page, not a fixed window:
 *   the height follows the document, images and all, so the reading pane scrolls as
 *   one column instead of scrolling inside a box inside a column.
 *
 * Nothing here decides policy: it reports what the user did and how tall the body
 * is, and `app.js` is what knows about accounts, the browser and the composer.
 */

import { linkEventIntercept } from "./links.js";

/**
 * The link one event came from, or `null` when it came from plain text.
 *
 * `area` is in the selector because an image map is a link too: the sanitizer keeps
 * its `href` under the same rule (`sanitize.js`), so a click on a mapped region has
 * to reach the same handling as a click on an anchor.
 */
function anchorOf(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return null;
  return target.closest("a[href], area[href]");
}

/**
 * Set the frame's height from the document it holds.
 *
 * `scrollHeight` of the document element is the height of the content, not of the
 * viewport, so a short mail leaves no white gap and a long one is simply tall. The
 * horizontal axis is left alone: a mail wider than the pane scrolls sideways inside
 * the frame instead of widening the panel around it.
 */
export function fitFrame(frame) {
  const doc = frame.contentDocument;
  if (!doc) return;
  const height = Math.max(
    doc.documentElement?.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0,
  );
  // A zero height means the document is not laid out yet; leaving the previous
  // height alone is better than collapsing the frame to nothing while it loads.
  if (height > 0) frame.style.height = `${height}px`;
}

/**
 * Watch one frame for the life of the message it shows.
 *
 * Called on `load`, so the document exists. Everything is attached to that
 * document, which is thrown away with the frame when the next message is opened;
 * the observer disconnects itself once the frame has left the panel, so no
 * message leaves a listener or a timer behind.
 *
 * @param frame the `<iframe>` whose document to watch
 * @param handlers `{ onOpen(url), onStatus(url, anchor), onLeave(), onKey(event) }`
 */
export function bindFrame(frame, { onOpen, onStatus, onLeave, onKey } = {}) {
  const doc = frame.contentDocument;
  if (!doc) return;

  fitFrame(frame);

  const follow = (event) => {
    const anchor = anchorOf(event);
    // The decision comes first: a click on plain text, a ⌘C, an arrow key and a
    // Space belong to the reader, not to the panel, and cancelling them is how a
    // mail becomes impossible to copy from (`links.js`).
    if (!linkEventIntercept(event, Boolean(anchor))) {
      // A focused body swallows the panel's own single-key shortcuts; a plain
      // character (no ⌘/Ctrl/Alt) is handed to the panel so j, k, r, a, f, c and /
      // still work with the cursor in the message. Nothing else is touched.
      if (
        event.type === "keydown" &&
        typeof event.key === "string" &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        onKey?.(event);
      }
      return;
    }
    // A link was activated: the frame never navigates, the panel decides.
    event.preventDefault();
    event.stopPropagation();
    const url = anchor.getAttribute("href") ?? "";
    if (url) onOpen?.(url);
  };
  // Capture phase, so a link is answered before the frame can act on it.
  doc.addEventListener("click", follow, true);
  doc.addEventListener("auxclick", follow, true);
  doc.addEventListener("keydown", follow, true);

  const over = (event) => {
    const anchor = anchorOf(event);
    if (anchor) onStatus?.(anchor.getAttribute("href") ?? "", anchor);
  };
  doc.addEventListener("mouseover", over, true);
  doc.addEventListener("mouseout", (event) => {
    if (anchorOf(event)) onLeave?.();
  }, true);

  // A remote image arriving (or failing) changes the height: the frame is measured
  // again on both, and on a resize of its own content.
  for (const image of doc.querySelectorAll("img")) {
    if (image.complete) continue;
    image.addEventListener("load", () => fitFrame(frame), { once: true });
    image.addEventListener("error", () => fitFrame(frame), { once: true });
  }
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      // The frame is replaced on every message; once it is gone, so is this.
      if (!frame.isConnected) {
        observer.disconnect();
        return;
      }
      fitFrame(frame);
    });
    observer.observe(doc.documentElement);
    observer.observe(doc.body);
  }
}