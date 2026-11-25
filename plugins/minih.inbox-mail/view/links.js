/**
 * What a link in a message means, once it is clicked or pointed at.
 *
 * A link is untrusted input like the rest of a message: it can claim to be one
 * address and open another, and a `mailto:` can carry a whole draft in its query
 * string. These functions are pure so the rules can be read and tested without a
 * browser, and the panel only decides where to put the result.
 */

/**
 * The host an `http(s)` URL opens, without `www.`, or `""` for anything else.
 *
 * Only http and https: a `mailto:` has no host to show, and a scheme this plugin
 * does not open has no business being described in a status line.
 */
export function hostOf(url) {
  try {
    const parsed = new URL(String(url ?? ""));
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The part of a host two addresses have to share to be the same site.
 *
 * `login.your-bank.com` and `your-bank.com` are the same site; `your-bank.com` and
 * `your-bank.example` are not. A two-label suffix such as `co.uk` or `com.cn` keeps
 * three labels, because `bank.co.uk` and `evil.co.uk` share `co.uk` and nothing else.
 */
function siteOf(host) {
  const labels = String(host ?? "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tail = labels.slice(-2).join(".");
  return /^(?:co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(tail) ? labels.slice(-3).join(".") : tail;
}

/** Every host a piece of link text looks like it is pointing at. */
function hostsInText(text) {
  const source = String(text ?? "");
  const hosts = [];
  const pattern = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\s/?#:.,;!)\]]|$)/gi;
  for (const match of source.matchAll(pattern)) hosts.push(match[1].toLowerCase());
  return hosts;
}

/**
 * Whether the words of a link name a different site than the one it opens.
 *
 * This is the phish a mail client can actually catch: `<a href="https://evil.example">`
 * around the text `https://your-bank.com/login`. Text with no host-looking words in
 * it (`Click here`, `Invoice INV-9931`) never warns — most mail is written that way,
 * and a warning on every link is a warning on none. A URL with no http(s) host
 * (`mailto:`, a broken percent-encoding) never warns either: there is nothing to
 * compare and nothing that looks like a destination.
 */
export function linkDisguise(text, url) {
  const target = hostOf(url);
  if (!target) return false;
  const shown = hostsInText(text);
  if (!shown.length) return false;
  return shown.some((host) => siteOf(host) !== siteOf(target));
}

/**
 * `mailto:` → the fields the composer fills in, or `null` when it is not a mailto.
 *
 * `mailto:ann@example.com?cc=cara@example.com&subject=Re%3A%20invoice&body=Hello`
 * is the whole format: the recipients before the `?`, then `subject`, `body`, `cc`
 * and `bcc` as query parameters. Only those four are read — an `attach` or a
 * `in-reply-to` is not something a message gets to decide — and every value is
 * percent-decoded once. `+` stays a plus: RFC 6068 escapes a space as `%20`, so a
 * `+` that survives into the composer is one the sender typed.
 */
export function parseMailto(url) {
  const text = String(url ?? "").trim();
  const match = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(text);
  if (!match) return null;
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const addresses = (value) =>
    String(value ?? "")
      .split(",")
      .map((one) => decode(one).trim())
      .filter((one) => one.includes("@"));
  // Hand-rolled, not `URLSearchParams`: that one reads `+` as a space, which is a
  // form convention and not what RFC 6068 says a mailto means.
  const params = new Map();
  for (const pair of String(match[2] ?? "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decode(eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    if (!key) continue;
    params.set(key, eq < 0 ? "" : decode(pair.slice(eq + 1)));
  }
  const field = (name) => params.get(name) ?? "";
  return {
    to: addresses(match[1]),
    cc: addresses(field("cc")),
    bcc: addresses(field("bcc")),
    subject: field("subject").trim().slice(0, 300),
    body: field("body"),
  };
}

/**
 * Whether one event is a request to follow the link it came from.
 *
 * This is the whole security-shaped decision of the reading pane, so it is a pure
 * function with no DOM in it: the frame passes the event's type, key and modifiers
 * plus whether the target sits inside a link, and gets back whether to intercept.
 *
 * Everything a message body can be used for besides opening a link is *not* this
 * event, and must be left alone: copying a selected invoice number (⌘C / Ctrl+C),
 * selecting all, moving the caret or scrolling with the arrow keys and Space,
 * pressing Enter in the middle of a paragraph, a right-click, a click on plain text.
 * Interception that fires first and checks afterwards is how a mail body ends up
 * unable to be copied from — so the default answer is "no", and a link has to be
 * the target of the event for the answer to become "yes".
 */
export function linkEventIntercept(event, inLink = false) {
  if (!event || !inLink) return false;
  if (event.type === "click") return true;
  // Middle click opens a link on Windows and Linux; a right click belongs to the
  // context menu, and the other buttons do nothing here either.
  if (event.type === "auxclick") return event.button === 1;
  if (event.type === "keydown") {
    // Enter activates a focused link. Space scrolls the page, and a modified Enter
    // is a shortcut (⌘Enter, Shift+Enter), not an activation of anything.
    return event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }
  return false;
}