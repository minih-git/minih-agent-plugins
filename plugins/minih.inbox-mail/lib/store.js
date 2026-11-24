"use strict";

/**
 * One account's memory, and the rules that keep it small.
 *
 * Two questions the restart path has to answer, and they pull in opposite
 * directions:
 *
 *   - "do not alert me twice" needs the Message-IDs already reported, so a
 *     restart, a reconnect or a second copy of the same message stays quiet;
 *   - "do not miss mail" needs a UID cursor, because an ID set alone cannot
 *     tell new mail from mail that arrived while the app was closed.
 *
 * Both are stored, and both are bounded: the UID high-water mark is a single
 * number, and the ID set is capped at `SEEN_LIMIT` with the oldest entries
 * dropped first.
 *
 * Since 0.2.0 this file holds one account's state, not the plugin's: the
 * account list lives in `lib/accounts.js`, and every account gets its own copy
 * of this shape, so adding or removing a mailbox cannot disturb another one's
 * cursor.
 *
 * The third thing kept here is the envelope list the Inbox panel shows: the
 * newest `MESSAGES_LIMIT` messages per account, with the fields 0.1.0 already
 * fetched (sender, subject, date, flags) and nothing else. A message body is
 * never stored — the panel asks for it when the user opens that one message.
 *
 * A `UIDVALIDITY` change is handled by throwing the cursor away and re-baselining
 * on the server's own `UIDNEXT`: after such a change every UID refers to a
 * different message, so reusing one would either replay the whole mailbox as new
 * or skip everything that is actually new.
 */

/** How many reported Message-IDs are kept. */
const SEEN_LIMIT = 200;
/** How many messages wait in one digest before it is posted early. */
const PENDING_LIMIT = 50;
/** How many envelopes the panel can show per account. */
const MESSAGES_LIMIT = 200;
/** The state file's own version, so a later change can migrate instead of guess. */
const STATE_VERSION = 2;

/** Text fields come from a mail server, so they are cut before they are stored. */
const MAX_SUBJECT = 300;
const MAX_NAME = 120;
const MAX_ADDRESS = 320;
const MAX_MESSAGE_ID = 400;

function emptyState() {
  return {
    version: STATE_VERSION,
    cursor: null,
    seen: [],
    pending: [],
    pendingSince: null,
    lastCheckAt: null,
    lastDigestAt: null,
    lastError: null,
    messages: [],
  };
}

function text(value, limit) {
  const source = typeof value === "string" ? value : "";
  return source.length > limit ? source.slice(0, limit) : source;
}

/** One stored envelope, normalized; `null` when it cannot name a message. */
function normalizeEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const key = typeof raw.key === "string" ? text(raw.key, MAX_MESSAGE_ID) : "";
  if (!key) return null;
  const uid = Number.isInteger(raw.uid) ? raw.uid : null;
  if (uid === null) return null;
  const from = raw.from && typeof raw.from === "object" ? raw.from : {};
  return {
    key,
    uid,
    uidValidity: Number.isInteger(raw.uidValidity) ? raw.uidValidity : null,
    messageId: text(raw.messageId, MAX_MESSAGE_ID),
    from: {
      name: text(from.name, MAX_NAME),
      address: text(from.address, MAX_ADDRESS),
    },
    subject: text(raw.subject, MAX_SUBJECT),
    receivedAt: Number.isFinite(raw.receivedAt) ? raw.receivedAt : null,
    flags: Array.isArray(raw.flags)
      ? raw.flags.filter((flag) => typeof flag === "string" && flag.startsWith("\\")).slice(0, 12)
      : [],
    important: raw.important === true,
  };
}

/** Anything on disk is treated as untrusted: an old or hand-edited file loads empty. */
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const cursor = raw.cursor;
  if (cursor && typeof cursor === "object" && Number.isInteger(cursor.uidValidity) && Number.isInteger(cursor.maxUid)) {
    base.cursor = { uidValidity: cursor.uidValidity, maxUid: cursor.maxUid };
  }
  if (Array.isArray(raw.seen)) {
    base.seen = raw.seen.filter((id) => typeof id === "string" && id).slice(-SEEN_LIMIT);
  }
  if (Array.isArray(raw.pending)) {
    base.pending = raw.pending
      .filter((entry) => entry && typeof entry === "object" && typeof entry.messageId === "string")
      .slice(-PENDING_LIMIT);
  }
  if (Array.isArray(raw.messages)) {
    base.messages = raw.messages
      .map(normalizeEnvelope)
      .filter(Boolean)
      .slice(0, MESSAGES_LIMIT);
  }
  base.pendingSince = Number.isFinite(raw.pendingSince) ? raw.pendingSince : null;
  base.lastCheckAt = Number.isFinite(raw.lastCheckAt) ? raw.lastCheckAt : null;
  base.lastDigestAt = Number.isFinite(raw.lastDigestAt) ? raw.lastDigestAt : null;
  base.lastError = typeof raw.lastError === "string" ? text(raw.lastError, 400) : null;
  return base;
}

/**
 * The cursor this mailbox can continue from, or `null` when it must be rebuilt.
 *
 * `null` is not an error: it is the first run of a mailbox, or a mailbox whose
 * `UIDVALIDITY` changed, and both mean "watch from here on" rather than "import
 * the archive".
 */
function cursorFor(state, uidValidity) {
  if (!state.cursor) return null;
  if (state.cursor.uidValidity !== uidValidity) return null;
  return state.cursor;
}

/** Baseline a mailbox at `maxUid`, which becomes the highest already-handled UID. */
function setCursor(state, uidValidity, maxUid) {
  state.cursor = { uidValidity, maxUid };
  return state.cursor;
}

/** Advance the cursor, never backwards: a replayed FETCH must not re-open mail. */
function advanceCursor(state, uid) {
  if (!state.cursor || !Number.isInteger(uid)) return state.cursor;
  if (uid > state.cursor.maxUid) state.cursor.maxUid = uid;
  return state.cursor;
}

/**
 * The key a repeated report is deduplicated on.
 *
 * `Message-ID` is what the sender chose and what survives a reconnect, so it is
 * preferred; a message without one falls back to its UID inside its own
 * `UIDVALIDITY`, which is just as stable for as long as the mailbox is.
 */
function messageKey(message) {
  if (typeof message.messageId === "string" && message.messageId) return message.messageId;
  return `uid:${message.uidValidity ?? 0}:${message.uid}`;
}

function hasSeen(state, key) {
  return state.seen.includes(key);
}

/** Remember a reported message, oldest entries first to go. */
function rememberSeen(state, key) {
  if (!key || state.seen.includes(key)) return false;
  state.seen.push(key);
  if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT);
  return true;
}

/**
 * Queue a message for the next digest.
 *
 * The queue is keyed by the same message key, so a message that is re-fetched
 * after a reconnect is counted once. The first queue time is kept as the digest
 * anchor; that is what makes "every 30 minutes" mean thirty minutes after the
 * first message, not thirty minutes after the last one.
 */
function queueDigest(state, entry, now) {
  const key = messageKey(entry);
  if (state.pending.some((item) => messageKey(item) === key)) return false;
  state.pending.push(entry);
  if (state.pending.length > PENDING_LIMIT) state.pending.splice(0, state.pending.length - PENDING_LIMIT);
  if (state.pendingSince === null) state.pendingSince = now;
  return true;
}

/** Take everything queued, clearing the anchor with it. */
function takeDigest(state) {
  const entries = state.pending;
  state.pending = [];
  state.pendingSince = null;
  return entries;
}

/**
 * Add or update one message in the panel's list.
 *
 * Newest first, one entry per message key, and the list never grows past
 * `MESSAGES_LIMIT`: a mailbox cannot make this file large, which matters
 * because it lives in the plugin's own data folder and nothing prunes it but
 * this module.
 */
function recordEnvelope(state, envelope) {
  const entry = normalizeEnvelope(envelope);
  if (!entry) return null;
  const index = state.messages.findIndex((item) => item.key === entry.key);
  if (index >= 0) {
    // A re-fetch of the same message refreshes the envelope facts and keeps the
    // flags the server just reported, so a re-read cannot resurrect an old star.
    state.messages[index] = { ...state.messages[index], ...entry };
  } else {
    state.messages.push(entry);
  }
  state.messages.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || b.uid - a.uid);
  if (state.messages.length > MESSAGES_LIMIT) state.messages.length = MESSAGES_LIMIT;
  return entry;
}

function findEnvelope(state, key) {
  return state.messages.find((item) => item.key === key) ?? null;
}

/** Replace one message's flags with what the server reported. */
function setFlags(state, key, flags) {
  const entry = findEnvelope(state, key);
  if (!entry || !Array.isArray(flags)) return null;
  entry.flags = flags.filter((flag) => typeof flag === "string" && flag.startsWith("\\")).slice(0, 12);
  return entry.flags;
}

/**
 * The flags a user's click produces.
 *
 * `flag` is one of the four the panel offers; anything else changes nothing, so
 * a stray message from a page cannot invent a flag this plugin never sets.
 */
function applyFlag(flags, flag) {
  const current = new Set(Array.isArray(flags) ? flags : []);
  switch (flag) {
    case "seen":
      current.add("\\Seen");
      break;
    case "unseen":
      current.delete("\\Seen");
      break;
    case "flagged":
      current.add("\\Flagged");
      break;
    case "unflagged":
      current.delete("\\Flagged");
      break;
    default:
      return null;
  }
  return [...current];
}

/** The IMAP STORE one click sends: exactly one flag add or remove. */
function flagChange(flag) {
  switch (flag) {
    case "seen":
      return { add: ["\\Seen"], remove: [] };
    case "unseen":
      return { add: [], remove: ["\\Seen"] };
    case "flagged":
      return { add: ["\\Flagged"], remove: [] };
    case "unflagged":
      return { add: [], remove: ["\\Flagged"] };
    default:
      return null;
  }
}

module.exports = {
  MESSAGES_LIMIT,
  PENDING_LIMIT,
  SEEN_LIMIT,
  STATE_VERSION,
  advanceCursor,
  applyFlag,
  cursorFor,
  emptyState,
  findEnvelope,
  flagChange,
  hasSeen,
  messageKey,
  normalizeEnvelope,
  normalizeState,
  queueDigest,
  recordEnvelope,
  rememberSeen,
  setCursor,
  setFlags,
  takeDigest,
};
