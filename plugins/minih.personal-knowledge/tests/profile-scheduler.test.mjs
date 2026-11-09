import assert from "node:assert/strict";
import { test } from "node:test";

import { ProfileCandidateScheduler, SCHEDULE_INTERVAL_MS, candidateDue } from "../lib/profile-candidates.mjs";
import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

/** A scheduler whose clock and timer are fully under the test's control. */
function makeScheduler(options = {}) {
  // Read the options on every call: a caller may pass a getter or a clock that
  // it reassigns between checks.
  const readOnly = () => options.readOnly === true;
  const now = () => (typeof options.now === "function" ? options.now() : new Date("2026-11-09T08:00:00Z"));
  const readSettings = () => (typeof options.settings === "function" ? options.settings() : options.settings);
  const runs = [];
  const timers = [];
  const scheduler = new ProfileCandidateScheduler({
    settings: async () => readSettings(),
    run: async () => {
      runs.push(now().toISOString());
      return { written: true, path: "00 Inbox/画像候选 2026-11-09.md" };
    },
    isReadOnly: async () => readOnly(),
    now: () => now(),
  });
  // Replace the real timer with a handle the test can inspect and fire.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {}, cleared: false };
    timers.push(handle);
    return handle;
  };
  const realClearInterval = globalThis.clearInterval;
  globalThis.clearInterval = (handle) => {
    handle.cleared = true;
  };
  // Any other timer created meanwhile (Node internals) keeps working.
  scheduler.__restore = () => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  };
  return { scheduler, runs, timers };
}

test("the scheduler checks the interval and stops with the plugin", async (t) => {
  const { scheduler, timers } = makeScheduler({ settings: { enabled: false } });
  t.after(() => scheduler.__restore());
  scheduler.start();
  await scheduler.check({ reason: "startup" });
  assert.equal(timers.length, 1);
  assert.equal(SCHEDULE_INTERVAL_MS, 6 * 60 * 60 * 1000, "the automatic check runs every six hours");
  assert.equal(timers[0].ms, SCHEDULE_INTERVAL_MS);
  await scheduler.stop();
  assert.equal(timers[0].cleared, true, "onUnload clears the timer");
  assert.equal(scheduler.timer, null);
});

test("with the switch off nothing runs", async (t) => {
  const { scheduler, runs } = makeScheduler({ settings: { enabled: false, modelKey: "m" } });
  t.after(() => scheduler.__restore());
  scheduler.start();
  await scheduler.check({ reason: "startup" });
  const result = await scheduler.check({ reason: "startup" });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "DISABLED");
  assert.deepEqual(runs, []);
});

test("without a model key nothing runs", async (t) => {
  const { scheduler, runs } = makeScheduler({ settings: { enabled: true } });
  t.after(() => scheduler.__restore());
  scheduler.start();
  await scheduler.check({ reason: "startup" });
  const result = await scheduler.check({ reason: "startup" });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "MODEL_REQUIRED");
  assert.deepEqual(runs, []);
});

test("read-only mode refuses the automatic run", async (t) => {
  const { scheduler, runs } = makeScheduler({ settings: { enabled: true, modelKey: "m" }, readOnly: true });
  t.after(() => scheduler.__restore());
  scheduler.start();
  await scheduler.check({ reason: "startup" });
  const result = await scheduler.check({ reason: "startup" });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "READ_ONLY");
  assert.deepEqual(runs, []);
});

test("a due setting runs once and then waits for the week to pass", async (t) => {
  let clock = new Date("2026-11-09T08:00:00Z");
  let settings = { enabled: true, modelKey: "m" };
  const { scheduler, runs } = makeScheduler({
    get settings() {
      return settings;
    },
    now: () => clock,
  });
  t.after(() => scheduler.__restore());
  scheduler.start();
  await scheduler.running;
  assert.equal(runs.length, 1, "start() runs one due check immediately");

  // The real run records `lastRunAt`; simulate that bookkeeping here.
  settings = { enabled: true, modelKey: "m", lastRunAt: clock.toISOString() };
  const repeat = await scheduler.check({ reason: "interval" });
  assert.equal(repeat.ran, false);
  assert.equal(repeat.reason, "TOO_SOON");
  assert.equal(runs.length, 1, "a second check inside the week does nothing");

  clock = new Date(clock.getTime() + 8 * 86_400_000);
  const later = await scheduler.check({ reason: "interval" });
  assert.equal(later.ran, true);
  assert.equal(runs.length, 2, "a week later it runs again");
});

test("after stop() a pending check does not start a run", async (t) => {
  const { scheduler, runs } = makeScheduler({ settings: () => ({ enabled: true, modelKey: "m" }) });
  t.after(() => scheduler.__restore());
  scheduler.start();
  await scheduler.running;
  await scheduler.stop();
  runs.length = 0;
  const fired = await scheduler.check({ reason: "interval" });
  assert.equal(fired.ran, false);
  assert.equal(fired.reason, "STOPPED");
  assert.deepEqual(runs, [], "the timer-driven check does nothing after stop()");
});

test("a failing run is recorded but not retried inside the week", async (t) => {
  let settings = { enabled: true, modelKey: "m" };
  const scheduler = new ProfileCandidateScheduler({
    settings: async () => settings,
    run: async () => {
      settings = { ...settings, lastRunAt: "2026-11-09T08:00:00Z", lastError: "MODEL_FAILED" };
      return { written: false, reason: "MODEL_FAILED" };
    },
    now: () => new Date("2026-11-09T08:00:00Z"),
  });
  t.after(() => scheduler.__restore?.());
  scheduler.start();
  await scheduler.running;
  const second = await scheduler.check({ reason: "interval" });
  assert.equal(second.ran, false);
  assert.equal(second.reason, "TOO_SOON");
  assert.equal(candidateDue(settings, new Date("2026-11-09T08:00:00Z")).reason, "TOO_SOON");
});
