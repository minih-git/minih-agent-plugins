import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";
import { createHarness, stays, waitFor } from "./helpers/harness.mjs";

/**
 * The polling watcher, driven through the real session and gate code against a
 * scripted server.
 *
 * Each case names one promise the design makes — do not announce the archive,
 * announce a new message once, never send IDLE — and asserts it on the commands
 * the plugin sent and the rows it posted, not on internals.
 */

const SETTINGS = { importantSenders: "boss@example.com", keywords: "发票", digestMinutes: 30 };

test("the first poll only sets the cursor and reports nothing", async () => {
  const server = createFakeServer({
    uidNext: 4,
    messages: [
      message({ uid: 1 }),
      message({ uid: 2, from: { name: "Boss", address: "boss@example.com" } }),
      message({ uid: 3, subject: "发票" }),
    ],
  });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    const result = await harness.watcher.checkNow();
    assert.equal(result.checked, true);
    assert.equal(result.handled, 0);
    assert.deepEqual(harness.state.cursor, { uidValidity: 7, maxUid: 3 });
    assert.equal(harness.notifications.length, 0, "the archive is not new mail");
    // One short session: connect, look, log out. The search starts above the
    // baseline the SELECT just set, so no old mail is fetched.
    assert.deepEqual(
      server.sentLines.map((line) => line.split(" ").slice(1).join(" ")),
      [
        "CAPABILITY",
        "ID (\"name\" \"test\" \"vendor\" \"minih\" \"version\" \"0.0.0\")",
        "SELECT \"INBOX\"",
        "UID SEARCH UID 4:*",
        "LOGOUT",
      ],
    );
  } finally {
    await harness.stop();
  }
});

test("an important sender gets one alert, keyed by Message-ID", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    await harness.watcher.checkNow();
    const arrived = server.deliver(
      message({ uid: 1, from: { name: "Boss", address: "boss@example.com" }, subject: "预算" }),
    );
    const first = await harness.watcher.checkNow();
    assert.equal(first.handled, 1);
    const [alert] = harness.alerts();
    assert.equal(alert.message.messageId, arrived.messageId);
    assert.equal(alert.message.subject, "预算");
    assert.deepEqual(alert.reasons, [{ kind: "sender", value: "boss@example.com" }]);
    assert.equal(harness.digests().length, 0);

    // A second poll over the same mailbox announces nothing again.
    const second = await harness.watcher.checkNow();
    assert.equal(second.handled, 0);
    assert.equal(harness.notifications.length, 1);
  } finally {
    await harness.stop();
  }
});

test("a message flagged urgent by its headers is an alert even from a stranger", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    await harness.watcher.checkNow();
    server.deliver(message({ uid: 1, subject: "Weekly", extraHeaders: ["X-Priority: 1"] }));
    await harness.watcher.checkNow();
    assert.deepEqual(harness.alerts()[0].reasons, [{ kind: "header", value: "urgent" }]);
  } finally {
    await harness.stop();
  }
});

test("the rest of the mail is rolled up into one digest after its interval", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    await harness.watcher.checkNow();
    server.deliver(message({ uid: 1, from: { name: "News", address: "news@example.com" } }));
    server.deliver(message({ uid: 2, from: { name: "Shop", address: "shop@example.com" } }));
    await harness.watcher.checkNow();
    assert.equal(harness.state.pending.length, 2);
    assert.equal(harness.digests().length, 0, "nothing is due for another half hour");

    harness.overrides.digestMinutes = 0;
    await harness.watcher.checkNow();
    const [digest] = harness.digests();
    assert.equal(digest.entries.length, 2);
    assert.equal(harness.alerts().length, 0);
  } finally {
    await harness.stop();
  }
});

test("mail that arrives between two polls is caught by the next one", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS, pollMs: 20 });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the first poll" });
    server.deliver(message({ uid: 1, subject: "发票到了", from: { name: "Boss", address: "boss@example.com" } }));
    await waitFor(() => harness.alerts().length === 1, { label: "the next poll's alert" });
    // Every poll is a session of its own: no connection is kept open.
    assert.equal(harness.connectAttempts >= 2, true);
  } finally {
    await harness.stop();
  }
});

test("the watcher never sends IDLE, DONE or a mailbox-changing command", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    await harness.watcher.checkNow();
    server.deliver(message({ uid: 1 }));
    server.deliver(message({ uid: 2, extraHeaders: ["Importance: high"] }));
    await harness.watcher.checkNow();
    const lines = server.sentLines;
    const fetches = lines.filter((line) => line.includes("UID FETCH"));
    assert.ok(fetches.length >= 1, "the new mail was fetched");
    for (const line of fetches) {
      assert.match(line, /BODY\.PEEK\[HEADER\.FIELDS/);
      assert.doesNotMatch(line, /[^.]BODY\[/, "a plain BODY[] fetch would set \\Seen");
    }
    for (const forbidden of ["IDLE", "DONE", "STORE", "APPEND", "COPY", "MOVE", "EXPUNGE", "CREATE", "DELETE"]) {
      assert.equal(
        lines.some((line) => new RegExp(`\\b${forbidden}\\b`).test(line)),
        false,
        `${forbidden} must never be sent`,
      );
    }
    assert.equal(lines.some((line) => line.includes("LOGOUT")), true, "each session is closed again");
  } finally {
    await harness.stop();
  }
});

test("a UIDVALIDITY change resets the cursor instead of replaying the mailbox", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    await harness.watcher.checkNow();
    assert.equal(harness.state.cursor.uidValidity, 7);
    // The mailbox is rebuilt by the server: same messages, new UIDs.
    server.uidValidity = 11;
    server.uidNext = 6;
    server.add(message({ uid: 5, from: { name: "Boss", address: "boss@example.com" } }));
    await harness.watcher.checkNow();
    assert.equal(harness.state.cursor.uidValidity, 11);
    assert.equal(harness.state.cursor.maxUid, 5);
    assert.equal(harness.notifications.length, 0, "the new UIDVALIDITY is a fresh baseline");
  } finally {
    await harness.stop();
  }
});

test("restarting does not report the same message twice", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const first = createHarness(server, { settings: SETTINGS });
  await first.watcher.checkNow();
  server.deliver(message({ uid: 1, from: { name: "Boss", address: "boss@example.com" } }));
  await first.watcher.checkNow();
  assert.equal(first.alerts().length, 1);
  await first.stop();

  // The same mailbox and the same state file, as after an app restart.
  const second = createHarness(server, { settings: SETTINGS, state: first.state });
  try {
    await second.watcher.checkNow();
    assert.equal(second.notifications.length, 0, "nothing is reported again");
    assert.equal(second.state.seen.length, 1, "the reported Message-ID is remembered");
  } finally {
    await second.stop();
  }
});

test("a failing connection is recorded, and the next poll recovers", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS, refuse: true });
  try {
    const failed = await harness.watcher.checkNow();
    assert.equal(failed.checked, false);
    assert.equal(harness.watcher.status.phase, "error");
    assert.match(harness.state.lastError, /CONNECT_FAILED/);
    assert.equal(harness.errors.length, 1);

    harness.control.refuse = false;
    const recovered = await harness.watcher.checkNow();
    assert.equal(recovered.checked, true);
    assert.equal(harness.watcher.status.phase, "connected");
  } finally {
    await harness.stop();
  }
});

test("a backup of accounts is polled through one shared connection budget", async () => {
  const servers = [createFakeServer({ uidNext: 1 }), createFakeServer({ uidNext: 1 }), createFakeServer({ uidNext: 1 })];
  // One slot: three accounts cannot be in three sessions at the same time.
  const gate = createHarness(servers[0], { maxConcurrent: 1 });
  try {
    let peak = 0;
    const watch = (server) =>
      gate.watcher.withSession(async () => {
        peak = Math.max(peak, gate.gate.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    await Promise.all(servers.map(() => watch()));
    assert.equal(peak, 1, "the gate is what caps the plugin at the host's ceiling");
    assert.equal(gate.gate.active, 0);
  } finally {
    await gate.stop();
  }
});

test("a response split into single bytes is still decoded", async () => {
  const server = createFakeServer({ uidNext: 1, chunkSize: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    await harness.watcher.checkNow();
    server.deliver(
      message({
        uid: 1,
        from: { name: "Boss", address: "boss@example.com" },
        subject: "分块到达的主题",
        rawSubject: "=?UTF-8?B?5YiG5Z2X5Yiw6L6+55qE5Li76aKY?=",
      }),
    );
    await harness.watcher.checkNow();
    await waitFor(() => harness.notifications.length === 1, { label: "a decoded notification" });
    assert.equal(harness.notifications[0].message.subject, "分块到达的主题");
  } finally {
    await harness.stop();
  }
});

test("a GBK subject and a GBK sender name are decoded", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: { importantSenders: "老板" } });
  try {
    await harness.watcher.checkNow();
    // 老板 in GBK, 报告 in GBK: the two encodings the plugin must survive.
    server.deliver(
      message({
        uid: 1,
        rawName: "=?gb2312?B?wM+w5Q==?=",
        rawSubject: "=?GBK?B?sai45g==?=",
        from: { name: "", address: "boss@example.com" },
      }),
    );
    await harness.watcher.checkNow();
    const [entry] = harness.notifications;
    assert.equal(entry.message.from.name, "老板");
    assert.equal(entry.message.subject, "报告");
    assert.equal(entry.kind, "alert", "the decoded name matched the important-sender list");
  } finally {
    await harness.stop();
  }
});

test("a stopped watcher does not poll behind the user's back", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS, pollMs: 10 });
  await harness.watcher.start();
  await waitFor(() => harness.connectAttempts >= 1, { label: "the first poll" });
  await harness.stop();
  const attempts = harness.connectAttempts;
  await stays(async () => harness.connectAttempts > attempts, { ms: 60, label: "a poll after stop" });
});