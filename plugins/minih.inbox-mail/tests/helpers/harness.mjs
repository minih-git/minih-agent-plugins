/**
 * The plugin's polling watcher, wired to a fake server and a fake clock.
 *
 * Nothing here reaches a real mailbox, and nothing waits for real minutes: the
 * timings are milliseconds, so a test that would otherwise take half an hour runs
 * in one. The state object is the same one the watcher persists through, which is
 * how "restarting does not report the same message twice" is tested.
 */

import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { createSession } = require("../../lib/session.js");
const { createGate } = require("../../lib/gate.js");
const { createWatcher } = require("../../lib/watcher.js");
const { normalizeSettings } = require("../../lib/settings.js");
const store = require("../../lib/store.js");

export { store };

/** Poll until `predicate` holds, or fail with what was being waited on. */
export async function waitFor(predicate, { timeout = 3000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

export function createHarness(server, options = {}) {
  const settings = normalizeSettings({ ...options.settings });
  const overrides = {};
  const state = options.state ?? store.emptyState();
  const notifications = [];
  const errors = [];
  const persisted = [];
  /** Whether the next connect refuses, which is what an unreachable server does. */
  const control = { refuse: options.refuse ?? false };
  /** When each connect was attempted, so a test can measure the backoff. */
  const attemptTimes = [];
  const gate = options.gate ?? createGate(options.maxConcurrent ?? 4);

  const watcher = createWatcher({
    connect: async () => {
      attemptTimes.push(Date.now());
      if (control.refuse) {
        throw Object.assign(new Error("the server refused the connection"), { code: "CONNECT_FAILED" });
      }
      if (options.connectDelayMs) await sleep(options.connectDelayMs);
      const transport = server.accept();
      return createSession(transport, { timeoutMs: options.sessionTimeoutMs ?? 400 });
    },
    state,
    persist: async (next) => {
      persisted.push(JSON.parse(JSON.stringify(next)));
    },
    settings: () => ({ ...settings, ...overrides }),
    account: { instanceId: options.instanceId ?? "acc_00000001", label: options.label ?? "owner@example.com" },
    notify: {
      alert: (message, reasons) => notifications.push({ kind: "alert", message, reasons }),
      digest: (entries) => notifications.push({ kind: "digest", entries }),
    },
    onError: (error) => errors.push(error),
    onCycle: options.onCycle,
    log: () => {},
    now: () => Date.now(),
    timers: { setTimeout, clearTimeout },
    clientId: { name: "test", vendor: "minih", version: "0.0.0" },
    gate,
    // Long by default, so only an explicit check polls; every test that cares
    // about the interval measures it through the watcher's own status.
    pollMs: options.pollMs ?? 60_000,
    staggerMs: options.staggerMs ?? 0,
    backoffBaseMs: options.backoffBaseMs ?? 5,
    backoffMaxMs: options.backoffMaxMs ?? 20,
    maxFetch: options.maxFetch ?? 25,
  });

  return {
    watcher,
    state,
    settings,
    overrides,
    gate,
    control,
    attemptTimes,
    notifications,
    errors,
    persisted,
    get connectAttempts() {
      return attemptTimes.length;
    },
    alerts: () => notifications.filter((entry) => entry.kind === "alert"),
    digests: () => notifications.filter((entry) => entry.kind === "digest"),
    async stop() {
      await watcher.stop();
    },
  };
}

/** Assert that a condition is not met, for the "nothing happened" cases. */
export async function stays(predicate, { ms = 40, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await predicate()) throw new Error(`${label} happened`);
    await sleep(2);
  }
}