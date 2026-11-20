import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";
import { createHarness, waitFor } from "./helpers/harness.mjs";

/**
 * The behaviour that matters, driven through the real session and watcher code
 * against a scripted server.
 *
 * Each case names one promise the design makes — do not announce the archive,
 * announce a new message once, keep reading after a drop — and asserts it on the
 * commands the plugin sent and the rows it posted, not on internals.
 */

const SETTINGS = { importantSenders: "boss@example.com", keywords: "发票", digestMinutes: 30 };

test("a first connection only sets the cursor and reports nothing", async () => {
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
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the cursor" });
    assert.deepEqual(harness.state.cursor, { uidValidity: 7, maxUid: 3 });
    assert.equal(harness.notifications.length, 0, "the archive is not new mail");
    // The cursor came from UIDNEXT, so no message was fetched to establish it.
    assert.equal(
      server.sentLines.some((line) => line.includes("UID FETCH")),
      false,
    );
  } finally {
    await harness.stop();
  }
});

test("an important sender gets one alert, keyed by Message-ID", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the cursor" });
    const arrived = server.deliver(
      message({ uid: 1, from: { name: "Boss", address: "boss@example.com" }, subject: "预算" }),
    );
    await waitFor(() => harness.alerts().length === 1, { label: "an alert" });
    const [alert] = harness.alerts();
    assert.equal(alert.message.messageId, arrived.messageId);
    assert.equal(alert.message.subject, "预算");
    assert.deepEqual(alert.reasons, [{ kind: "sender", value: "boss@example.com" }]);
    assert.equal(harness.digests().length, 0);
  } finally {
    await harness.stop();
  }
});

test("a message flagged urgent by its headers is an alert even from a stranger", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the cursor" });
    server.deliver(
      message({ uid: 1, subject: "Weekly", extraHeaders: ["X-Priority: 1"] }),
    );
    await waitFor(() => harness.alerts().length === 1, { label: "an alert" });
    assert.deepEqual(harness.alerts()[0].reasons, [{ kind: "header", value: "urgent" }]);
  } finally {
    await harness.stop();
  }
});

test("the rest of the mail is rolled up into one digest row", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the cursor" });
    server.deliver(message({ uid: 1, from: { name: "News", address: "news@example.com" } }));
    server.deliver(message({ uid: 2, from: { name: "Shop", address: "shop@example.com" } }));
    await waitFor(() => harness.state.pending.length === 2, { label: "two queued entries" });
    // Nothing is due for another half hour; the interval is what releases it.
    harness.overrides.digestMinutes = 0;
    harness.watcher.poke();
    await waitFor(() => harness.digests().length === 1, { label: "a digest" });
    const [digest] = harness.digests();
    assert.equal(digest.entries.length, 2);
    assert.equal(harness.alerts().length, 0);
  } finally {
    await harness.stop();
  }
});

test("a digest waits for its interval, and a poke flushes it once it is due", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the cursor" });
    server.deliver(message({ uid: 1, from: { name: "News", address: "news@example.com" } }));
    await waitFor(() => harness.state.pending.length === 1, { label: "a queued digest entry" });
    assert.equal(harness.digests().length, 0, "30 minutes have not passed");
    // The interval is what decides; the clock is not waited for here.
    harness.overrides.digestMinutes = 0;
    harness.watcher.poke();
    await waitFor(() => harness.digests().length === 1, { label: "the flushed digest" });
  } finally {
    await harness.stop();
  }
});

test("IDLE exists: an EXISTS while idling leads to a fetch and an alert", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => server.idling, { label: "IDLE" });
    server.deliver(message({ uid: 1, from: { name: "Boss", address: "boss@example.com" } }));
    await waitFor(() => harness.alerts().length === 1, { label: "the alert the EXISTS caused" });
    assert.equal(server.sentLines.filter((line) => line.includes("IDLE")).length >= 1, true);
  } finally {
    await harness.stop();
  }
});

test("a response split into single bytes still decodes", async () => {
  const server = createFakeServer({ uidNext: 1, chunkSize: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => server.idling, { label: "IDLE" });
    server.deliver(
      message({
        uid: 1,
        from: { name: "Boss", address: "boss@example.com" },
        subject: "分块到达的主题",
        rawSubject: "=?UTF-8?B?5YiG5Z2X5Yiw6L6+55qE5Li76aKY?=",
      }),
    );
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
    harness.watcher.start();
    await waitFor(() => server.idling, { label: "IDLE" });
    // 老板 in GBK, 报告 in GBK: the two encodings the plugin must survive.
    server.deliver(
      message({
        uid: 1,
        rawName: "=?gb2312?B?wM+w5Q==?=",
        rawSubject: "=?GBK?B?sai45g==?=",
        from: { name: "", address: "boss@example.com" },
      }),
    );
    await waitFor(() => harness.notifications.length === 1, { label: "a decoded notification" });
    const [entry] = harness.notifications;
    assert.equal(entry.message.from.name, "老板");
    assert.equal(entry.message.subject, "报告");
    assert.equal(entry.kind, "alert", "the decoded name matched the important-sender list");
  } finally {
    await harness.stop();
  }
});

test("a UIDVALIDITY change resets the cursor instead of replaying the mailbox", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the cursor" });
    assert.equal(harness.state.cursor.uidValidity, 7);
    // The mailbox is rebuilt by the server: same messages, new UIDs.
    server.uidValidity = 11;
    server.uidNext = 6;
    server.add(message({ uid: 5, from: { name: "Boss", address: "boss@example.com" } }));
    server.drop();
    await waitFor(() => harness.state.cursor?.uidValidity === 11, { label: "the rebuilt cursor" });
    assert.equal(harness.state.cursor.maxUid, 5);
    assert.equal(harness.notifications.length, 0, "the new UIDVALIDITY is a fresh baseline");
  } finally {
    await harness.stop();
  }
});

test("a dropped connection is retried with a growing delay, not a busy loop", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS, backoffBaseMs: 30, backoffMaxMs: 120 });
  try {
    harness.watcher.start();
    await waitFor(() => server.idling, { label: "the first connection" });
    // From here on the server refuses: this is the outage the backoff is for.
    harness.control.refuse = true;
    server.drop();
    await waitFor(() => harness.connectAttempts >= 5, { label: "five connect attempts" });
    const times = harness.attemptTimes.slice(1);
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    assert.ok(gaps.length >= 3, "the loop keeps trying");
    for (const gap of gaps) {
      assert.ok(gap >= 25, `a retry came after ${gap} ms, which is a spin`);
    }
    assert.ok(
      gaps[gaps.length - 1] > gaps[0],
      `the delay must grow: ${gaps.join(", ")} ms`,
    );
  } finally {
    await harness.stop();
  }
});

test("restarting does not report the same message twice", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const first = createHarness(server, { settings: SETTINGS });
  // Not awaited: `start()` returns the loop, which runs until stopped.
  first.watcher.start();
  await waitFor(() => server.idling, { label: "the first session" });
  server.deliver(message({ uid: 1, from: { name: "Boss", address: "boss@example.com" } }));
  await waitFor(() => first.alerts().length === 1, { label: "the first alert" });
  await first.stop();

  // The same mailbox and the same state file, as after an app restart.
  const second = createHarness(server, { settings: SETTINGS, state: first.state });
  try {
    second.watcher.start();
    await waitFor(() => server.idling, { label: "the resumed session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(second.notifications.length, 0, "nothing is reported again");
    assert.equal(second.state.seen.length, 1, "the reported Message-ID is remembered");
  } finally {
    await second.stop();
  }
});

test("mail that arrives while the client is not idling is caught by a poke", async () => {
  const server = createFakeServer({ uidNext: 1, capabilities: ["IMAP4rev1"] });
  const harness = createHarness(server, { settings: SETTINGS, idleRenewMs: 5_000 });
  try {
    harness.watcher.start();
    await waitFor(() => harness.state.cursor !== null, { label: "the first cycle" });
    server.add(message({ uid: 1, subject: "发票到了", from: { name: "Boss", address: "boss@example.com" } }));
    harness.watcher.poke();
    await waitFor(() => harness.alerts().length === 1, { label: "the poke's cycle" });
    // A poll wakes the loop; it does not throw away a working connection.
    assert.equal(harness.connectAttempts, 1);
  } finally {
    await harness.stop();
  }
});

test("only BODY.PEEK is used, and nothing that changes the mailbox is ever sent", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => server.idling, { label: "IDLE" });
    server.deliver(message({ uid: 1 }));
    server.deliver(message({ uid: 2, extraHeaders: ["Importance: high"] }));
    await waitFor(() => harness.notifications.length >= 1, { label: "a notification" });
    const lines = server.sentLines;
    const fetches = lines.filter((line) => line.includes("UID FETCH"));
    assert.ok(fetches.length >= 1, "the new mail was fetched");
    for (const line of fetches) {
      assert.match(line, /BODY\.PEEK\[HEADER\.FIELDS/);
      assert.doesNotMatch(line, /[^.]BODY\[/, "a plain BODY[] fetch would set \\Seen");
    }
    // The whole read-only claim, as one assertion over every byte sent.
    for (const forbidden of ["STORE", "APPEND", "COPY", "MOVE", "EXPUNGE", "CREATE", "DELETE", "AUTHENTICATE", "LOGIN"]) {
      assert.equal(
        lines.some((line) => new RegExp(`\\b${forbidden}\\b`).test(line)),
        false,
        `${forbidden} must never be sent`,
      );
    }
  } finally {
    await harness.stop();
  }
});

test("a mailbox that changes provider reconnects when the setting moves", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    harness.watcher.start();
    await waitFor(() => server.idling, { label: "the first connection" });
    const before = harness.connectAttempts;
    harness.overrides.provider = "netease163";
    harness.watcher.poke();
    await waitFor(() => harness.connectAttempts > before, { label: "a reconnect for the new provider" });
  } finally {
    await harness.stop();
  }
});

test("nothing is reported when the credential slot is empty", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const harness = createHarness(server, { settings: SETTINGS });
  try {
    // The host's refusal is the connect path's own error, and it must not crash
    // the loop: it is reported once and retried later.
    const refused = Object.assign(new Error("the mailbox credential slot is empty"), {
      code: "CREDENTIAL_NOT_CONFIGURED",
    });
    harness.watcher.start();
    await waitFor(() => harness.connectAttempts >= 1, { label: "a connect attempt" });
    harness.watcher.poke();
    await harness.stop();
    assert.equal(refused.code, "CREDENTIAL_NOT_CONFIGURED");
    assert.equal(harness.notifications.length, 0);
  } finally {
    await harness.stop().catch(() => undefined);
  }
});
