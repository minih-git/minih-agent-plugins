import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAY_GROUPS,
  FILTERS,
  attachmentMeta,
  avatarColor,
  dayGroup,
  fileKind,
  formatBytes,
  fullTime,
  groupMessages,
  initials,
  keyboardAction,
  matchesQuery,
  recipientSummary,
  sameMessage,
  shortTime,
  stepIndex,
  visibleMessages,
} from "../view/model.js";

/**
 * The panel's rules, without a document.
 *
 * These are the decisions a reader notices when they are wrong: which heading a
 * message sits under, how its time is written, what a search matches, which colour
 * a sender gets, and whether pressing `j` in the search box moves the list. Each
 * one is checked against a fixed clock so the test does not depend on today.
 */

/** One fixed local noon, so day arithmetic never crosses a real boundary. */
const NOW = new Date(2026, 10, 14, 15, 30, 0, 0).getTime();
const DAY = 86_400_000;

const message = (overrides = {}) => ({
  accountId: "acc_1",
  accountLabel: "owner@example.com",
  flagsSupported: true,
  key: `k${overrides.uid ?? 1}`,
  uid: 1,
  from: { name: "Boss", address: "boss@example.com" },
  subject: "Quarterly numbers",
  receivedAt: NOW - 60_000,
  unread: true,
  starred: false,
  important: false,
  summary: "The numbers are attached.",
  hasAttachments: true,
  ...overrides,
});

test("the four headings are the ones the list draws", () => {
  assert.deepEqual(DAY_GROUPS, ["today", "yesterday", "thisWeek", "earlier"]);
  assert.deepEqual(FILTERS, ["all", "unread", "starred", "important"]);
});

test("a message is grouped by its local calendar day, not by 24-hour blocks", () => {
  assert.equal(dayGroup(NOW, NOW), "today");
  assert.equal(dayGroup(NOW - DAY, NOW), "yesterday");
  assert.equal(dayGroup(NOW - 3 * DAY, NOW), "thisWeek");
  assert.equal(dayGroup(NOW - 6 * DAY, NOW), "thisWeek");
  assert.equal(dayGroup(NOW - 7 * DAY, NOW), "earlier");
  assert.equal(dayGroup(NOW - 400 * DAY, NOW), "earlier");
  // A message without a usable date is "earlier" rather than nowhere.
  assert.equal(dayGroup(null, NOW), "earlier");
});

test("a row's time is short, and gets longer the older the message is", () => {
  // Today: a clock time.
  assert.match(shortTime(NOW - 60_000, { locale: "en", now: NOW }), /^\d{2}:\d{2}$/);
  // This week: a weekday and a time.
  assert.match(shortTime(NOW - 3 * DAY, { locale: "en", now: NOW }), /^[A-Za-z]{3} \d{2}:\d{2}$/);
  // This year: a month and a day, no time.
  const older = shortTime(new Date(2026, 7, 16, 9, 0).getTime(), { locale: "en", now: NOW });
  assert.match(older, /Aug/);
  assert.doesNotMatch(older, /:/);
  // Older than a year: the year comes along.
  const oldest = shortTime(new Date(2025, 0, 5, 9, 0).getTime(), { locale: "en", now: NOW });
  assert.match(oldest, /2025/);
  // And the same rules in Chinese, from `Intl`, not from a second table here.
  assert.match(shortTime(NOW - 60_000, { locale: "zh-CN", now: NOW }), /^\d{2}:\d{2}$/);
  assert.equal(shortTime(null, { now: NOW }), "");
});

test("the reading pane shows the whole timestamp, not the short one", () => {
  const full = fullTime(NOW, { locale: "en" });
  assert.match(full, /2026/);
  assert.match(full, /:/);
  assert.equal(fullTime(null), "");
});

test("an avatar is up to two letters, and a CJK name keeps one character", () => {
  assert.equal(initials("Zhang San", "z@example.com"), "ZS");
  assert.equal(initials("", "boss@example.com"), "BO");
  assert.equal(initials("张三", "z@example.cn"), "张");
  assert.equal(initials("", ""), "?");
  assert.equal(initials("madonna", ""), "MA");
});

test("an avatar colour is stable for one address and stays inside the palette", () => {
  const first = avatarColor("boss@example.com");
  assert.equal(avatarColor("boss@example.com"), first);
  assert.equal(avatarColor("BOSS@Example.com"), first, "case is not a different person");
  assert.ok(first >= 0 && first < 8);
  // Two different senders are not guaranteed different colours, but the eight
  // tones in the stylesheet are all reachable.
  const tones = new Set(["a@x", "b@x", "c@x", "d@x", "e@x", "f@x", "g@x", "h@x"].map((one) => avatarColor(one)));
  assert.ok(tones.size > 1);
  assert.equal(avatarColor(""), avatarColor(null));
});

test("a search matches sender, subject and preview, word by word", () => {
  const one = message();
  assert.equal(matchesQuery(one, ""), true);
  assert.equal(matchesQuery(one, "boss"), true, "sender name");
  assert.equal(matchesQuery(one, "boss@example"), true, "sender address");
  assert.equal(matchesQuery(one, "quarterly"), true, "subject");
  assert.equal(matchesQuery(one, "attached"), true, "preview");
  assert.equal(matchesQuery(one, "boss attached"), true, "every word, in any order");
  assert.equal(matchesQuery(one, "boss invoice"), false, "one missing word is a miss");
  assert.equal(matchesQuery(one, "OWNER@EXAMPLE.COM"), true, "the mailbox's own label counts");
});

test("the list is filtered, searched and grouped in one pass", () => {
  const messages = [
    message({ uid: 1, key: "a", receivedAt: NOW - 1000 }),
    message({ uid: 2, key: "b", receivedAt: NOW - DAY, unread: false }),
    message({ uid: 3, key: "c", receivedAt: NOW - 3 * DAY, starred: true, unread: false, accountId: "acc_2" }),
    message({ uid: 4, key: "d", receivedAt: NOW - 40 * DAY, important: true, unread: false }),
  ];

  const all = groupMessages(messages, { now: NOW });
  assert.deepEqual(all.map((group) => group.id), ["today", "yesterday", "thisWeek", "earlier"]);
  assert.deepEqual(all[0].items.map((one) => one.key), ["a"]);

  // One mailbox only.
  const one = groupMessages(messages, { accountId: "acc_2", now: NOW });
  assert.deepEqual(one.flatMap((group) => group.items.map((item) => item.key)), ["c"]);

  // Each filter, and an empty group is dropped rather than drawn as a heading.
  assert.deepEqual(
    groupMessages(messages, { filter: "unread", now: NOW }).flatMap((group) => group.items.map((item) => item.key)),
    ["a"],
  );
  assert.deepEqual(
    groupMessages(messages, { filter: "starred", now: NOW }).flatMap((group) => group.items.map((item) => item.key)),
    ["c"],
  );
  assert.deepEqual(
    groupMessages(messages, { filter: "important", now: NOW }).flatMap((group) => group.items.map((item) => item.key)),
    ["d"],
  );
  assert.deepEqual(groupMessages(messages, { query: "nothing here", now: NOW }), []);
  assert.deepEqual(groupMessages([], { now: NOW }), []);
});

test("j and k walk the rows the list actually shows", () => {
  const messages = [
    message({ uid: 1, key: "a", receivedAt: NOW - 1000 }),
    message({ uid: 2, key: "b", receivedAt: NOW - 2000 }),
  ];
  const rows = visibleMessages(messages, { now: NOW });
  assert.deepEqual(rows.map((one) => one.key), ["a", "b"]);
  assert.equal(stepIndex(-1, 1, 2), 0, "the first j selects the first row");
  assert.equal(stepIndex(0, 1, 2), 1);
  assert.equal(stepIndex(1, 1, 2), 1, "the last row is the end of the list");
  assert.equal(stepIndex(0, -1, 2), 0);
  assert.equal(stepIndex(-1, -1, 2), 1, "k from nowhere starts at the end");
  assert.equal(stepIndex(0, 1, 0), -1);
});

test("two rows are the same message only when account and key agree", () => {
  assert.equal(sameMessage({ accountId: "a", key: "k" }, { accountId: "a", key: "k" }), true);
  assert.equal(sameMessage({ accountId: "a", key: "k" }, { accountId: "b", key: "k" }), false);
  assert.equal(sameMessage(null, { accountId: "a", key: "k" }), false);
});

test("the recipient line says who the message was for", () => {
  const to = [
    { name: "Me", address: "owner@example.com" },
    { name: "Ann", address: "ann@example.com" },
    { name: "Bob", address: "bob@example.com" },
  ];
  const summary = recipientSummary(to, [{ name: "Cara", address: "cara@example.com" }], {
    me: "owner@example.com",
  });
  assert.equal(summary.directlyToMe, true);
  assert.equal(summary.others, 2);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.names, ["Me", "Ann", "Bob"]);
  assert.equal(recipientSummary([], [], { me: "x@y" }).total, 0);
});

test("an attachment is named by its kind, size and extension", () => {
  assert.equal(fileKind("report.pdf"), "pdf");
  assert.equal(fileKind("photo.JPG"), "image");
  assert.equal(fileKind("sheet.xlsx"), "sheet");
  assert.equal(fileKind("notes"), "file");
  assert.equal(fileKind("x", "application/pdf"), "pdf");
  assert.equal(formatBytes(0), "—");
  assert.equal(formatBytes(900), "900 B");
  assert.match(formatBytes(240 * 1024), /240 KB/);
  assert.equal(attachmentMeta({ filename: "report.pdf", size: 240 * 1024 }, "en"), "PDF · 240 KB");
  assert.equal(attachmentMeta({ filename: "notes" }, "en"), "FILE");
});

test("the keyboard map is the one the panel documents, and fields keep their keys", () => {
  const press = (key, extra = {}) => keyboardAction({ key, ...extra });
  assert.equal(press("j"), "next");
  assert.equal(press("ArrowDown"), "next");
  assert.equal(press("k"), "prev");
  assert.equal(press("ArrowUp"), "prev");
  assert.equal(press("Enter"), "open");
  assert.equal(press("u"), "toggleRead");
  assert.equal(press("s"), "toggleStar");
  assert.equal(press("#"), "delete");
  assert.equal(press("Delete"), "delete");
  assert.equal(press("e"), "archive");
  assert.equal(press("/"), "search");
  assert.equal(press("Escape"), "close");
  assert.equal(press("q"), null, "a letter the panel does not use is left alone");

  // A modifier belongs to the app, not to this panel.
  assert.equal(press("j", { metaKey: true }), null);
  assert.equal(press("s", { ctrlKey: true }), null);
  assert.equal(press("e", { altKey: true }), null);

  // Typing in the search box must not open a message or delete one.
  assert.equal(keyboardAction({ key: "j" }, { inField: true }), null);
  assert.equal(keyboardAction({ key: "Enter" }, { inField: true }), null);
  assert.equal(keyboardAction({ key: "#" }, { inField: true }), null);
  assert.equal(keyboardAction({ key: "Escape" }, { inField: true }), "clear");
  assert.equal(keyboardAction(null), null);
});