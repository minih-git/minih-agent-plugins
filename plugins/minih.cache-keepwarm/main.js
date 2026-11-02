"use strict";

/**
 * Session cache keep-warm — Minih-Agent-Desktop plugin entry (plugin process).
 *
 * What this plugin adds: a switch in the composer that keeps one session's
 * provider prompt cache alive while the user is away. Every 50 minutes of
 * silence the host sends a request that replays the session's last prompt and
 * refreshes the cache; the conversation never shows it, and the user pays for
 * it, so everything about it is on screen: the next time, today's spend, and the
 * reason it stopped.
 *
 * Division of responsibility (desktop repo, ADR 0339):
 *
 *   - the host decides whether a request may be sent at all, and answers with a
 *     verdict — `warmed` plus what it cost, or `skipped` plus a reason. Nothing
 *     here can make a request happen that the host refused.
 *   - this file owns the schedule, the ceilings and the display. That is the
 *     code in `lib/keepwarm.js`, kept pure so it can be tested without a clock.
 *
 * The plugin declares no session-read permission: a session's model is named by
 * the host's own keep-warm answer, which is the only place a plugin may learn it
 * (see ADR 0339). The model scope is therefore enforced on the first answer
 * rather than before it.
 *
 * Persistence is one JSON file in the plugin's own data directory. It is small
 * on purpose: a flag, the last turn's end, the streak, today's spend and the
 * reason the schedule stopped. Nothing from the conversation is copied here.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const keepwarm = require("./lib/keepwarm");

const STATE_FILE = "sessions.json";
/** A timer that fires this late after its due time is treated as expired. */
const MAX_LATE_MS = 60 * 1000;

/** `pi` for the current load; the host hands a fresh one per load. */
let host = null;
let state = { sessions: {} };
/** sessionId -> { timer, dueAt } */
const timers = new Map();
let unsubscribers = [];
let locale = "en";
let writing = Promise.resolve();
/**
 * Whether this app version has the host API at all.
 *
 * `engines.minihAgent` tells an installer which versions can run this plugin,
 * but the host does not compare that range at load time, so the plugin checks
 * the one thing it actually needs: an older app has no `session.keepWarm`, and
 * the control then says so instead of looking broken.
 */
let hostSupportsKeepWarm = false;

const TEXT = {
  en: {
    off: "Keep warm",
    on: "Warming",
    toggleOn: "Keep this session's prompt cache warm",
    toggleOff: "Stop keeping this session's prompt cache warm",
    next: (time) => `next ${time}`,
    today: (cost) => `$${cost.toFixed(2)} today`,
    stoppedPrefix: "Stopped",
    reasons: {
      cacheMiss: "cache miss",
      consecutive: "4 in a row without a turn",
      dailyLimit: "daily limit reached",
      no_prior_request: "no request yet",
      model_changed: "model changed",
      prefix_changed: "prompt changed",
      prefix_expired: "cache expired",
      context_too_small: "context too small",
      protocol_unsupported: "protocol not supported",
      runtime_unavailable: "session unavailable",
      requestFailed: "request failed",
      appOutdated: "app version too old",
      outOfScope: "model not in scope",
      unsupported: "not available",
    },
  },
  "zh-CN": {
    off: "缓存保活",
    on: "保活中",
    toggleOn: "为这个会话保活 prompt 缓存",
    toggleOff: "停止为这个会话保活 prompt 缓存",
    next: (time) => `下次 ${time}`,
    today: (cost) => `今日 $${cost.toFixed(2)}`,
    stoppedPrefix: "已停止",
    reasons: {
      cacheMiss: "缓存未命中",
      consecutive: "连续 4 次无真实对话",
      dailyLimit: "达到今日上限",
      no_prior_request: "尚无真实请求",
      model_changed: "模型已更换",
      prefix_changed: "提示词已变化",
      prefix_expired: "缓存已过期",
      context_too_small: "上下文太短",
      protocol_unsupported: "协议不支持",
      runtime_unavailable: "会话不可用",
      requestFailed: "请求失败",
      appOutdated: "应用版本过旧",
      outOfScope: "模型不在范围内",
      unsupported: "不可用",
    },
  },
};

function text() {
  return TEXT[locale] ?? TEXT.en;
}

function reasonText(key) {
  return text().reasons[key] ?? key;
}

function formatTime(at) {
  try {
    return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(path.join(await host.plugin.getDataPath(), STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    state = { sessions: parsed && typeof parsed.sessions === "object" ? parsed.sessions : {} };
  } catch {
    state = { sessions: {} };
  }
}

function persist() {
  // One writer at a time: two overlapping writes of a whole-file JSON would let
  // the older snapshot win.
  writing = writing.then(async () => {
    const file = path.join(await host.plugin.getDataPath(), STATE_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }).catch(() => undefined);
  return writing;
}

function session(id) {
  return keepwarm.normalizeSession(state.sessions[id]);
}

// A daily stop expires with its day; `schedule` reads through this so a session
// does not stay silent until the user happens to talk again.
const desktop = {
  rolledSession(id) {
    const current = session(id);
    if (current.stopped && !keepwarm.activeStop(current, Date.now())) {
      return update(id, { ...current, stopped: null, lastSkipReason: null });
    }
    return current;
  },
};

function update(id, next) {
  state.sessions[id] = next;
  void persist();
  return next;
}

function clearTimer(id) {
  const entry = timers.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  timers.delete(id);
}

/**
 * Arm (or re-arm) this session's timer.
 *
 * The delay is computed from the stored timestamps, not from "now plus an
 * interval": after a sleep, a restart or a disabled-then-enabled plugin the
 * schedule has to land on the same wall-clock moment the user was promised.
 */
function schedule(id, settings) {
  clearTimer(id);
  const current = desktop.rolledSession(id);
  if (!current.enabled) {
    notifyRenderer(id);
    return;
  }
  if (keepwarm.activeStop(current, Date.now())) {
    notifyRenderer(id);
    return;
  }
  // A model the user excluded is a stop, not a silence: a real turn revives the
  // schedule, and without a recorded reason the control would promise a next
  // time that never comes.
  if (!keepwarm.modelAllowed(settings.modelScope, current.lastModelId)) {
    update(id, {
      ...current,
      lastSkipReason: "outOfScope",
      stopped: { key: "outOfScope", at: Date.now() },
    });
    notifyRenderer(id);
    return;
  }
  if (!keepwarm.shouldSchedule(current, settings, Date.now(), current.lastModelId)) {
    notifyRenderer(id);
    return;
  }
  const due = keepwarm.dueAt(current, settings);
  const delay = Math.max(0, due - Date.now());
  const timer = setTimeout(() => {
    timers.delete(id);
    void runRequest(id, settings);
  }, delay);
  // A plugin timer must never hold the app open.
  if (typeof timer.unref === "function") timer.unref();
  timers.set(id, { timer, dueAt: due });
  notifyRenderer(id);
}

/**
 * One scheduled tick.
 *
 * The wall clock decides, not the timer: a laptop that slept through the due
 * time wakes with a timer that fires late, and a request sent an hour and a half
 * after the last turn would buy a fresh cache write rather than refresh one. The
 * host refuses that case with `prefix_expired`; checking here keeps the plugin
 * from asking at all when the moment has clearly passed.
 */
async function runRequest(id, settings) {
  if (!hostSupportsKeepWarm) return;
  const current = session(id);
  if (!current.enabled || keepwarm.activeStop(current, Date.now())) return;
  // The day's ceiling is checked at the moment of spending, whatever brought the
  // session back to life: a real turn resets the streak, never the day's bill.
  if (!keepwarm.withinDailyLimit(current, settings, Date.now())) {
    update(id, {
      ...keepwarm.rollDay(current, Date.now()),
      lastSkipReason: "dailyLimit",
      stopped: { key: "dailyLimit", at: Date.now() },
    });
    notifyRenderer(id);
    return;
  }
  const due = keepwarm.dueAt(current, settings);
  if (Date.now() - due > MAX_LATE_MS) {
    // Still worth asking: the host's own lifetime guard is the authority. This
    // is only the case where the timer fired long after its moment.
    update(id, { ...current, lastSkipReason: "prefix_expired", stopped: { key: "prefix_expired", at: Date.now() } });
    notifyRenderer(id);
    return;
  }
  let result;
  try {
    result = await host.session.keepWarm({ sessionId: id });
  } catch (error) {
    update(id, {
      ...session(id),
      lastSkipReason: "requestFailed",
      stopped: { key: "requestFailed", at: Date.now(), detail: String(error?.code ?? error?.message ?? error) },
    });
    notifyRenderer(id);
    return;
  }
  const now = Date.now();
  // The host names the model on every answer, refusals included, so the scope
  // costs nothing to enforce: one answer is enough to stop.
  const scoped = keepwarm.applyModelScope(
    session(id),
    settings,
    typeof result?.model?.modelId === "string" ? result.model.modelId : "",
    now,
  );
  if (scoped.stop) {
    update(id, scoped.session);
    notifyRenderer(id);
    return;
  }
  if (result?.status === "warmed") {
    const applied = keepwarm.applyWarmed(session(id), settings, result, now);
    update(id, applied.session);
    if (!applied.stop) schedule(id, settings);
    else notifyRenderer(id);
    return;
  }
  if (result?.status === "skipped") {
    const applied = keepwarm.applySkipped(session(id), String(result.reason ?? "unsupported"), now);
    update(id, applied.session);
    if (applied.retryAt) {
      const timer = setTimeout(() => {
        timers.delete(id);
        void runRequest(id, settings);
      }, Math.max(0, applied.retryAt - Date.now()));
      if (typeof timer.unref === "function") timer.unref();
      timers.set(id, { timer, dueAt: applied.retryAt });
    }
    notifyRenderer(id);
    return;
  }
  // A failed request costs money for no answer: stop rather than retry it.
  update(id, {
    ...session(id),
    lastSkipReason: "requestFailed",
    stopped: { key: "requestFailed", at: now, detail: String(result?.reason ?? "provider_error") },
  });
  notifyRenderer(id);
}

function statusOf(id) {
  const current = desktop.rolledSession(id);
  const settings = keepwarm.normalizeSettings(settingsCache);
  const due = keepwarm.dueAt(current, settings);
  const entry = timers.get(id);
  return {
    sessionId: id,
    enabled: current.enabled,
    stopped: current.stopped ? current.stopped.key : null,
    label: labelOf(current, settings, entry ? entry.dueAt : due),
  };
}

function labelOf(current, settings, due) {
  if (!hostSupportsKeepWarm) {
    return `${text().stoppedPrefix}：${reasonText("appOutdated")}`;
  }
  if (keepwarm.activeStop(current, Date.now())) {
    return `${text().stoppedPrefix}：${reasonText(current.stopped.key)}`;
  }
  if (!current.enabled) return text().off;
  const parts = [text().on];
  if (Number.isFinite(due)) parts.push(text().next(formatTime(due)));
  if (current.dayCostUsd > 0) parts.push(text().today(current.dayCostUsd));
  return parts.join(" · ");
}

function notifyRenderer(id) {
  // The composer control polls `status`; pushing is not part of the slot
  // contract, so nothing is broadcast here.
  void id;
}

async function startSession(id, settings) {
  clearTimer(id);
  if (!session(id).enabled) return;
  schedule(id, settings);
}

let settingsCache = {};

async function readSettings() {
  settingsCache = await host.plugin.getSettings();
  return keepwarm.normalizeSettings(settingsCache);
}

/** Text in the language the app runs in, refreshed on every read. */
async function refreshLocale() {
  try {
    const value = await host.app.getLocale();
    locale = typeof value === "string" && value.startsWith("zh") ? "zh-CN" : "en";
  } catch {
    locale = "en";
  }
}

async function onLoad(pi) {
  host = pi;
  hostSupportsKeepWarm = typeof pi?.session?.keepWarm === "function";
  await refreshLocale();
  await loadState();
  if (!hostSupportsKeepWarm) {
    // Nothing can be scheduled, and arming a timer would only produce one failed
    // call per session. The control reports the version instead.
    return;
  }
  const settings = await readSettings();
  unsubscribers = [
    pi.events.on("session:turnEnded", (payload) => {
      const id = String(payload?.sessionId ?? "");
      if (!id) return;
      void (async () => {
        const current = session(id);
        update(id, keepwarm.applyTurnEnded(current, Date.now()));
        if (current.enabled) schedule(id, keepwarm.normalizeSettings(settingsCache));
      })();
    }),
  ];
  for (const id of Object.keys(state.sessions)) {
    if (session(id).enabled) await startSession(id, settings);
  }
}

async function onUnload() {
  for (const unsubscribe of unsubscribers) {
    try {
      await unsubscribe();
    } catch {
      // A subscription that is already gone needs no cleanup.
    }
  }
  unsubscribers = [];
  for (const id of [...timers.keys()]) clearTimer(id);
  await writing;
  host = null;
}

/**
 * One call from the composer control.
 *
 * `status` is read-only and idempotent, which is why the control can poll it;
 * `toggle` is the user's own decision and is the only thing that persists an
 * enabled flag.
 */
async function onRendererCall(method, args) {
  if (!host) throw new Error("plugin is not loaded");
  await refreshLocale();
  const settings = await readSettings();
  const id = String(args?.sessionId ?? "").trim();
  if (!id) throw new Error("sessionId required");
  if (method === "status") {
    // The control's poll is also what re-arms a session whose daily stop just
    // expired: nothing else wakes a schedule with no timer left in it.
    const current = desktop.rolledSession(id);
    if (current.enabled && !timers.has(id)) await startSession(id, settings);
    return statusOf(id);
  }
  if (method === "toggle") {
    if (!hostSupportsKeepWarm) return statusOf(id);
    const current = session(id);
    const enabled = args?.enabled === undefined ? !current.enabled : args.enabled === true;
    if (!enabled) {
      clearTimer(id);
      update(id, {
        ...current,
        enabled: false,
        consecutive: 0,
        stopped: null,
        lastSkipReason: null,
      });
      return statusOf(id);
    }
    update(id, {
      ...current,
      enabled: true,
      stopped: null,
      lastSkipReason: null,
      consecutive: 0,
      lastTurnEndedAt: current.lastTurnEndedAt || Date.now(),
    });
    await startSession(id, settings);
    return statusOf(id);
  }
  throw new Error(`unknown method: ${method}`);
}

module.exports = { onLoad, onUnload, onRendererCall };
