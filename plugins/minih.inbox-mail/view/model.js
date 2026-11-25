/**
 * The Inbox panel's own logic, as pure functions.
 *
 * Everything here can be tested without a document: which day group a message
 * belongs to, how a timestamp is shortened, what a search matches, which colour a
 * sender's avatar gets, and which key does what. The DOM code in `app.js` only
 * renders what these return, which is what keeps the rules in one place and
 * reviewable.
 *
 * The time rules follow the convention every mail client has converged on, and
 * which Mailspring spells out in `shortTimeString`: today shows a clock time,
 * this week a weekday and a time, this year a month and a day, anything older a
 * full date. A list that shows `2026-11-14 10:00` on every row wastes the only
 * wide column it has.
 */

/** The groups the list is split into, in display order. */
export const DAY_GROUPS = ["today", "yesterday", "thisWeek", "earlier"];

/** How many days back "this week" reaches, today included. */
const WEEK_DAYS = 7;

/** The filters the list offers, in display order. */
export const FILTERS = ["all", "unread", "starred", "important"];

/** Midday of the given timestamp's local day, for day arithmetic without DST traps. */
function dayOf(value) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

/** Whole days between two timestamps, counted by local calendar day. */
export function daysBetween(now, then) {
  const diff = dayOf(now).getTime() - dayOf(then).getTime();
  return Math.round(diff / 86_400_000);
}

/**
 * Which heading a message sits under.
 *
 * `thisWeek` is "the last seven days, today and yesterday excluded" rather than a
 * calendar week: a message from Sunday is still "this week" on Monday, which is
 * what a reader means by it.
 */
export function dayGroup(value, now = Date.now()) {
  if (!Number.isFinite(value)) return "earlier";
  const days = daysBetween(now, value);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < WEEK_DAYS) return "thisWeek";
  return "earlier";
}

/** A `Date` as `HH:mm` in the reader's locale. */
function clock(date, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  } catch {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
}

/**
 * The time a list row shows.
 *
 * Today: `14:30`. Within the last week: `周三 14:30`. Within the last year:
 * `11月14日`. Older: `2025年11月14日`. Every one of those is formatted by `Intl`
 * in the reader's locale, so the same rule reads correctly in English and Chinese
 * without a second table of words here.
 */
export function shortTime(value, { locale = "en", now = Date.now() } = {}) {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  const days = daysBetween(now, value);
  try {
    if (days <= 0) return clock(date, locale);
    if (days < WEEK_DAYS) {
      const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
      return `${weekday} ${clock(date, locale)}`;
    }
    const sameYear = new Date(now).getFullYear() === date.getFullYear();
    if (sameYear) return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** The reading pane's full timestamp: the date and the exact time. */
export function fullTime(value, { locale = "en" } = {}) {
  if (!Number.isFinite(value)) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

/**
 * A stable colour index for one address.
 *
 * Deterministic on purpose: the same sender must keep the same colour between
 * launches, or the avatar stops being a recognition cue. The palette itself lives
 * in the stylesheet, once per theme, so both themes stay readable.
 */
export function avatarColor(address) {
  const source = String(address ?? "").toLowerCase().trim();
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 8;
}

/** Whether one message matches a search query: sender, subject, summary, address. */
export function matchesQuery(message, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return true;
  const from = message?.from ?? {};
  const haystack = [
    from.name,
    from.address,
    message?.subject,
    message?.summary,
    message?.accountLabel,
  ]
    .filter(Boolean)
    .join(" \u0000 ")
    .toLowerCase();
  // Every word must appear somewhere, in any order: "boss invoice" finds the
  // invoice from the boss, which is what a reader types.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/** The filter each message has to pass, by name. */
const FILTER_TESTS = {
  all: () => true,
  unread: (message) => message.unread === true,
  starred: (message) => message.starred === true,
  important: (message) => message.important === true,
};

/**
 * The list, filtered and grouped.
 *
 * @returns `[{ id, items }]` in display order, empty groups dropped.
 */
export function groupMessages(messages, { accountId = "all", filter = "all", query = "", now = Date.now() } = {}) {
  const test = FILTER_TESTS[filter] ?? FILTER_TESTS.all;
  const buckets = new Map(DAY_GROUPS.map((id) => [id, []]));
  for (const message of Array.isArray(messages) ? messages : []) {
    if (accountId !== "all" && message.accountId !== accountId) continue;
    if (!test(message)) continue;
    if (!matchesQuery(message, query)) continue;
    const bucket = buckets.get(dayGroup(message.receivedAt, now));
    if (bucket) bucket.push(message);
  }
  return DAY_GROUPS.filter((id) => (buckets.get(id) ?? []).length > 0).map((id) => ({
    id,
    items: buckets.get(id),
  }));
}

/**
 * Up to two letters for an avatar.
 *
 * A displayed name is preferred, because it is what the reader recognises; the
 * address is the fallback for a sender that sent no name. CJK names have no case
 * and no useful initials, so their first character is used as it is.
 */
export function initials(name, address) {
  const source = String(name || address || "").trim();
  if (!source) return "?";
  const first = source.split(/[\s._-]+/).filter(Boolean)[0] ?? source;
  if (/^[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(first)) return source.slice(0, 1).toUpperCase();
  // A displayed name can carry two words ("Zhang San") and both initials read
  // well; an address cannot, because its dots are not word breaks, so only the
  // local part is used.
  if (!source.includes("@")) {
    const words = source.split(/[\s._-]+/).filter(Boolean);
    if (words.length >= 2) return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
  }
  return (source.includes("@") ? source.split("@")[0] : first).slice(0, 2).toUpperCase();
}

/** Every row the current filter shows, flattened: what j/k walks through. */
export function visibleMessages(messages, options) {
  return groupMessages(messages, options).flatMap((group) => group.items);
}

/** The row one step up or down, clamped to the list. */
export function stepIndex(current, delta, length) {
  if (!length) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}

/** The same message in two different lists, by account and key. */
export function sameMessage(one, other) {
  return Boolean(one && other && one.accountId === other.accountId && one.key === other.key);
}

/**
 * The recipients of a message, as one line and as a list.
 *
 * `发给 我 等 3 人` is what a reader wants at a glance; the full list is one click
 * away. `me` may be empty, in which case the sender's own address is what the
 * "to" list is compared against.
 */
export function recipientSummary(to, cc, { me = "" } = {}) {
  const toList = Array.isArray(to) ? to : [];
  const ccList = Array.isArray(cc) ? cc : [];
  const self = String(me ?? "").toLowerCase();
  const isMe = (entry) => Boolean(self) && String(entry?.address ?? "").toLowerCase() === self;
  const others = toList.length - toList.filter(isMe).length;
  const names = [];
  for (const entry of toList) {
    const label = entry?.name || entry?.address;
    if (label) names.push(label);
    if (names.length >= 3) break;
  }
  return {
    to: toList,
    cc: ccList,
    directlyToMe: toList.some(isMe),
    others,
    names,
    total: toList.length + ccList.length,
  };
}

/** A file's rough kind, for the attachment card's icon. */
export function fileKind(filename, mime = "") {
  const name = String(filename ?? "").toLowerCase();
  const type = String(mime ?? "").toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() : "";
  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(extension)) return "image";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (["doc", "docx", "rtf", "odt", "pages"].includes(extension)) return "doc";
  if (["xls", "xlsx", "csv", "ods", "numbers"].includes(extension)) return "sheet";
  if (["zip", "gz", "tar", "rar", "7z"].includes(extension)) return "archive";
  if (["ppt", "pptx", "key"].includes(extension)) return "slides";
  return "file";
}

/** A byte count as a short human string. */
export function formatBytes(bytes, locale = "en") {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 10 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  try {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rounded)} ${units[unit]}`;
  } catch {
    return `${rounded} ${units[unit]}`;
  }
}

/** What the attachment's subtitle says: `PDF · 240 KB`. */
export function attachmentMeta(file, locale) {
  const kind = fileKind(file?.filename);
  const label = { image: "IMG", pdf: "PDF", doc: "DOC", sheet: "XLS", archive: "ZIP", slides: "PPT", file: "FILE" }[kind];
  const size = formatBytes(file?.size, locale);
  return size === "—" ? label : `${label} · ${size}`;
}

/**
 * One key press as one action.
 *
 * The panel's shortcuts are single keys, so they must not fire while the reader is
 * typing in the search box, and must not swallow a shortcut the app itself uses
 * (`u` with a modifier is the app's, not this panel's). Everything else — j/k,
 * Enter, u, s, `#`, Delete, e, `/`, Escape — is unmodified, which is why the
 * modifier check comes first.
 */
export function keyboardAction(event, { inField = false } = {}) {
  if (!event || typeof event.key !== "string") return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key;
  if (inField) {
    // Escape is the one key a field still owns: it clears the search and closes
    // the reading pane, and the field itself is blurred by the caller.
    return key === "Escape" ? "clear" : null;
  }
  switch (key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "prev";
    case "Enter":
      return "open";
    case "u":
      return "toggleRead";
    case "s":
      return "toggleStar";
    case "#":
    case "Delete":
    case "Backspace":
      return key === "Backspace" ? null : "delete";
    case "e":
      return "archive";
    case "/":
      return "search";
    // Since 0.5.0 the panel answers mail too: `c` writes, `r` replies, `a`
    // replies to everyone and `f` forwards. All four are unmodified single keys,
    // like the rest of this list, and none of them fires while the user is typing
    // in a field.
    case "c":
      return "compose";
    case "r":
      return "reply";
    case "a":
      return "replyAll";
    case "f":
      return "forward";
    case "Escape":
      return "close";
    default:
      return null;
  }
}

/** The URL a link points at is only openable through the host; the rest is text. */
export function isOpenableLink(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim()) || /^mailto:/i.test(String(value ?? "").trim());
}

/**
 * One address as a mail client writes it: a local part, one `@`, a real domain.
 *
 * The same rule `lib/compose.js` applies before it puts an address in an envelope
 * — that file's `ADDRESS` constant is the authority, and a value this panel lets
 * through and that one refuses becomes a coded refusal in the composer, so the
 * two must agree.
 */
export const ADDRESS_INPUT =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Whether one value is a bare address this panel will accept. */
export function isValidAddress(value) {
  const text = String(value ?? "").trim();
  return text.length <= 320 && ADDRESS_INPUT.test(text);
}

/**
 * What a chip input holds as one value: `"Ann Lee" <ann@example.com>` or a bare
 * address, in one entry or several separated by comma, semicolon or whitespace.
 *
 * A pasted list of recipients becomes several chips, which is what a user
 * expects from pasting `a@b.com; c@d.com` into a mail form; anything that is not
 * an address is returned in `invalid` so the composer can say so instead of
 * silently dropping it.
 */
export function parseRecipientInput(value) {
  const entries = [];
  const invalid = [];
  const source = String(value ?? "");
  let current = "";
  let quoted = false;
  const commit = () => {
    const text = current.trim();
    current = "";
    if (!text) return;
    const angled = /^(.*)<([^<>]+)>\s*$/.exec(text);
    if (angled) {
      const address = angled[2].trim();
      if (!isValidAddress(address)) {
        invalid.push(text);
        return;
      }
      const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
      entries.push({ name, address });
      return;
    }
    // A pasted list can be space-separated as well as comma-separated: every word
    // has to be an address of its own, or the whole value is reported as invalid.
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      if (words.every(isValidAddress)) {
        for (const word of words) entries.push({ name: "", address: word });
        return;
      }
      invalid.push(text);
      return;
    }
    if (!isValidAddress(text)) {
      invalid.push(text);
      return;
    }
    entries.push({ name: "", address: text });
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && /[,;\r\n\t]/.test(char)) {
      commit();
      continue;
    }
    // A space only separates two addresses when it is not part of a display name
    // and there is no angle bracket on the way: `Ann Lee <a@b.com>` is one entry.
    current += char;
  }
  commit();
  return { entries, invalid };
}

/** How a chip reads: the display name when there is one, the address otherwise. */
export function chipLabel(entry) {
  return String(entry?.name || entry?.address || "").trim();
}

/** The total bytes of a set of attachments, ignoring anything unreadable. */
export function totalBytes(list) {
  return (Array.isArray(list) ? list : []).reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
}