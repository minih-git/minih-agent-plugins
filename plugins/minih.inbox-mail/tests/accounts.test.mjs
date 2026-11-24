import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const accounts = require("../lib/accounts.js");
const store = require("../lib/store.js");

/**
 * The data file: one slice per account, and the 0.1.0 upgrade.
 *
 * Two failures would be invisible until a user notices missing mail — a state
 * that is shared where it must be separate, and an upgrade that silently drops
 * the cursor — so both are asserted directly on the file shape.
 */

test("each account keeps its own cursor, reported IDs and message list", () => {
  const root = accounts.emptyRoot();
  const first = accounts.accountState(root, "acc_1");
  const second = accounts.accountState(root, "acc_2");
  store.setCursor(first, 7, 10);
  store.rememberSeen(first, "<a@example.com>");
  store.setCursor(second, 7, 3);
  store.recordEnvelope(second, { key: "<b@example.com>", uid: 3, receivedAt: 10 });
  assert.equal(first.cursor.maxUid, 10);
  assert.equal(second.cursor.maxUid, 3);
  assert.deepEqual(first.seen, ["<a@example.com>"]);
  assert.deepEqual(second.seen, []);
  assert.equal(first.messages.length, 0);
  assert.equal(second.messages.length, 1);
});

test("an account the host no longer lists is dropped with its provider", () => {
  const root = accounts.emptyRoot();
  accounts.accountState(root, "acc_1");
  accounts.accountState(root, "acc_2");
  accounts.setProvider(root, "acc_2", "gmail");
  const removed = accounts.retainAccounts(root, ["acc_1"]);
  assert.deepEqual(removed, ["acc_2"]);
  assert.deepEqual(Object.keys(root.accounts), ["acc_1"]);
  assert.deepEqual(root.providers, {});
});

test("the 0.1.0 file is adopted by the one migrated instance, with its provider", () => {
  const root = accounts.emptyRoot();
  const legacy = {
    version: 1,
    cursor: { uidValidity: 7, maxUid: 42 },
    seen: ["<old@example.com>"],
    pending: [{ uid: 42, uidValidity: 7, messageId: "<old@example.com>" }],
    pendingSince: 1000,
    lastCheckAt: 2000,
    lastError: "IMAP_TIMEOUT: timeout",
  };
  accounts.adoptLegacy(root, "acc_1", legacy, "qq");
  const state = root.accounts.acc_1;
  assert.deepEqual(state.cursor, { uidValidity: 7, maxUid: 42 });
  assert.deepEqual(state.seen, ["<old@example.com>"]);
  assert.equal(state.pending.length, 1);
  assert.equal(state.lastCheckAt, 2000);
  assert.equal("version" in state, false, "the file's version belongs to the file");
  assert.equal(accounts.providerOf(root, "acc_1").id, "qq");
});

test("adopting the legacy file twice leaves the same state", () => {
  const root = accounts.emptyRoot();
  const legacy = { cursor: { uidValidity: 9, maxUid: 5 }, seen: ["<x>"] };
  accounts.adoptLegacy(root, "acc_1", legacy, "netease163");
  const first = JSON.stringify(root);
  accounts.adoptLegacy(root, "acc_1", legacy, "netease163");
  // A retry after a partial failure finishes the same migration; it does not
  // duplicate or renumber anything.
  assert.equal(JSON.stringify(root), first);
});

test("an unknown provider id is refused instead of guessed", () => {
  const root = accounts.emptyRoot();
  accounts.accountState(root, "acc_1");
  assert.equal(accounts.setProvider(root, "acc_1", "aol"), null);
  assert.equal(root.providers.acc_1, undefined);
});

test("a hand-edited file cannot smuggle a provider onto a missing account", () => {
  const root = accounts.normalizeRoot({
    version: 2,
    accounts: { acc_1: { messages: [{ key: "<k>", uid: 1, flags: ["\\Seen"], subject: "s" }] } },
    providers: { acc_1: "gmail", acc_ghost: "qq" },
  });
  assert.equal(root.accounts.acc_1.messages.length, 1);
  assert.equal(root.accounts.acc_1.messages[0].flags[0], "\\Seen");
  assert.equal(root.providers.acc_ghost, undefined);
});

test("a stored envelope keeps only the fields the panel needs", () => {
  const root = accounts.emptyRoot();
  const state = accounts.accountState(root, "acc_1");
  store.recordEnvelope(state, {
    key: "<k@example.com>",
    uid: 4,
    uidValidity: 7,
    messageId: "<k@example.com>",
    from: { name: "Boss", address: "boss@example.com" },
    subject: "hello",
    receivedAt: 1234,
    flags: ["\\Seen", "\\Flagged", "\\Answered"],
    important: true,
    body: "this must not be stored",
    html: "<p>neither must this</p>",
  });
  const [saved] = state.messages;
  assert.equal(saved.important, true);
  assert.deepEqual(saved.flags, ["\\Seen", "\\Flagged", "\\Answered"]);
  assert.equal("body" in saved, false);
  assert.equal("html" in saved, false);
});

test("the message list is bounded per account and ordered newest first", () => {
  const root = accounts.emptyRoot();
  const state = accounts.accountState(root, "acc_1");
  for (let uid = 1; uid <= store.MESSAGES_LIMIT + 25; uid += 1) {
    store.recordEnvelope(state, { key: `<${uid}@x>`, uid, receivedAt: uid });
  }
  assert.equal(state.messages.length, store.MESSAGES_LIMIT);
  assert.equal(state.messages[0].uid, store.MESSAGES_LIMIT + 25);
  assert.equal(state.messages.every((message, index, list) => index === 0 || list[index - 1].receivedAt >= message.receivedAt), true);
});
