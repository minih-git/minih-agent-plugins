import assert from "node:assert/strict";
import { test } from "node:test";

import keepwarm from "../lib/keepwarm.js";

/**
 * The scheduling rules, with no clock and no app: every case here is a decision
 * the plugin makes on its own, and each one is a place where spending the user's
 * money has to stop.
 */

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;

function session(overrides = {}) {
  return keepwarm.normalizeSession({ enabled: true, lastTurnEndedAt: NOW, ...overrides });
}

test("settings fall back to the designed defaults", () => {
  assert.deepEqual(keepwarm.normalizeSettings({}), {
    intervalMinutes: 50,
    maxConsecutive: 4,
    dailyCostLimitUsd: 1,
    modelScope: "anthropic",
  });
});

test("the interval stays inside the range a one-hour cache supports", () => {
  assert.equal(keepwarm.normalizeSettings({ intervalMinutes: 5 }).intervalMinutes, 30);
  assert.equal(keepwarm.normalizeSettings({ intervalMinutes: 300 }).intervalMinutes, 55);
  assert.equal(keepwarm.normalizeSettings({ intervalMinutes: 45 }).intervalMinutes, 45);
  // A value that is not a number is not a request for zero.
  assert.equal(keepwarm.normalizeSettings({ intervalMinutes: "x" }).intervalMinutes, 50);
});

test("the model scope decides which model families are worth warming", () => {
  assert.equal(keepwarm.modelAllowed("anthropic", "claude-sonnet-4-5"), true);
  assert.equal(keepwarm.modelAllowed("anthropic", "gpt-5.2"), false);
  assert.equal(keepwarm.modelAllowed("anthropicOpenai", "gpt-5.2"), true);
  assert.equal(keepwarm.modelAllowed("anthropicOpenai", "deepseek-v3"), false);
  assert.equal(keepwarm.modelAllowed("all", "deepseek-v3"), true);
  // Unknown is not out of scope: the first answer names the model.
  assert.equal(keepwarm.modelAllowed("anthropic", ""), true);
});

test("the scope stops a session once the host names an out-of-scope model", () => {
  const settings = keepwarm.normalizeSettings({ modelScope: "anthropic" });
  const allowed = keepwarm.applyModelScope(session(), settings, "claude-sonnet-4-5", NOW);
  assert.equal(allowed.stop, undefined);
  assert.equal(allowed.session.lastModelId, "claude-sonnet-4-5");

  const refused = keepwarm.applyModelScope(session(), settings, "deepseek-v3", NOW);
  assert.equal(refused.stop, "outOfScope");
  assert.equal(refused.session.stopped.key, "outOfScope");

  const unknown = keepwarm.applyModelScope(session(), settings, "", NOW);
  assert.equal(unknown.stop, undefined);
});

test("the next request is one interval after the later of the turn and the last warm", () => {
  const settings = keepwarm.normalizeSettings({});
  assert.equal(
    keepwarm.dueAt(session({ lastTurnEndedAt: NOW }), settings),
    NOW + 50 * MINUTE,
  );
  assert.equal(
    keepwarm.dueAt(session({ lastTurnEndedAt: NOW, lastWarmAt: NOW + 10 * MINUTE }), settings),
    NOW + 60 * MINUTE,
  );
  assert.equal(keepwarm.dueAt(session({ lastTurnEndedAt: 0 }), settings), Infinity);
});

test("a real turn resets the streak and revives a stopped session", () => {
  const stopped = session({ consecutive: 3, stopped: { key: "consecutive", at: NOW } });
  const next = keepwarm.applyTurnEnded(stopped, NOW + MINUTE);
  assert.equal(next.consecutive, 0);
  assert.equal(next.stopped, null);
  assert.equal(next.lastTurnEndedAt, NOW + MINUTE);
});

test("a real turn lifts a cache stop but never the day's ceiling", () => {
  const stop = (key) => session({ consecutive: 3, stopped: { key, at: NOW } });
  // A turn proves the conversation is alive again: the cache is worth warming.
  assert.equal(keepwarm.applyTurnEnded(stop("cacheMiss"), NOW + MINUTE).stopped, null);
  assert.equal(keepwarm.applyTurnEnded(stop("consecutive"), NOW + MINUTE).stopped, null);
  // It proves nothing about the money: today's bill is still today's bill.
  const limited = keepwarm.applyTurnEnded(stop("dailyLimit"), NOW + MINUTE);
  assert.equal(limited.stopped.key, "dailyLimit");
  assert.equal(limited.consecutive, 0);
  // A new local day starts the counter over and lifts the stop with it.
  const tomorrow = keepwarm.applyTurnEnded(stop("dailyLimit"), NOW + 24 * 60 * MINUTE);
  assert.equal(keepwarm.rollDay(tomorrow, NOW + 24 * 60 * MINUTE).dayCostUsd, 0);
});

test("the day's remaining budget is checked before a request, not only after one", () => {
  const settings = keepwarm.normalizeSettings({ dailyCostLimitUsd: 0.05 });
  const spent = session({ dayKey: keepwarm.dayKey(NOW), dayCostUsd: 0.05 });
  assert.equal(keepwarm.withinDailyLimit(spent, settings, NOW), false);
  const under = session({ dayKey: keepwarm.dayKey(NOW), dayCostUsd: 0.04 });
  assert.equal(keepwarm.withinDailyLimit(under, settings, NOW), true);
  // The same record, one local day later, has a full budget again.
  assert.equal(keepwarm.withinDailyLimit(spent, settings, NOW + 24 * 60 * MINUTE), true);
});

test("a warmed request counts the spend and keeps the schedule going", () => {
  const settings = keepwarm.normalizeSettings({ maxConsecutive: 4, dailyCostLimitUsd: 1 });
  const result = keepwarm.applyWarmed(session(), settings, {
    usage: { costUsd: 0.02 },
    cacheReadRatio: 0.96,
  }, NOW + 50 * MINUTE);
  assert.equal(result.stop, undefined);
  assert.equal(result.session.consecutive, 1);
  assert.equal(result.session.dayCostUsd, 0.02);
  assert.equal(result.session.lastWarmAt, NOW + 50 * MINUTE);
});

test("a request that mostly rewrote the prefix stops the schedule", () => {
  const settings = keepwarm.normalizeSettings({});
  const result = keepwarm.applyWarmed(session(), settings, {
    usage: { costUsd: 0.4 },
    cacheReadRatio: 0.12,
  }, NOW + 50 * MINUTE);
  assert.equal(result.stop, "cacheMiss");
  assert.equal(result.session.stopped.key, "cacheMiss");
});

test("four consecutive requests without a turn stop the schedule", () => {
  const settings = keepwarm.normalizeSettings({ maxConsecutive: 4 });
  let current = session();
  for (let index = 0; index < 3; index++) {
    const applied = keepwarm.applyWarmed(current, settings, {
      usage: { costUsd: 0.01 },
      cacheReadRatio: 0.9,
    }, NOW + (index + 1) * 50 * MINUTE);
    assert.equal(applied.stop, undefined);
    current = applied.session;
  }
  const last = keepwarm.applyWarmed(current, settings, {
    usage: { costUsd: 0.01 },
    cacheReadRatio: 0.9,
  }, NOW + 4 * 50 * MINUTE);
  assert.equal(last.stop, "consecutive");
  assert.equal(last.session.stopped.key, "consecutive");
});

test("the daily ceiling is per calendar day", () => {
  const settings = keepwarm.normalizeSettings({ dailyCostLimitUsd: 1, maxConsecutive: 10 });
  const spent = session({ dayKey: keepwarm.dayKey(NOW), dayCostUsd: 0.99 });
  const overLimit = keepwarm.applyWarmed(spent, settings, {
    usage: { costUsd: 0.02 },
    cacheReadRatio: 0.9,
  }, NOW + MINUTE);
  assert.equal(overLimit.stop, "dailyLimit");
  // The same session, one local day later, starts the counter from zero.
  const tomorrow = NOW + 24 * 60 * MINUTE;
  const nextDay = keepwarm.applyWarmed(
    { ...spent, stopped: null },
    settings,
    { usage: { costUsd: 0.02 }, cacheReadRatio: 0.9 },
    tomorrow,
  );
  assert.equal(nextDay.stop, undefined);
  assert.equal(nextDay.session.dayCostUsd, 0.02);
});

test("a busy session is retried, anything permanent stops", () => {
  const busy = keepwarm.applySkipped(session(), "session_busy", NOW);
  assert.equal(busy.session.stopped, null);
  assert.equal(busy.retryAt, NOW + keepwarm.BUSY_RETRY_MS);

  for (const reason of [
    "no_prior_request",
    "model_changed",
    "prefix_changed",
    "prefix_expired",
    "context_too_small",
    "protocol_unsupported",
    "runtime_unavailable",
  ]) {
    const applied = keepwarm.applySkipped(session(), reason, NOW);
    assert.equal(applied.session.stopped.key, reason, reason);
    assert.equal(applied.retryAt, undefined, reason);
  }
});

test("only an enabled, unstopped, in-scope session is scheduled", () => {
  const settings = keepwarm.normalizeSettings({});
  assert.equal(keepwarm.shouldSchedule(session(), settings, NOW, "claude-sonnet-4-5"), true);
  assert.equal(
    keepwarm.shouldSchedule(session({ enabled: false }), settings, NOW, "claude-sonnet-4-5"),
    false,
  );
  assert.equal(
    keepwarm.shouldSchedule(
      session({ stopped: { key: "dailyLimit", at: NOW } }),
      settings,
      NOW,
      "claude-x",
    ),
    false,
  );
  // That same stop, from a previous day, no longer blocks anything.
  assert.equal(
    keepwarm.shouldSchedule(
      session({ stopped: { key: "dailyLimit", at: NOW } }),
      settings,
      NOW + 24 * 60 * MINUTE,
      "claude-x",
    ),
    true,
  );
  assert.equal(keepwarm.shouldSchedule(session(), settings, NOW, "gpt-5.2"), false);
  // An unknown model is scheduled: the host's answer is what names it.
  assert.equal(keepwarm.shouldSchedule(session(), settings, NOW, ""), true);
});
