"use strict";

/**
 * Which new message is worth an interruption, decided without a model.
 *
 * The user's decision for this slice is that collection, de-duplication, the
 * importance rule and the notification all cost nothing: no provider call, no
 * token, no reasoning. A rule that can be explained in one sentence is therefore
 * the feature, not a placeholder for one — and because it is a pure function it
 * can be tested against the cases that matter instead of "it felt right on my
 * mailbox".
 *
 * The rule:
 *
 *   - the sender is on the important-sender list, or
 *   - the subject or the sender's name contains one of the keywords, or
 *   - the message is flagged urgent by its own headers (`Importance: high`,
 *     `X-Priority: 1`) — the sender already decided for the user
 *
 *   → one `alert` per message; everything else is rolled into one `digest`.
 *
 * Importance is a property of the message and the settings only: nothing here
 * reads a clock, the network, or previously seen mail, so the same inputs always
 * produce the same verdict.
 */

/** `"a@b.com, 老板\n财务"` -> `["a@b.com", "老板", "财务"]`. */
function splitList(value) {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,;，；]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * One important-sender entry against one sender.
 *
 * Three shapes, because a list typed by a person contains all three:
 * a full address (`boss@example.com`) matches that address, a domain
 * (`@example.com`) matches any address there, and a bare word matches the start
 * of the address (`finance@…`, `财务部@…`) or anywhere in the display name.
 */
function matchesSender(entry, from) {
  const needle = lower(entry);
  if (!needle) return false;
  const address = lower(from?.address);
  const name = lower(from?.name);
  if (needle.includes("@")) {
    if (needle.startsWith("@")) return address.endsWith(needle);
    return address === needle;
  }
  // A bare word is the local part's prefix or part of the display name: the two
  // things a person types when they mean "mail from finance".
  if (address.startsWith(needle)) return true;
  return Boolean(name) && name.includes(needle);
}

function matchesKeyword(entry, message) {
  const needle = lower(entry);
  if (!needle) return false;
  return lower(message.subject).includes(needle) || lower(message.from?.name).includes(needle);
}

/**
 * Whether the message says it is urgent.
 *
 * `X-Priority: 1` and `Importance: high` are what Outlook and most clients set
 * for "high"; `X-MSMail-Priority: High` is the third spelling in the wild, and
 * `X-Priority: 2` (high in a five-step scale) is deliberately *not* accepted:
 * a rule with one threshold is one a user can predict.
 */
function isUrgent(headers, message) {
  const importance = lower(headers.get("importance") ?? message.importance);
  if (importance === "high" || importance === "urgent") return true;
  const priority = String(headers.get("x-priority") ?? message.xPriority ?? "").trim();
  if (priority === "1") return true;
  const microsoft = lower(headers.get("x-msmail-priority") ?? message.msPriority);
  return microsoft === "high";
}

/**
 * The verdict for one message: `alert` with the reasons, or `digest`.
 *
 * The reasons are kept so the notification can say why the user is being
 * interrupted; a rule nobody can see is a rule nobody trusts.
 */
function classify(message, settings, headers = new Map()) {
  const reasons = [];
  const senders = splitList(settings?.importantSenders);
  const keywords = splitList(settings?.keywords);
  const sender = senders.find((entry) => matchesSender(entry, message.from));
  if (sender) reasons.push({ kind: "sender", value: sender });
  const keyword = keywords.find((entry) => matchesKeyword(entry, message));
  if (keyword) reasons.push({ kind: "keyword", value: keyword });
  if (isUrgent(headers, message)) reasons.push({ kind: "header", value: "urgent" });
  return { level: reasons.length ? "alert" : "digest", reasons };
}

/** Distinct senders of a batch, most-mentioned first, capped for the body. */
function digestSenders(entries, limit = 5) {
  const counts = new Map();
  for (const entry of entries) {
    const key = entry.from?.address || entry.from?.name || "unknown";
    const label = entry.from?.name || entry.from?.address || "unknown";
    const current = counts.get(key);
    // The first label wins: a display name that changes mid-batch must not make
    // the summary flip between two names for the same sender.
    counts.set(key, { label: current?.label ?? label, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

module.exports = {
  classify,
  digestSenders,
  isUrgent,
  matchesKeyword,
  matchesSender,
  splitList,
};
