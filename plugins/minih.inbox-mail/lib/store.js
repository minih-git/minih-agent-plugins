"use strict";

/**
 * What the plugin remembers between runs, and the rules that keep it small.
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
 * dropped first. A mailbox cannot grow this file, which matters because it lives
 * in the plugin's own data directory and nothing prunes it but this module.
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
/** The state file's own version, so a later change can migrate instead of guess. */
const STATE_VERSION = 1;

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
  base.pendingSince = Number.isFinite(raw.pendingSince) ? raw.pendingSince : null;
  base.lastCheckAt = Number.isFinite(raw.lastCheckAt) ? raw.lastCheckAt : null;
  base.lastDigestAt = Number.isFinite(raw.lastDigestAt) ? raw.lastDigestAt : null;
  base.lastError = typeof raw.lastError === "string" ? raw.lastError : null;
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

module.exports = {
  PENDING_LIMIT,
  SEEN_LIMIT,
  STATE_VERSION,
  advanceCursor,
  cursorFor,
  emptyState,
  hasSeen,
  messageKey,
  normalizeState,
  queueDigest,
  rememberSeen,
  setCursor,
  takeDigest,
};
