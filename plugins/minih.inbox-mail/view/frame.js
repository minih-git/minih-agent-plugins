/**
 * The one thing the panel does with a message body's frame: watch it.
 *
 * The frame is `sandbox="allow-same-origin"` with no `allow-scripts` (see
 * `policy.js`), so the panel can read the document and nothing inside it can run.
 * That is enough to give a mail client its ordinary behaviour without trusting the
 * mail:
 *
 * - **A click is answered here.** The document is sanitized, but a `<a href>` is
 *   still a link, and inside a frame it would navigate the frame away from the
 *   message. So every click is intercepted in the capture phase, the frame is never
 *   allowed to navigate, and the panel decides what the address means: the host's
 *   browser for `http(s)`, the panel's own composer for `mailto:`. `auxclick`
 *   (middle click) and <kbd>Enter</kbd> on a focused link take the same path — three
 *   ways to open one link, one answer.
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

/**
 * What a click inside one frame resolves to.
 *
 * `anchor` is the nearest link the event came from, or `null` for a click on plain
 * text. The caller has already been given a cancelled event: this value only says
 * what to do next.
 */
function anchorOf(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return null;
  return target.closest("a[href]");
}

/** Whether this event is a request to follow the link it came from. */
function isFollow(event) {
  if (event.type === "auxclick") return event.button === 1;
  if (event.type === "keydown") return event.key === "Enter" || event.key === " ";
  return true;
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
 * @param handlers `{ onOpen(url), onStatus(url, anchor), onLeave() }`
 */
export function bindFrame(frame, { onOpen, onStatus, onLeave } = {}) {
  const doc = frame.contentDocument;
  if (!doc) return;

  fitFrame(frame);

  const follow = (event) => {
    const anchor = anchorOf(event);
    // Nothing in a mail navigates: not a link, not a stray click, not a form.
    event.preventDefault();
    event.stopPropagation();
    if (!anchor || !isFollow(event)) return;
    const url = anchor.getAttribute("href") ?? "";
    if (url) onOpen?.(url);
  };
  // Capture phase, so nothing inside the message sees the click first.
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