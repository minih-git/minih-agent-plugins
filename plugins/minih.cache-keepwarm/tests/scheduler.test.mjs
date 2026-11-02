import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The plugin process against a fake host, with a controlled clock.
 *
 * No test here waits for real time: `node:test`'s mock timers own `setTimeout`
 * and `Date`, so "fifty minutes later" is a call, and every case can assert both
 * the request that was sent and the request that was deliberately not sent.
 */

const require = createRequire(import.meta.url);
const MAIN = require.resolve("../main.js");
const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;
const SESSION = "session-1";

function freshMain() {
  delete require.cache[MAIN];
  delete globalThis.pi;
  return require(MAIN);
}

/**
 * Load the plugin the way the host does: it builds the API, puts it on
 * `globalThis.pi`, and calls `onLoad()` with no argument
 * (`apps/desktop/electron/main/plugin-host-process.mjs`, `handleInit`). Passing
 * `pi` as an argument is what the 0.1.0 tests did, and why they missed a plugin
 * that never worked in the real app.
 */
async function loadLikeHost(plugin, fake) {
  globalThis.pi = fake.pi;
  await plugin.onLoad();
}

function fakeHost({
  settings = {},
  modelId = "claude-sonnet-4-5",
  results = [],
  supportsKeepWarm = true,
} = {}) {
  const dataPath = mkdtempSync(join(tmpdir(), "kw-plugin-"));
  const state = { keepWarm: [], settings };
  const listeners = new Map();
  let index = 0;
  const pi = {
    plugin: {
      getDataPath: async () => dataPath,
      getSettings: async () => ({ ...state.settings }),
      setSettings: async (partial) => {
        Object.assign(state.settings, partial);
      },
    },
    app: { getLocale: async () => "zh-CN" },
    events: {
      on: (name, handler) => {
        listeners.set(name, handler);
        return async () => listeners.delete(name);
      },
    },
    session: {
      ...(supportsKeepWarm ? { keepWarm: async ({ sessionId }) => {
        state.keepWarm.push(sessionId);
        const next = results[Math.min(index, results.length - 1)] ?? {
          status: "skipped",
          reason: "no_prior_request",
        };
        index += 1;
        // The host names the model on every answer.
        return { ...next, model: { providerId: "router", modelId } };
      } } : {}),
    },
  };
  return {
    pi,
    state,
    dataPath,
    emitTurnEnded() {
      listeners.get("session:turnEnded")?.({ sessionId: SESSION, turnId: "turn-1", reason: "completed" });
    },
    cleanup() {
      rmSync(dataPath, { recursive: true, force: true });
    },
  };
}

/**
 * Advance the mocked clock, firing whatever is due on the way.
 *
 * One call advances to the end of the window before running the timers, so a
 * single big jump models a frozen process rather than a live one: use it to
 * prove that nothing is due, and step exactly to a deadline to let it fire.
 */
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await settle();
}

/** Move the clock without firing anything yet, then let due timers run late. */
async function jumpTo(t, at) {
  t.mock.timers.setTime(at);
  t.mock.timers.tick(0);
  await settle();
}

const settle = async () => {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function warmed(costUsd, cacheReadRatio = 0.95) {
  return {
    status: "warmed",
    usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 48_000, cacheWriteTokens: 300, costUsd, durationMs: 700 },
    cacheReadRatio,
  };
}

test("switching a session on arms the schedule and sends one request per interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ results: [warmed(0.02)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  assert.equal(fake.state.keepWarm.length, 0, "nothing is sent at the moment of the switch");

  await advance(t, 50 * MINUTE);
  assert.deepEqual(fake.state.keepWarm, [SESSION]);

  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.enabled, true);
  assert.equal(status.stopped, null);
  assert.match(status.label, /今日 \$0\.02/);
  assert.match(status.label, /下次/);
  await plugin.onUnload();
});

test("a real turn re-times the next request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ results: [warmed(0.02), warmed(0.03)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();

  // The user comes back at minute 20; the next request is 50 minutes after that.
  await advance(t, 20 * MINUTE);
  fake.emitTurnEnded();
  await settle();
  await advance(t, 49 * MINUTE);
  assert.deepEqual(fake.state.keepWarm, [], "the turn moved the deadline forward");

  await advance(t, MINUTE);
  assert.deepEqual(fake.state.keepWarm, [SESSION]);
  await plugin.onUnload();
});

test("a timer that fires long after its moment does not spend", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ results: [warmed(0.02)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();

  // The machine slept through the due time and wakes ninety minutes later.
  await jumpTo(t, NOW + 90 * MINUTE);
  assert.deepEqual(fake.state.keepWarm, [], "an hour-old cache is not refreshed");

  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "prefix_expired");
  await plugin.onUnload();
});

test("the ceiling stops the schedule and says why", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ settings: { maxConsecutive: 2 }, results: [warmed(0.02), warmed(0.02), warmed(0.02)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  for (let round = 1; round <= 3; round++) await advance(t, 50 * MINUTE);
  assert.equal(fake.state.keepWarm.length, 2, "the third request never goes out");
  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "consecutive");
  assert.match(status.label, /已停止：连续 4 次无真实对话/);
  await plugin.onUnload();
});

test("a session the host refuses is shown, not retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ results: [{ status: "skipped", reason: "prefix_changed" }] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  await advance(t, 50 * MINUTE);
  await advance(t, 200 * MINUTE);
  assert.deepEqual(fake.state.keepWarm, [SESSION]);
  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "prefix_changed");
  assert.match(status.label, /提示词已变化/);
  await plugin.onUnload();
});

test("a real turn does not revive a session whose model the user excluded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ modelId: "deepseek-v3", results: [warmed(0.02)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  await advance(t, 50 * MINUTE);
  fake.emitTurnEnded();
  await settle();
  await advance(t, 50 * MINUTE);
  assert.deepEqual(fake.state.keepWarm, [SESSION], "the excluded model is not warmed twice");
  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "outOfScope");
  assert.match(status.label, /已停止：模型不在范围内/);
  await plugin.onUnload();
});

test("a real turn does not buy more spend on a day that hit its ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({
    settings: { dailyCostLimitUsd: 0.05, maxConsecutive: 10 },
    results: [warmed(0.05), warmed(0.05), warmed(0.05)],
  });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  await advance(t, 50 * MINUTE);
  assert.equal(fake.state.keepWarm.length, 1, "the first request spends the day's budget");

  let status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "dailyLimit");

  // The user comes back and talks. That revives the conversation, not the bill.
  fake.emitTurnEnded();
  await settle();
  status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "dailyLimit", "a turn must not lift the daily ceiling");

  await advance(t, 50 * MINUTE);
  await advance(t, 50 * MINUTE);
  assert.equal(fake.state.keepWarm.length, 1, "no further request goes out today");

  // Tomorrow the ceiling is no longer today's: the control's poll clears it, and
  // a new turn re-times the schedule from itself. (An untouched session does not
  // warm a day-old cache — the host would refuse it as expired.)
  await advance(t, 24 * 60 * MINUTE);
  const tomorrow = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(tomorrow.stopped, null, "the daily ceiling expires with its day");
  fake.emitTurnEnded();
  await settle();
  await advance(t, 50 * MINUTE);
  assert.equal(fake.state.keepWarm.length, 2);
  await plugin.onUnload();
});

test("an app without the keep-warm API shows a version message, not a broken plugin", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ supportsKeepWarm: false });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  // The plugin has to load: `engines.minihAgent` is not compared by the host, so
  // an older app hands over a `pi` without the method.
  await loadLikeHost(plugin, fake);
  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.enabled, false);
  assert.match(status.label, /已停止：应用版本过旧/);
  // Switching it on is refused the same way, and nothing is scheduled.
  const toggled = await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  assert.equal(toggled.enabled, false);
  await advance(t, 240 * MINUTE);
  await plugin.onUnload();
});

test("unloading clears every timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ results: [warmed(0.02)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  await plugin.onUnload();
  await advance(t, 240 * MINUTE);
  assert.deepEqual(fake.state.keepWarm, []);
});

test("a session outside the model scope stops after the answer that names it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const plugin = freshMain();
  const fake = fakeHost({ modelId: "deepseek-v3", results: [warmed(0.02)] });
  t.after(() => {
    fake.cleanup();
    t.mock.timers.reset();
  });
  await loadLikeHost(plugin, fake);
  await plugin.onRendererCall("toggle", { sessionId: SESSION, enabled: true });
  await settle();
  // Stepping exactly to the due time is what a live timer does; a single large
  // jump would fire late and be refused before it was ever sent.
  await advance(t, 50 * MINUTE);
  await advance(t, 250 * MINUTE);
  // One request names the model; that is what stops the schedule, and nothing
  // is spent again.
  assert.deepEqual(fake.state.keepWarm, [SESSION]);
  const status = await plugin.onRendererCall("status", { sessionId: SESSION });
  assert.equal(status.stopped, "outOfScope");
  await plugin.onUnload();
});
