import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const store = require("../lib/store.js");

/**
 * The state file is the only thing that survives a restart, so its rules are
 * tested as rules rather than through the watcher.
 */

test("an empty or hand-edited file loads as a clean first run", () => {
  assert.deepEqual(store.normalizeState(null), store.emptyState());
  assert.deepEqual(store.normalizeState("{not json"), store.emptyState());
  const recovered = store.normalizeState({ cursor: { uidValidity: "x" }, seen: "nope", pending: [{}] });
  assert.equal(recovered.cursor, null);
  assert.deepEqual(recovered.seen, []);
  assert.deepEqual(recovered.pending, []);
});

test("a cursor belongs to one UIDVALIDITY and is dropped when that changes", () => {
  const state = store.emptyState();
  store.setCursor(state, 7, 42);
  assert.deepEqual(store.cursorFor(state, 7), { uidValidity: 7, maxUid: 42 });
  assert.equal(store.cursorFor(state, 8), null, "a rebuilt mailbox starts a new baseline");
});

test("the cursor never moves backwards, even when an older UID is fetched", () => {
  const state = store.emptyState();
  store.setCursor(state, 7, 10);
  store.advanceCursor(state, 4);
  assert.equal(state.cursor.maxUid, 10);
  store.advanceCursor(state, 11);
  assert.equal(state.cursor.maxUid, 11);
});

test("the reported-message set is bounded and keeps the newest entries", () => {
  const state = store.emptyState();
  for (let index = 0; index < store.SEEN_LIMIT + 20; index += 1) {
    store.rememberSeen(state, `<${index}@example.com>`);
  }
  assert.equal(state.seen.length, store.SEEN_LIMIT);
  assert.equal(store.hasSeen(state, `<${store.SEEN_LIMIT + 19}@example.com>`), true);
  assert.equal(store.hasSeen(state, "<0@example.com>"), false);
});

test("a message without a Message-ID still gets a stable key", () => {
  assert.equal(store.messageKey({ uid: 5, uidValidity: 7, messageId: "" }), "uid:7:5");
  assert.equal(store.messageKey({ uid: 5, uidValidity: 7, messageId: "<a@b>" }), "<a@b>");
});

test("the digest queue counts a re-fetched message once and keeps its first time", () => {
  const state = store.emptyState();
  const entry = { uid: 3, uidValidity: 7, messageId: "<3@example.com>" };
  assert.equal(store.queueDigest(state, entry, 1_000), true);
  assert.equal(store.queueDigest(state, { ...entry, subject: "again" }, 5_000), false);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pendingSince, 1_000);
  const taken = store.takeDigest(state);
  assert.equal(taken.length, 1);
  assert.equal(state.pendingSince, null);
  assert.deepEqual(state.pending, []);
});

test("the queue cannot grow without a bound", () => {
  const state = store.emptyState();
  for (let index = 0; index < store.PENDING_LIMIT + 5; index += 1) {
    store.queueDigest(state, { uid: index, uidValidity: 7, messageId: `<${index}@x>`, from: {}, subject: "" }, 1);
  }
  assert.equal(state.pending.length, store.PENDING_LIMIT);
});

test("a POP3 baseline records what is already there, and announces nothing", () => {
  const state = store.emptyState();
  assert.equal(store.pop3Baselined(state), false, "an account starts unbaselined");
  store.pop3Baseline(state, ["AAA", "BBB", "AAA", 42, "two words"]);
  assert.equal(state.pop3.baselined, true);
  assert.deepEqual(state.pop3.uidls, ["AAA", "BBB"], "duplicates and values the protocol cannot carry are dropped");
  assert.equal(store.pop3Seen(state).has("BBB"), true);
});

test("handled POP3 UIDLs are bounded, newest kept, and survive a reload", () => {
  const state = store.emptyState();
  store.pop3Baseline(state, []);
  for (let index = 0; index < store.POP3_UIDL_LIMIT + 10; index += 1) {
    store.pop3Remember(state, `u${index}`);
  }
  assert.equal(state.pop3.uidls.length, store.POP3_UIDL_LIMIT);
  assert.equal(store.pop3Seen(state).has(`u${store.POP3_UIDL_LIMIT + 9}`), true);
  assert.equal(store.pop3Seen(state).has("u0"), false, "the oldest entries scroll out first");
  const reloaded = store.normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(reloaded.pop3.baselined, true);
  assert.equal(reloaded.pop3.uidls.length, store.POP3_UIDL_LIMIT);
  // A hand-edited file cannot smuggle in a value the protocol cannot carry.
  assert.deepEqual(store.normalizeState({ pop3: { baselined: true, uidls: ["ok", 5, "two words"] } }).pop3.uidls, ["ok"]);
  assert.equal(store.normalizeState({ pop3: "nope" }).pop3.baselined, false);
});

test("a POP3 message is named by its UIDL, not by a session's message number", () => {
  assert.equal(store.pop3Key("AB12"), "pop3:AB12");
  assert.equal(store.pop3Key(""), "");
  assert.equal(store.pop3Key(undefined), "");
  // The UIDL wins over a Message-ID when the caller computed it: a POP3 replay
  // must be recognised by the thing the server promises to keep.
  assert.equal(store.messageKey({ key: "pop3:AB12", messageId: "<x@y>", uid: 3 }), "pop3:AB12");
});
