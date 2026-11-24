import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createFakePop3Server, popMessage } from "./helpers/fake-pop3.mjs";

const require = createRequire(import.meta.url);
const store = require("../lib/store.js");
const { createClient } = require("../lib/pop3.js");
const { createPop3Watcher } = require("../lib/pop3-watcher.js");

/**
 * The polling watcher, wired to a scripted server and a clock this test owns.
 *
 * What is asserted is the behaviour a user would notice: the first poll says
 * nothing, mail that arrives later is announced once, the envelope list follows,
 * and the interval respects both the plugin's default and the server's own
 * LOGIN-DELAY. Nothing here reaches a real mailbox.
 */

function createHarness(server, options = {}) {
  const clock = { now: 1_000 };
  const state = options.state ?? store.emptyState();
  const notifications = [];
  const errors = [];
  const settings = {
    importantSenders: "",
    keywords: "",
    digestMinutes: 30,
    unreadOnly: false,
    ...options.settings,
  };
  const control = { refuse: options.refuse ?? false };
  const watcher = createPop3Watcher({
    connect: async () => {
      if (control.refuse) {
        throw Object.assign(new Error("the mail server refused the connection"), { code: "CONNECT_FAILED" });
      }
      return createClient(server.accept(), { timeoutMs: 400, log: () => {} });
    },
    state,
    persist: async () => {},
    settings: () => settings,
    account: { instanceId: "acc_1", label: "owner@example.com" },
    notify: {
      alert: (message) => notifications.push({ kind: "alert", message }),
      digest: (entries) => notifications.push({ kind: "digest", entries }),
    },
    onError: (error) => errors.push(error),
    log: () => {},
    now: () => clock.now,
    timers: { setTimeout, clearTimeout },
    // Long by default, so only an explicit check polls; the interval itself is
    // asserted through `status.pollIntervalMs`.
    pollMs: options.pollMs ?? 60_000,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    catchUpMs: 5,
    loginDelayMarginMs: options.loginDelayMarginMs ?? 5_000,
  });
  return { watcher, state, clock, settings, notifications, errors, control, server };
}

test("the first poll records a baseline and announces nothing", async () => {
  const server = createFakePop3Server({
    messages: [
      popMessage({ uidl: "AAA", from: { name: "Boss", address: "boss@example.com" }, subject: "old one" }),
      popMessage({ uidl: "BBB", subject: "old two" }),
    ],
  });
  const harness = createHarness(server, { settings: { importantSenders: "boss@example.com" } });
  try {
    const result = await harness.watcher.checkNow();
    assert.equal(result.checked, true);
    assert.equal(result.handled, 0);
    assert.deepEqual(harness.notifications, [], "an archive is not new mail");
    assert.equal(store.pop3Baselined(harness.state), true);
    assert.deepEqual(harness.state.pop3.uidls, ["AAA", "BBB"]);
    assert.deepEqual(harness.state.messages, [], "the panel starts empty, like the IMAP path");
    // Headers-only commands: no TOP for mail that was already there.
    assert.deepEqual(
      server.sentLines.map((line) => line.split(" ")[0]),
      ["CAPA", "STAT", "UIDL", "QUIT"],
    );
    assert.equal(harness.watcher.status.phase, "connected");
  } finally {
    await harness.watcher.stop();
  }
});

test("a message that arrives after the baseline is announced once, by UIDL", async () => {
  const server = createFakePop3Server({ messages: [popMessage({ uidl: "AAA" })] });
  const harness = createHarness(server, { settings: { importantSenders: "boss@example.com" } });
  try {
    await harness.watcher.checkNow();
    server.deliver(
      popMessage({ uidl: "CCC", from: { name: "Boss", address: "boss@example.com" }, subject: "预算" }),
    );
    const first = await harness.watcher.checkNow();
    assert.equal(first.handled, 1);
    assert.equal(harness.notifications.length, 1);
    const [alert] = harness.notifications;
    assert.equal(alert.kind, "alert");
    assert.equal(alert.message.subject, "预算");
    assert.equal(alert.message.key, "pop3:CCC");
    // The header block came from TOP, never from a whole message.
    assert.ok(server.sentLines.includes("TOP 2 0"), server.sentLines.join(" | "));
    assert.equal(server.sentLines.some((line) => line.startsWith("RETR")), false);

    const envelope = harness.state.messages.find((entry) => entry.key === "pop3:CCC");
    assert.ok(envelope, "the panel's list follows the same headers");
    assert.equal(envelope.subject, "预算");
    assert.deepEqual(envelope.flags, [], "POP3 reports no flags, so none are invented");
    assert.equal(harness.state.pop3.uidls.includes("CCC"), true);

    // A second poll over the same maildrop announces nothing new.
    const second = await harness.watcher.checkNow();
    assert.equal(second.handled, 0);
    assert.equal(harness.notifications.length, 1);
  } finally {
    await harness.watcher.stop();
  }
});

test("a server without TOP is read with a capped RETR instead, for the headers only", async () => {
  const server = createFakePop3Server({ refuseTop: true, messages: [] });
  const harness = createHarness(server, { settings: { keywords: "invoice" } });
  try {
    await harness.watcher.checkNow();
    server.deliver(popMessage({ uidl: "AAA", subject: "invoice 42", body: "x".repeat(5000) }));
    await harness.watcher.checkNow();
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].message.subject, "invoice 42");
    const retr = server.sentLines.find((line) => line.startsWith("RETR"));
    assert.equal(retr, "RETR 1");
  } finally {
    await harness.watcher.stop();
  }
});

test("everything that is not important is collected into one digest after its interval", async () => {
  const server = createFakePop3Server({ messages: [] });
  const harness = createHarness(server, { settings: { digestMinutes: 1 } });
  try {
    await harness.watcher.checkNow();
    server.deliver(popMessage({ uidl: "AAA", subject: "newsletter" }));
    await harness.watcher.checkNow();
    assert.deepEqual(harness.notifications, [], "a digest waits for its interval");
    assert.equal(harness.state.pending.length, 1);
    assert.equal(harness.state.pending[0].key, "pop3:AAA");

    harness.clock.now += 61_000;
    await harness.watcher.checkNow();
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].kind, "digest");
    assert.equal(harness.notifications[0].entries[0].subject, "newsletter");
    assert.deepEqual(harness.state.pending, []);
  } finally {
    await harness.watcher.stop();
  }
});

test("LOGIN-DELAY from the server is a floor for the poll interval", async () => {
  const server = createFakePop3Server({ loginDelay: 120 });
  const harness = createHarness(server, { pollMs: 60_000 });
  try {
    assert.equal(harness.watcher.status.pollIntervalMs, 60_000, "before the first CAPA, the plugin default");
    await harness.watcher.checkNow();
    assert.equal(harness.watcher.status.pollIntervalMs, 125_000, "120 s from the server, plus the margin");
  } finally {
    await harness.watcher.stop();
  }
});

test("a failed connection is recorded and does not stop the next poll", async () => {
  const server = createFakePop3Server({ messages: [] });
  const harness = createHarness(server, { refuse: true, settings: { importantSenders: "boss@example.com" } });
  try {
    const failed = await harness.watcher.checkNow();
    assert.equal(failed.checked, false);
    assert.equal(harness.watcher.status.phase, "error");
    assert.equal(harness.errors.length, 1);
    assert.match(harness.state.lastError, /CONNECT_FAILED/);

    harness.control.refuse = false;
    server.deliver(popMessage({ uidl: "AAA", from: { name: "Boss", address: "boss@example.com" }, subject: "back" }));
    const recovered = await harness.watcher.checkNow();
    assert.equal(recovered.checked, true, "the first success is also the baseline");
    assert.equal(harness.watcher.status.phase, "connected");
  } finally {
    await harness.watcher.stop();
  }
});

test("opening a message resolves its UIDL to the message number of that session", async () => {
  const server = createFakePop3Server({
    messages: [popMessage({ uidl: "AAA", subject: "first" }), popMessage({ uidl: "BBB", subject: "second" })],
  });
  const harness = createHarness(server);
  try {
    await harness.watcher.checkNow();
    // A different maildrop order would give the same UIDL another number; the
    // lookup is what makes the panel's click survive that.
    server.entries.reverse();
    const fetched = await harness.watcher.fetchBody("pop3:AAA", { maxBytes: 4096 });
    assert.match(fetched.body.toString(), /Subject: first/);
    assert.equal(fetched.truncated, false);
    assert.ok(server.sentLines.includes("RETR 2"), server.sentLines.join(" | "));
  } finally {
    await harness.watcher.stop();
  }
});

test("a message key the maildrop no longer holds is a coded error", async () => {
  const server = createFakePop3Server({ messages: [popMessage({ uidl: "AAA" })] });
  const harness = createHarness(server);
  try {
    await harness.watcher.checkNow();
    await assert.rejects(harness.watcher.fetchBody("pop3:GONE"), (error) => {
      assert.equal(error.code, "MESSAGE_NOT_FOUND");
      return true;
    });
  } finally {
    await harness.watcher.stop();
  }
});