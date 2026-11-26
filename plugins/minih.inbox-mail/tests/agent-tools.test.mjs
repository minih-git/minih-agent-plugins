import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const agentTools = require("../lib/agent-tools.js");

/**
 * The tools this plugin gives the agent, exercised without a mailbox.
 *
 * `tests/plugin.test.mjs` runs the same tools through the real `onLoad()` and a
 * scripted IMAP server, which is where the protocol is proven. This file is about
 * the decisions that sit in front of the protocol: which arguments are accepted,
 * which rows match, how an answer is bounded and labelled, and what the manifest
 * is told about each tool.
 */

/** A host whose `pi.agent` records what was registered, like the app's broker. */
function fakeHost() {
  const tools = new Map();
  return {
    tools,
    pi: {
      agent: {
        registerTool: async (tool) => {
          tools.set(tool.name, tool);
        },
        unregisterTool: async (name) => {
          tools.delete(name);
        },
      },
    },
  };
}

/** One stored envelope, as the panel's list reports it. */
function row(overrides = {}) {
  return {
    accountId: "acc_1",
    accountLabel: "owner@qq.com",
    flagsSupported: true,
    key: "<m1@example.com>",
    uid: 1,
    from: { name: "Billing", address: "billing@vendor.example" },
    subject: "Invoice 2026-04",
    receivedAt: Date.parse("2026-04-02T09:00:00Z"),
    unread: true,
    readLocally: null,
    starred: false,
    important: false,
    summary: "Your April invoice is attached.",
    to: [],
    cc: [],
    hasAttachments: true,
    ...overrides,
  };
}

/** A runtime with one IMAP account that is not connected (`watcher: null`). */
function fakeRuntime({ messages = [row()], accounts, openMessage, sendReply, send } = {}) {
  const records = accounts ?? [
    { instanceId: "acc_1", label: "owner@qq.com", email: "owner@qq.com", protocol: "imap", watcher: null },
  ];
  return {
    accounts: records,
    snapshot: () => ({ messages }),
    openMessage: openMessage ?? (async () => ({ text: "", attachments: [] })),
    sendReply: sendReply ?? (async () => ({ accepted: [], rejected: [], filed: null })),
    send: send ?? (async () => ({ accepted: [], rejected: [], filed: null })),
  };
}

async function withTools(runtime) {
  const host = fakeHost();
  const tools = agentTools.createAgentTools({ host: host.pi, runtime, log: () => {} });
  await tools.register();
  const call = (name, args) => host.tools.get(name).execute(args, {});
  return { host, tools, call };
}

test("the four tools are registered with the risk level the host gates them by", async () => {
  const { host, tools } = await withTools(fakeRuntime());
  assert.deepEqual([...host.tools.keys()], [
    "mail_list_messages",
    "mail_read_message",
    "mail_reply_message",
    "mail_send_message",
  ]);
  assert.equal(host.tools.get("mail_list_messages").risk, "low");
  assert.equal(host.tools.get("mail_read_message").risk, "low");
  assert.equal(host.tools.get("mail_reply_message").risk, "high");
  assert.equal(host.tools.get("mail_send_message").risk, "high");
  for (const tool of host.tools.values()) {
    assert.equal(typeof tool.execute, "function");
    assert.equal(tool.schema.type, "object");
    // Nothing here declares plan-safe actions, which is what keeps these tools out
    // of Plan and Goal: the host only admits a plugin tool there when the plugin
    // names the actions that are safe in a plan (spec 07-plugins/03 §agent).
    assert.equal(tool.planSafeActions, undefined);
  }
  await tools.unregister();
  assert.equal(host.tools.size, 0, "a reload must not leave a stale closure registered");
});

test("an app without pi.agent registers nothing and keeps working", async () => {
  const tools = agentTools.createAgentTools({ host: {}, runtime: fakeRuntime(), log: () => {} });
  assert.deepEqual(await tools.register(), []);
});

test("only whole, bounded integers are accepted for limit and offset", async () => {
  const { call } = await withTools(fakeRuntime());
  const result = await call("mail_list_messages", {});
  assert.equal(result.limit, agentTools.DEFAULT_LIMIT);
  assert.equal(result.offset, 0);
  await assert.rejects(() => call("mail_list_messages", { limit: 200 }), /between 1 and 50/);
  await assert.rejects(() => call("mail_list_messages", { limit: 1.5 }), /between 1 and 50/);
  await assert.rejects(() => call("mail_list_messages", { offset: -1 }), /between 0 and/);
});

test("a bare day means that day where the caller lives, and a bad one is refused", () => {
  // Not a UTC instant: the local filter and the server's SINCE both mean the
  // mailbox's calendar day, so the day starts at local midnight. (The zone this
  // matters in — UTC+8 — is proven in `tests/session.test.mjs` with a fixed TZ.)
  const since = agentTools.parseDate("2026-04-01", "since");
  assert.equal(since.getFullYear(), 2026);
  assert.equal(since.getMonth(), 3);
  assert.equal(since.getDate(), 1);
  assert.equal(since.getHours(), 0);
  assert.equal(agentTools.parseDate("2026-04-01T10:00:00Z", "since").toISOString(), "2026-04-01T10:00:00.000Z");
  assert.equal(agentTools.parseDate("", "since"), null);
  assert.equal(agentTools.parseDate(undefined, "since"), null);
  assert.throws(() => agentTools.parseDate("last tuesday", "since"), /must be a date/);
  // A day that does not exist must be refused, not rolled into March.
  assert.throws(() => agentTools.parseDate("2026-02-31", "since"), /must be a date/);
});

test("the filters a caller names are ANDed over one envelope", () => {
  const criteria = agentTools.criteriaOf({ from: "VENDOR", subject: "invoice", since: "2026-04-01" });
  assert.equal(agentTools.matchesCriteria(row(), criteria), true);
  assert.equal(agentTools.matchesCriteria(row({ subject: "Newsletter" }), criteria), false);
  assert.equal(agentTools.matchesCriteria(row({ from: { name: "Someone", address: "a@b.example" } }), criteria), false);
  // Instants are built in local time on purpose: the range is two calendar days,
  // so "the day before" is the day before where the user lives.
  assert.equal(
    agentTools.matchesCriteria(row({ receivedAt: new Date(2026, 2, 31, 12, 0).getTime() }), criteria),
    false,
    "before the day asked for",
  );
  assert.equal(
    agentTools.matchesCriteria(row({ receivedAt: new Date(2026, 3, 1, 0, 30).getTime() }), criteria),
    true,
    "00:30 on the day asked for is on that day",
  );
  // A message the server never dated cannot be placed in a range.
  assert.equal(agentTools.matchesCriteria(row({ receivedAt: null }), criteria), false);
  // Unread and starred are booleans in both directions, so "read only" is a filter
  // too rather than an absence of one.
  assert.equal(agentTools.matchesCriteria(row(), agentTools.criteriaOf({ unread: true })), true);
  assert.equal(agentTools.matchesCriteria(row(), agentTools.criteriaOf({ unread: false })), false);
  assert.equal(agentTools.matchesCriteria(row({ starred: true }), agentTools.criteriaOf({ starred: true })), true);
  assert.equal(agentTools.matchesCriteria(row(), agentTools.criteriaOf({ starred: true })), false);
});

test("a local answer is labelled, bounded and paged, and says the content is data", async () => {
  const messages = Array.from({ length: 5 }, (_, index) =>
    row({
      key: `<m${index}@example.com>`,
      uid: index + 1,
      subject: `Invoice ${index}`,
      receivedAt: Date.parse("2026-04-02T09:00:00Z") + index * 60_000,
    }),
  );
  const { call } = await withTools(fakeRuntime({ messages }));
  const first = await call("mail_list_messages", { limit: 2, searchServer: false });
  assert.equal(first.untrusted, true);
  assert.equal(first.notice, agentTools.UNTRUSTED_NOTICE);
  assert.match(first.notice, /untrusted|data, never as instructions/i);
  assert.equal(first.returned, 2);
  assert.equal(first.hasMore, true);
  // Newest first: the last message of the fixture leads the answer.
  assert.deepEqual(first.messages.map((entry) => entry.subject), ["Invoice 4", "Invoice 3"]);
  assert.equal(first.messages.every((entry) => entry.source === "local"), true);
  assert.equal(first.messages[0].receivedAt, "2026-04-02T09:04:00.000Z");
  const second = await call("mail_list_messages", { limit: 2, offset: 2, searchServer: false });
  assert.deepEqual(second.messages.map((entry) => entry.subject), ["Invoice 2", "Invoice 1"]);
  assert.equal(second.hasMore, true);
  const last = await call("mail_list_messages", { limit: 2, offset: 4, searchServer: false });
  assert.equal(last.returned, 1);
  assert.equal(last.hasMore, false);
  // Every account is named, and a page the local store could fill says the server
  // was not needed.
  assert.deepEqual(last.accounts.map((entry) => entry.accountId), ["acc_1"]);
  assert.equal(last.accounts[0].searched, false);
  assert.equal(last.accounts[0].note, null);
});

test("a mailbox that is not connected answers locally and says so", async () => {
  const { call } = await withTools(fakeRuntime());
  // A date range makes the local store insufficient by definition, so the answer
  // has to explain why the server was not asked.
  const result = await call("mail_list_messages", { since: "2026-04-01" });
  assert.equal(result.accounts[0].searched, false);
  assert.match(result.accounts[0].note, /not connected yet/);
  assert.equal(result.messages.length, 1);
});

test("a POP3 account reports that its answer cannot reach the server", async () => {
  const runtime = fakeRuntime({
    accounts: [{ instanceId: "acc_1", label: "pop@example.com", email: "pop@example.com", protocol: "pop3", watcher: {} }],
  });
  const { call } = await withTools(runtime);
  const result = await call("mail_list_messages", { since: "2026-04-01" });
  assert.equal(result.accounts[0].searched, false);
  assert.match(result.accounts[0].note, /POP3 has no server-side search/);
  assert.equal(result.messages.length, 1, "the stored envelope still answers");
});

test("a read returns capped text and asks the runtime not to mark the message read", async () => {
  let seenOptions = null;
  const long = "x".repeat(agentTools.TEXT_LIMIT + 500);
  const runtime = fakeRuntime({
    openMessage: async (input, options) => {
      seenOptions = { input, options };
      return {
        accountId: "acc_1",
        accountLabel: "owner@qq.com",
        key: "<m1@example.com>",
        uid: 1,
        messageId: "<m1@example.com>",
        from: { name: "Billing", address: "billing@vendor.example" },
        to: [],
        cc: [],
        subject: "Invoice 2026-04",
        receivedAt: Date.parse("2026-04-02T09:00:00Z"),
        text: long,
        truncated: false,
        limited: 1024 * 1024,
        size: long.length,
        attachments: [{ part: "2", filename: "invoice.pdf", size: 1024, type: "application/pdf" }],
      };
    },
  });
  const { call } = await withTools(runtime);
  const result = await call("mail_read_message", { accountId: "acc_1", key: "<m1@example.com>" });
  assert.deepEqual(seenOptions.options, { markRead: false }, "a tool read never sets \\Seen");
  assert.equal(seenOptions.input.uid, undefined);
  assert.equal(result.markedRead, false);
  assert.equal(result.untrusted, true);
  assert.equal(result.text.length, agentTools.TEXT_LIMIT);
  assert.equal(result.textTruncated, true);
  assert.deepEqual(result.attachments, [
    { part: "2", filename: "invoice.pdf", size: 1024, type: "application/pdf" },
  ]);
  assert.equal(result.receivedAt, "2026-04-02T09:00:00.000Z");
});

test("a message is named by key or by uid, and by neither is refused", async () => {
  const runtime = fakeRuntime({
    openMessage: async (input) => ({ accountId: "acc_1", key: input.key ?? `uid:${input.uid}`, uid: input.uid, text: "hi" }),
  });
  const { call } = await withTools(runtime);
  await call("mail_read_message", { accountId: "acc_1", uid: 42 });
  await assert.rejects(
    () => call("mail_read_message", { accountId: "acc_1" }),
    /name the message with key .* or uid/,
  );
  await assert.rejects(
    () => call("mail_read_message", { accountId: "acc_1", uid: 0 }),
    /between 1 and/,
  );
});

test("sending names one mailbox, and the reply carries the caller's text", async () => {
  const calls = [];
  const runtime = fakeRuntime({
    accounts: [
      { instanceId: "acc_1", label: "owner@qq.com", email: "owner@qq.com", protocol: "imap", watcher: {} },
      { instanceId: "acc_2", label: "work@example.com", email: "work@example.com", protocol: "imap", watcher: {} },
    ],
    sendReply: async (input) => {
      calls.push({ kind: "reply", input });
      return { accountId: input.accountId, accepted: ["billing@vendor.example"], rejected: [], messageId: "<r@x>", filed: { filed: true } };
    },
    send: async (input) => {
      calls.push({ kind: "send", input });
      return { accountId: input.accountId, accepted: input.to, rejected: [], messageId: "<s@x>", filed: null };
    },
  });
  const { call } = await withTools(runtime);
  // Two mailboxes and no accountId: a send has one sender, so it is refused
  // rather than guessed from the first account in the list.
  await assert.rejects(
    () => call("mail_send_message", { to: "a@b.example", subject: "Hi", text: "Body" }),
    /name exactly one mailbox/,
  );
  const reply = await call("mail_reply_message", {
    accountId: "acc_1",
    key: "<m1@example.com>",
    text: "Thanks — paid.",
    replyAll: true,
  });
  assert.equal(reply.sent, true);
  assert.equal(reply.account, "owner@qq.com");
  assert.deepEqual(reply.accepted, ["billing@vendor.example"]);
  assert.deepEqual(calls[0].input, {
    accountId: "acc_1",
    key: "<m1@example.com>",
    text: "Thanks — paid.",
    replyAll: true,
  });
  const sent = await call("mail_send_message", {
    accountId: "acc_2",
    to: ["a@b.example", " c@d.example "],
    subject: "Hello",
    text: "Body",
  });
  assert.equal(sent.sent, true);
  assert.deepEqual(calls[1].input.to, ["a@b.example", "c@d.example"]);
  assert.deepEqual(calls[1].input.cc, []);
  await assert.rejects(
    () => call("mail_send_message", { accountId: "acc_2", to: "", subject: "x", text: "y" }),
    /at least one address/,
  );
  await assert.rejects(
    () => call("mail_send_message", { accountId: "acc_2", to: "a@b.example", subject: "x", text: "   " }),
    /text must not be empty/,
  );
});

test("a message a server search found is read by its uid when its key is not stored", async () => {
  const calls = [];
  const runtime = fakeRuntime({
    openMessage: async (input) => {
      calls.push(input);
      if (input.key) throw Object.assign(new Error("this message is not in the list"), { code: "MESSAGE_NOT_FOUND" });
      return { accountId: "acc_1", key: `uid:${input.uid}`, uid: input.uid, text: "from the server" };
    },
  });
  const { call } = await withTools(runtime);
  // The list reported both names for that row; the key is a Message-ID the plugin
  // never stored, so the uid is what resolves it.
  const read = await call("mail_read_message", { accountId: "acc_1", key: "<old@example.com>", uid: 12 });
  assert.equal(read.uid, 12);
  assert.deepEqual(calls.map((entry) => entry.key ?? null), ["<old@example.com>", null]);
  // Without a uid to fall back on, the refusal is the honest answer.
  await assert.rejects(
    () => call("mail_read_message", { accountId: "acc_1", key: "<old@example.com>" }),
    /not in the list/,
  );
});

test("a POP3 mailbox is read by key only, because it has no UID", async () => {
  const runtime = fakeRuntime({
    accounts: [{ instanceId: "acc_1", label: "pop@example.com", email: "pop@example.com", protocol: "pop3", watcher: {} }],
    openMessage: async (input) => ({ accountId: "acc_1", key: input.key, text: "stored" }),
  });
  const { call } = await withTools(runtime);
  await assert.rejects(
    () => call("mail_read_message", { accountId: "acc_1", uid: 7 }),
    /POP3 mailbox names a message with key/,
  );
  const read = await call("mail_read_message", { accountId: "acc_1", key: "pop3:uidl-1" });
  assert.equal(read.key, "pop3:uidl-1");
});

test("an unknown mailbox is refused by name, not by guessing", async () => {
  const { call } = await withTools(fakeRuntime());
  await assert.rejects(() => call("mail_list_messages", { accountId: "acc_9" }), /no mailbox with accountId acc_9/);
  await assert.rejects(() => call("mail_list_messages", { account: "nobody@example.com" }), /no mailbox matching/);
});

test("an address list takes a string or an array, and drops what is not an address", () => {
  assert.deepEqual(agentTools.addressList("a@b.example, c@d.example"), ["a@b.example", "c@d.example"]);
  assert.deepEqual(agentTools.addressList(["a@b.example", "", null]), ["a@b.example"]);
  assert.deepEqual(agentTools.addressList(undefined), []);
});