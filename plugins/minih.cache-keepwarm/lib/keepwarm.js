"use strict";

/**
 * Session cache keep-warm — the scheduling rules, with no timers and no I/O.
 *
 * The host owns every decision about whether a request may be sent (see
 * `docs/adr` in the desktop repository, ADR 0339). What is left for the plugin is
 * this file: when to ask, when to stop asking, and how to explain either one to
 * the user. Keeping that arithmetic pure is what makes it testable without a
 * clock, a network or an app.
 */

/** The interval the user can choose, in minutes. */
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 55;

/**
 * The defaults the feature was designed around: a request every 50 minutes, at
 * most four in a row without a real turn, and one US dollar a day per session.
 *
 * 50 minutes sits inside the measured cache lifetime of roughly an hour with
 * enough margin that a slow request still lands before the cache expires.
 */
const DEFAULT_SETTINGS = {
  intervalMinutes: 50,
  maxConsecutive: 4,
  dailyCostLimitUsd: 1,
  modelScope: "anthropic",
};

/**
 * Below this share of prompt tokens read from cache, the request did not
 * refresh anything: the prefix was rewritten and the earlier requests stopped
 * paying off. The schedule stops instead of spending on a cache that is gone.
 */
const MIN_CACHE_READ_RATIO = 0.5;

/** How long to wait before retrying a session that was busy at its due time. */
const BUSY_RETRY_MS = 2 * 60 * 1000;

/**
 * Skip reasons that mean "this session can never be warmed as it stands".
 *
 * Each one is a state the user can change (switch the model back, keep talking
 * in the session, use a protocol that reports usage); no amount of waiting fixes
 * it, so the schedule stops and the control shows why.
 */
const PERMANENT_SKIP_REASONS = new Set([
  "no_prior_request",
  "model_changed",
  "prefix_changed",
  "prefix_expired",
  "context_too_small",
  "protocol_unsupported",
  "runtime_unavailable",
]);

const MODEL_FAMILIES = {
  anthropic: (modelId) => /claude|anthropic/i.test(modelId),
  openai: (modelId) => /gpt|^o[134](?:-|$)|openai/i.test(modelId),
};

function clampNumber(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Settings as the schedule reads them, whatever the stored values look like. */
function normalizeSettings(raw) {
  const settings = raw && typeof raw === "object" ? raw : {};
  const scope = ["anthropic", "anthropicOpenai", "all"].includes(settings.modelScope)
    ? settings.modelScope
    : DEFAULT_SETTINGS.modelScope;
  return {
    intervalMinutes: Math.round(
      clampNumber(
        settings.intervalMinutes,
        MIN_INTERVAL_MINUTES,
        MAX_INTERVAL_MINUTES,
        DEFAULT_SETTINGS.intervalMinutes,
      ),
    ),
    maxConsecutive: Math.round(
      clampNumber(settings.maxConsecutive, 1, 10, DEFAULT_SETTINGS.maxConsecutive),
    ),
    dailyCostLimitUsd: clampNumber(
      settings.dailyCostLimitUsd,
      0,
      100,
      DEFAULT_SETTINGS.dailyCostLimitUsd,
    ),
    modelScope: scope,
  };
}

/**
 * Whether a model is inside the scope the user chose.
 *
 * An unknown model is treated as allowed, because there is nowhere to learn it
 * from before a request runs: a plugin can only read sessions it imported, and
 * the keep-warm answer is the first place a session's model is named. Refusing
 * on unknown would block every session forever; instead the first answer names
 * the model, and `applyModelScope` stops the schedule when it is out of scope.
 */
function modelAllowed(scope, modelId) {
  if (scope === "all") return true;
  const id = String(modelId ?? "").trim();
  if (!id) return true;
  if (MODEL_FAMILIES.anthropic(id)) return true;
  if (scope === "anthropicOpenai") return MODEL_FAMILIES.openai(id);
  return false;
}

/**
 * Apply the model scope to one answer of the host.
 *
 * Returns the session with the model it learned, and the stop key when that
 * model is outside the scope the user chose. The plugin owns this limit: the
 * host does not know the setting, and a user who chose "Claude only" means it.
 */
function applyModelScope(session, settings, modelId, now) {
  const rolled = rollDay(session, now);
  if (!modelId) return { session: rolled };
  const updated = { ...rolled, lastModelId: modelId };
  if (modelAllowed(settings.modelScope, modelId)) return { session: updated };
  return {
    session: { ...updated, stopped: { key: "outOfScope", at: now } },
    stop: "outOfScope",
  };
}

/** A per-session record as the schedule reads it, defaulted but not repaired. */
function normalizeSession(raw) {
  const session = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: session.enabled === true,
    lastTurnEndedAt: Number.isFinite(session.lastTurnEndedAt) ? session.lastTurnEndedAt : 0,
    lastWarmAt: Number.isFinite(session.lastWarmAt) ? session.lastWarmAt : 0,
    consecutive: Number.isFinite(session.consecutive) ? Math.max(0, session.consecutive) : 0,
    dayKey: typeof session.dayKey === "string" ? session.dayKey : "",
    dayCostUsd: Number.isFinite(session.dayCostUsd) ? Math.max(0, session.dayCostUsd) : 0,
    stopped: session.stopped && typeof session.stopped === "object" ? session.stopped : null,
    lastSkipReason: typeof session.lastSkipReason === "string" ? session.lastSkipReason : null,
    lastModelId: typeof session.lastModelId === "string" ? session.lastModelId : "",
  };
}

/** The local calendar day, which is the day a spend ceiling is about. */
function dayKey(now) {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Start a new spending day when the calendar moved.
 *
 * A prompt cache does not care about midnight and the counter does: the ceiling
 * is per day per session, so yesterday's spend must not block today's first
 * request, and today's must not inherit yesterday's number.
 */
function rollDay(session, now) {
  const today = dayKey(now);
  if (session.dayKey === today) return session;
  return { ...session, dayKey: today, dayCostUsd: 0 };
}

/** When this session's next request is due, in epoch milliseconds. */
function dueAt(session, settings) {
  const anchor = Math.max(session.lastWarmAt, session.lastTurnEndedAt);
  if (!anchor) return Number.POSITIVE_INFINITY;
  return anchor + settings.intervalMinutes * 60 * 1000;
}

/**
 * Whether the schedule should arm a timer for this session now.
 *
 * A stopped session is a deliberately quiet one: the control shows the reason
 * and only a real turn (or the user switching it back on) resumes it.
 */
function shouldSchedule(session, settings, now, modelId) {
  if (!session.enabled) return false;
  if (activeStop(session, now)) return false;
  if (!modelAllowed(settings.modelScope, modelId)) return false;
  return Number.isFinite(dueAt(session, settings));
}

/**
 * The stop that still applies at `now`.
 *
 * A stop is the schedule's own memory, so it has to expire the way its cause
 * does: the daily ceiling belongs to one local day, and after midnight the
 * session may spend again without waiting for the user to say something first.
 * Every other stop lasts until a real turn or the switch.
 */
function activeStop(session, now) {
  const stopped = session.stopped;
  if (!stopped) return null;
  if (stopped.key !== "dailyLimit") return stopped;
  const at = Number.isFinite(stopped.at) ? stopped.at : 0;
  return dayKey(at) === dayKey(now) ? stopped : null;
}

/**
 * Whether the day's spend still leaves room for one more request.
 *
 * Checked before every request, not only when a counter is updated: a session
 * that was resumed by a real turn could otherwise spend again on a day it had
 * already exhausted, because the ceiling is about the day and the schedule is
 * about the session.
 */
function withinDailyLimit(session, settings, now) {
  const rolled = rollDay(session, now);
  return rolled.dayCostUsd < settings.dailyCostLimitUsd;
}

/**
 * Apply one successful keep-warm request to the session's counters.
 *
 * Returns the updated session and, when the ceiling it crossed is final, the
 * stop key the control shows.
 */
function applyWarmed(session, settings, result, now) {
  const rolled = rollDay(session, now);
  const cost = Number.isFinite(result?.usage?.costUsd) ? Math.max(0, result.usage.costUsd) : 0;
  const consecutive = rolled.consecutive + 1;
  const updated = {
    ...rolled,
    lastWarmAt: now,
    consecutive,
    dayCostUsd: rolled.dayCostUsd + cost,
    lastSkipReason: null,
  };
  const ratio = typeof result?.cacheReadRatio === "number" ? result.cacheReadRatio : 0;
  if (ratio < MIN_CACHE_READ_RATIO) {
    return { session: { ...updated, stopped: { key: "cacheMiss", at: now } }, stop: "cacheMiss" };
  }
  if (consecutive >= settings.maxConsecutive) {
    return { session: { ...updated, stopped: { key: "consecutive", at: now } }, stop: "consecutive" };
  }
  if (updated.dayCostUsd >= settings.dailyCostLimitUsd) {
    return { session: { ...updated, stopped: { key: "dailyLimit", at: now } }, stop: "dailyLimit" };
  }
  return { session: updated };
}

/**
 * Apply one host refusal.
 *
 * A busy session is the one refusal that is worth retrying: the cache is still
 * there and the user's turn is the reason it could not be refreshed. Everything
 * else either costs money to repeat (`requestFailed` is handled by the caller)
 * or cannot succeed until the session changes.
 */
function applySkipped(session, reason, now) {
  const rolled = rollDay(session, now);
  if (reason === "session_busy" || reason === "already_running") {
    return { session: { ...rolled, lastSkipReason: reason }, retryAt: now + BUSY_RETRY_MS };
  }
  if (PERMANENT_SKIP_REASONS.has(reason)) {
    return {
      session: { ...rolled, lastSkipReason: reason, stopped: { key: reason, at: now } },
      stop: reason,
    };
  }
  return { session: { ...rolled, lastSkipReason: reason, stopped: { key: reason, at: now } }, stop: reason };
}

/**
 * A real turn resets the streak and revives a session the schedule had stopped —
 * except for the one ceiling a turn cannot lift.
 *
 * A turn proves the conversation is alive again, so a cache-miss or
 * consecutive-request stop is over. It does not prove anything about the day's
 * spend: keeping `dailyLimit` until the local day rolls over is what makes the
 * ceiling a ceiling, since otherwise every message the user sent would buy one
 * more keep-warm request.
 */
function applyTurnEnded(session, now) {
  const rolled = rollDay(session, now);
  const stopped = rolled.stopped?.key === "dailyLimit" ? rolled.stopped : null;
  return {
    ...rolled,
    lastTurnEndedAt: now,
    consecutive: 0,
    stopped,
    lastSkipReason: stopped ? rolled.lastSkipReason : null,
  };
}

module.exports = {
  BUSY_RETRY_MS,
  DEFAULT_SETTINGS,
  MAX_INTERVAL_MINUTES,
  MIN_CACHE_READ_RATIO,
  MIN_INTERVAL_MINUTES,
  applyModelScope,
  applySkipped,
  applyTurnEnded,
  applyWarmed,
  dayKey,
  dueAt,
  modelAllowed,
  normalizeSession,
  normalizeSettings,
  rollDay,
  activeStop,
  shouldSchedule,
  withinDailyLimit,
};
