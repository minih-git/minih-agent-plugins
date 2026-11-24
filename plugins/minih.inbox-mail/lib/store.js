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
 *
 * A POP3 account keeps a different cursor in the same file: `pop3.baselined`
 * says whether the first poll has happened, and `pop3.uidls` holds the UIDLs
 * already handled (bounded), because a POP3 message number only holds inside one
 * session and a UIDVALIDITY does not exist there at all.
 */

/** How many reported Message-IDs are kept. */
const SEEN_LIMIT = 200;
/**
 * How many POP3 UIDLs are kept.
 *
 * POP3 has no UIDVALIDITY and no UID: the only stable name of a message is the
 * UIDL the server invents for it, so the set of UIDLs already handled is what
 * stops a five-minute poll from re-announcing the same mail. It is larger than
 * `SEEN_LIMIT` because a mailbox read elsewhere still has to remember more than
 * the last 200 arrivals before the window scrolls past them.
 */
const POP3_UIDL_LIMIT = 500;
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
    // POP3 keeps its own cursor: which UIDLs have been handled, and whether the
    // first poll has happened yet — that one only records a baseline.
    pop3: { baselined: false, uidls: [], read: [] },
  };
}

function text(value, limit) {
  const source = typeof value === "string" ? value : "";
  return source.length > limit ? source.slice(0, limit) : source;
}

/** A UIDL is printable ASCII without whitespace, at most 70 characters. */
function isUidl(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 70 && !/[\s\u0000-\u001f\u007f]/.test(value);
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
  const pop3 = raw.pop3 && typeof raw.pop3 === "object" && !Array.isArray(raw.pop3) ? raw.pop3 : {};
  base.pop3.baselined = pop3.baselined === true;
  if (Array.isArray(pop3.uidls)) {
    base.pop3.uidls = pop3.uidls.filter((uidl) => isUidl(uidl)).slice(-POP3_UIDL_LIMIT);
  }
  if (Array.isArray(pop3.read)) {
    base.pop3.read = pop3.read.filter((key) => typeof key === "string" && key).slice(-POP3_UIDL_LIMIT);
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
 * The key a POP3 message is known by, for its whole life.
 *
 * A POP3 message number is only valid inside one session: delete one mail
 * anywhere and every number after it moves. The UIDL is what the server
 * guarantees to be permanent, so it is the key the panel, the digest queue and
 * the notifications use, and the number is looked up again on each session.
 */
function pop3Key(uidl) {
  return isUidl(uidl) ? `pop3:${uidl}` : "";
}

/** The UIDLs this account has already handled, newest last. */
function pop3Seen(state) {
  return new Set(state.pop3.uidls);
}

/** Whether the first poll has happened; until it has, nothing is announced. */
function pop3Baselined(state) {
  return state.pop3.baselined === true;
}

/** Record a mailbox's whole UID set as "already there" without announcing it. */
function pop3Baseline(state, uidls) {
  const seen = [];
  for (const uidl of Array.isArray(uidls) ? uidls : []) {
    if (!isUidl(uidl) || seen.includes(uidl)) continue;
    seen.push(uidl);
  }
  state.pop3.baselined = true;
  state.pop3.uidls = seen.slice(-POP3_UIDL_LIMIT);
  return state.pop3.uidls;
}

/**
 * Remember that this machine opened one POP3 message.
 *
 * POP3 has no read flag the server would keep, so "read" here means "opened on
 * this computer": it is a local mark, bounded like the UIDL set, and it exists so
 * the list and the unread count can follow what the user has actually looked at.
 */
function markReadLocally(state, key) {
  if (!key || state.pop3.read.includes(key)) return state.pop3.read;
  state.pop3.read.push(key);
  if (state.pop3.read.length > POP3_UIDL_LIMIT) {
    state.pop3.read.splice(0, state.pop3.read.length - POP3_UIDL_LIMIT);
  }
  return state.pop3.read;
}

/** Whether this machine has opened that POP3 message. */
function hasReadLocally(state, key) {
  return Boolean(key) && state.pop3.read.includes(key);
}

/** Mark one POP3 message unread again: drop it from the local record. */
function clearReadLocally(state, key) {
  state.pop3.read = state.pop3.read.filter((entry) => entry !== key);
  return state.pop3.read;
}

/** Remember one handled UIDL, oldest entries first to go. */
function pop3Remember(state, uidl) {
  if (!isUidl(uidl) || state.pop3.uidls.includes(uidl)) return false;
  state.pop3.uidls.push(uidl);
  if (state.pop3.uidls.length > POP3_UIDL_LIMIT) {
    state.pop3.uidls.splice(0, state.pop3.uidls.length - POP3_UIDL_LIMIT);
  }
  return true;
}

/**
 * The key a repeated report is deduplicated on.
 *
 * `Message-ID` is what the sender chose and what survives a reconnect, so it is
 * preferred; a message without one falls back to its UID inside its own
 * `UIDVALIDITY`, which is just as stable for as long as the mailbox is.
 */
function messageKey(message) {
  // A POP3 message has no UID to fall back on: its message number only holds
  // inside one session, so its caller passes the UIDL-derived key it computed.
  if (typeof message.key === "string" && message.key) return message.key;
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
  POP3_UIDL_LIMIT,
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
  clearReadLocally,
  hasReadLocally,
  markReadLocally,
  pop3Baselined,
  pop3Baseline,
  pop3Key,
  pop3Remember,
  pop3Seen,
  queueDigest,
  recordEnvelope,
  rememberSeen,
  setCursor,
  setFlags,
  takeDigest,
};
