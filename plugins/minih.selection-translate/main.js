"use strict";

/**
 * Selection Translate — Minih-Agent-Desktop plugin entry (plugin process).
 *
 * What it adds: a pill under a text selection in the app window that turns that
 * selection into Simplified Chinese with the user's own model, and a card that
 * shows the translation next to it. The model is chosen in the plugin's
 * settings (or from the card, which writes the same setting).
 *
 * Why the work is a job and not one call:
 *   a `plugin.call` from the host renderer must answer within 2s
 *   (`RENDERER_CALL_TIMEOUT_MS` in the host's renderer relay), while one
 *   completion may take up to 90s (`PLUGIN_COMPLETE_TIMEOUT_MS`) and a thinking
 *   model regularly takes ten of them. So `translate` starts the completion and
 *   answers `{ jobId }`, and the card polls `poll` about twice a second
 *   (the relay allows 10 calls/s and opens a 30s cool-down after 5 consecutive
 *   failures, so polling never throws for an expected condition).
 *
 * What the card holds: `agent.complete` (`agent.complete` permission),
 * `models.list` for the dropdown, and the single writing path of this plugin —
 * `pi.plugin.setSettings({ model })`, the same setting the host's own settings
 * sheet edits. No file access, no network, no transcript writes: the selected
 * text is sent to the model and nothing is stored.
 */

const { describeFailure } = require("./lib/errors.js");
const { JobStore } = require("./lib/jobs.js");
const { isSelectableModel, modelOptions, resolveModel } = require("./lib/models.js");
const { DEFAULT_LANGUAGE, LANGUAGES, isLanguage, languageByCode } = require("./lib/languages.js");
const { buildTranslateRequest, normalizeText } = require("./lib/prompt.js");

/** The model list is asked once per half minute, not once per poll. */
const MODEL_CACHE_MS = 30_000;

let jobs = new JobStore();
let modelCache = { at: 0, models: [] };

async function readSettings() {
  try {
    return (await pi.plugin.getSettings()) ?? {};
  } catch {
    return {};
  }
}

async function listModels() {
  const now = Date.now();
  if (now - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  const models = await pi.models.list();
  modelCache = { at: now, models: Array.isArray(models) ? models : [] };
  return modelCache.models;
}

function labelOf(model) {
  return model?.alias?.trim() ? `${model.alias.trim()} · ${model.label}` : (model?.label ?? "");
}

/** Run one completion and settle the job; a cancelled job keeps its state. */
async function runCompletion(jobId, text, model, language) {
  const startedAt = Date.now();
  try {
    const { system, messages } = buildTranslateRequest(text, language);
    const result = await pi.agent.complete({
      modelKey: model.key,
      system,
      messages,
      // Translation is transcription, not reasoning: asking for thinking buys
      // nothing and costs the most time on exactly the slow models a reader
      // would otherwise wait on. The host clamps this to what the model
      // supports, so a model without an "off" level still answers on its
      // lowest one.
      thinkingLevel: "off",
    });
    const answer = typeof result?.text === "string" ? result.text.trim() : "";
    if (!answer) {
      jobs.settle(jobId, { state: "error", code: "EMPTY_ANSWER", ...describeFailure("EMPTY_ANSWER") });
      return;
    }
    jobs.settle(jobId, {
      state: "done",
      text: answer,
      modelKey: model.key,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "FAILED";
    jobs.settle(jobId, { state: "error", code, ...describeFailure(code, error) });
  }
}

/**
 * Start a translation. Answers `{ ok: true, jobId, modelLabel, note }` at once;
 * `note` reports a degraded choice (configured model gone) rather than failing.
 */
async function translate(args) {
  const normalized = normalizeText(args?.text);
  if (!normalized.text) return { ok: false, code: "EMPTY", ...describeFailure("EMPTY") };

  let models;
  try {
    models = await listModels();
  } catch (error) {
    return { ok: false, code: "MODELS_UNAVAILABLE", ...describeFailure("MODELS_UNAVAILABLE", error) };
  }
  const settings = await readSettings();
  const { model, note } = resolveModel(models, settings?.model);
  if (!model) return { ok: false, code: "NO_MODEL", ...describeFailure("NO_MODEL") };
  const language = languageByCode(settings?.language);

  const jobId = jobs.start({ modelKey: model.key, modelLabel: labelOf(model), target: language.code });
  // Deliberately not awaited: the renderer's call must answer inside 2s.
  void runCompletion(jobId, normalized.text, model, language.code);
  return {
    ok: true,
    jobId,
    modelKey: model.key,
    modelLabel: labelOf(model),
    target: language.code,
    targetLabel: language.label,
    note,
    truncated: normalized.truncated === true,
  };
}

/** The answer to one poll. `ok: false` means "this job will not finish". */
function poll(args) {
  const job = jobs.read(String(args?.jobId ?? ""));
  if (!job) return { ok: false, code: "UNKNOWN_JOB", ...describeFailure("UNKNOWN_JOB") };
  if (job.state === "running") return { ok: true, state: "running" };
  if (job.state === "cancelled") return { ok: true, state: "cancelled" };
  if (job.state === "error") {
    return { ok: false, code: job.code, message: job.message, detail: job.detail };
  }
  return {
    ok: true,
    state: "done",
    text: job.text,
    modelKey: job.modelKey,
    modelLabel: job.modelLabel,
    ms: job.ms,
  };
}

function cancel(args) {
  return { ok: jobs.cancel(String(args?.jobId ?? "")) };
}

/**
 * The two dropdowns: the live models with the configured key and what a request
 * would use, plus the languages with the configured one.
 */
async function options() {
  let models;
  try {
    models = await listModels();
  } catch (error) {
    return { ok: false, code: "MODELS_UNAVAILABLE", ...describeFailure("MODELS_UNAVAILABLE", error) };
  }
  const settings = await readSettings();
  const configured = typeof settings?.model === "string" ? settings.model.trim() : "";
  const { model, note } = resolveModel(models, configured);
  return {
    ok: true,
    options: modelOptions(models),
    configured,
    resolved: model?.key ?? null,
    resolvedLabel: labelOf(model),
    note,
    languages: LANGUAGES.map(({ code, label }) => ({ code, label })),
    language: languageByCode(settings?.language).code,
  };
}

async function setModel(args) {
  const key = typeof args?.model === "string" ? args.model.trim() : "";
  let models = null;
  try {
    models = await listModels();
  } catch {
    // Without a list the key cannot be checked; the next translation still
    // falls back to the host default, so refuse rather than store a guess.
    return { ok: false, code: "MODELS_UNAVAILABLE", ...describeFailure("MODELS_UNAVAILABLE") };
  }
  if (!isSelectableModel(models, key)) {
    return { ok: false, code: "UNKNOWN_MODEL", ...describeFailure("UNKNOWN_MODEL") };
  }
  await pi.plugin.setSettings({ model: key });
  return { ok: true, model: key };
}

/** The card's language dropdown writes the same key the settings sheet edits. */
async function setLanguage(args) {
  const code = typeof args?.language === "string" ? args.language.trim() : "";
  if (!isLanguage(code)) {
    return { ok: false, code: "UNKNOWN_LANGUAGE", ...describeFailure("UNKNOWN_LANGUAGE") };
  }
  await pi.plugin.setSettings({ language: code });
  return { ok: true, language: code };
}

async function copy(args) {
  const text = typeof args?.text === "string" ? args.text : "";
  if (!text) return { ok: false, code: "EMPTY", ...describeFailure("EMPTY") };
  await pi.clipboard.writeText(text);
  return { ok: true };
}

/** Every `manifest.rendererCallMethods` entry, and nothing else. */
const rendererMethods = { translate, poll, cancel, options, setModel, setLanguage, copy };

async function onRendererCall(method, args) {
  const handler = Object.prototype.hasOwnProperty.call(rendererMethods, method)
    ? rendererMethods[method]
    : null;
  if (!handler) {
    throw Object.assign(new Error(`unsupported renderer method: ${method}`), { code: "UNSUPPORTED" });
  }
  return handler(args);
}

async function onLoad() {
  jobs = new JobStore();
  modelCache = { at: 0, models: [] };
}

async function onUnload() {
  // A completion in flight outlives the unload only until it answers; marking
  // the jobs cancelled keeps that answer from ever reaching a card.
  jobs.cancelAll();
  modelCache = { at: 0, models: [] };
}

module.exports = { onLoad, onUnload, onRendererCall, rendererMethods };