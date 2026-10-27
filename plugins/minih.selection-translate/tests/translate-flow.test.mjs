import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MODULES = ["../main.js", "../lib/jobs.js", "../lib/models.js", "../lib/prompt.js", "../lib/errors.js"];

const models = [
  { key: "minimax/m2", label: "m2 (MiniMax)", isDefault: true },
  { key: "openai/gpt-5", label: "gpt-5 (OpenAI)", isDefault: false },
];

/**
 * A fresh plugin instance behind a stubbed host: the model list is cached for
 * 30s inside the module, so each test loads its own copy.
 */
async function plugin({ complete, listed = models, settings = {} } = {}) {
  const state = { settings: { ...settings }, completed: [], copied: [], writes: [] };
  globalThis.pi = {
    plugin: {
      getSettings: async () => ({ ...state.settings }),
      setSettings: async (partial) => {
        state.writes.push(partial);
        Object.assign(state.settings, partial);
      },
    },
    models: { list: async () => listed },
    agent: {
      complete: async (input) => {
        state.completed.push(input);
        return complete ? complete(input) : { text: "  你好，世界  " };
      },
    },
    clipboard: { writeText: async (text) => state.copied.push(text) },
  };
  for (const id of MODULES) delete require.cache[require.resolve(id)];
  const loaded = require("../main.js");
  await loaded.onLoad();
  return { call: loaded.onRendererCall, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a selection becomes one completion, and the poll answers it", async () => {
  const { call, state } = await plugin();
  const started = await call("translate", { text: "Thinking models answer in English." });

  // The call answers before the model does — that is the whole reason for the
  // job: a renderer call is cut off after 2s, a thinking model takes ten.
  assert.equal(started.ok, true);
  assert.equal(typeof started.jobId, "string");
  assert.equal(started.modelKey, "minimax/m2");
  assert.equal(started.note, "");

  await settle();
  const answer = await call("poll", { jobId: started.jobId });
  assert.equal(answer.ok, true);
  assert.equal(answer.state, "done");
  assert.equal(answer.text, "你好，世界");
  assert.equal(answer.modelLabel, "m2 (MiniMax)");

  assert.equal(state.completed.length, 1);
  assert.equal(state.completed[0].modelKey, "minimax/m2");
  assert.match(state.completed[0].system, /Simplified Chinese/);
  assert.ok(state.completed[0].messages[0].content.includes("Thinking models answer in English."));
  // Translation is transcription: the request must not ask for thinking, which
  // is what made a slow reasoning model look like a dead card.
  assert.equal(state.completed[0].thinkingLevel, "off");
});

test("the configured model is the one a request runs on", async () => {
  const { call, state } = await plugin({ settings: { model: "openai/gpt-5" } });
  const started = await call("translate", { text: "Hello there." });
  assert.equal(started.modelKey, "openai/gpt-5");
  await settle();
  assert.equal(state.completed[0].modelKey, "openai/gpt-5");
});

test("a configured model that is gone falls back and says so", async () => {
  const { call } = await plugin({ settings: { model: "gone/model" } });
  const started = await call("translate", { text: "Hello there." });
  assert.equal(started.ok, true);
  assert.equal(started.modelKey, "minimax/m2");
  assert.match(started.note, /配置的模型已不可用/);
});

test("nothing selected, no models, no answer: each is a readable refusal", async () => {
  const { call } = await plugin();
  const empty = await call("translate", { text: "   " });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "EMPTY");
  assert.match(empty.message, /没有可翻译的文字/);

  const none = await plugin({ listed: [] });
  const noModel = await none.call("translate", { text: "Hello there." });
  assert.equal(noModel.ok, false);
  assert.equal(noModel.code, "NO_MODEL");
});

test("a model failure reaches the card as a hint plus the host's own detail", async () => {
  const { call } = await plugin({
    complete: () => {
      throw Object.assign(new Error("plugin completion rate exceeded"), { code: "RATE_LIMITED" });
    },
  });
  const started = await call("translate", { text: "Hello there." });
  await settle();
  const answer = await call("poll", { jobId: started.jobId });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "RATE_LIMITED");
  assert.match(answer.message, /一分钟内的翻译次数太多/);
  assert.equal(answer.detail, "plugin completion rate exceeded");
});

test("an empty answer is a failure, not an empty card", async () => {
  const { call } = await plugin({ complete: () => ({ text: "  " }) });
  const started = await call("translate", { text: "Hello there." });
  await settle();
  const answer = await call("poll", { jobId: started.jobId });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "EMPTY_ANSWER");
});

test("cancelling drops the answer that arrives afterwards", async () => {
  let release;
  const { call, state } = await plugin({
    complete: () => new Promise((resolve) => (release = () => resolve({ text: "迟到的译文" }))),
  });
  const started = await call("translate", { text: "Hello there." });
  // While the model is still working the job answers "running": that is what
  // the card polls for, twice a second, instead of holding one call open.
  assert.equal((await call("poll", { jobId: started.jobId })).state, "running");
  assert.equal((await call("cancel", { jobId: started.jobId })).ok, true);
  release();
  await settle();
  assert.equal((await call("poll", { jobId: started.jobId })).state, "cancelled");
  assert.equal(state.completed.length, 1);
});

test("an unknown job is gone, not an exception", async () => {
  const { call } = await plugin();
  const answer = await call("poll", { jobId: "job-999" });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "UNKNOWN_JOB");
});

test("the dropdown answers the live list and the current choice", async () => {
  const { call } = await plugin({ settings: { model: "openai/gpt-5" } });
  const answer = await call("options", {});
  assert.equal(answer.ok, true);
  assert.equal(answer.configured, "openai/gpt-5");
  assert.equal(answer.resolved, "openai/gpt-5");
  assert.deepEqual(answer.options.map((option) => option.key), ["minimax/m2", "openai/gpt-5"]);
  assert.equal(answer.options[0].isDefault, true);
  assert.equal(answer.language, "zh-CN");
  assert.equal(answer.languages.length, 10);
});

test("choosing a model writes the setting; an unknown one is refused", async () => {
  const { call, state } = await plugin();
  assert.deepEqual(await call("setModel", { model: "openai/gpt-5" }), { ok: true, model: "openai/gpt-5" });
  assert.deepEqual(state.writes, [{ model: "openai/gpt-5" }]);

  const refused = await call("setModel", { model: "gone/model" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "UNKNOWN_MODEL");
  assert.equal(state.writes.length, 1);
});

test("copy goes to the host clipboard, and empty text is refused", async () => {
  const { call, state } = await plugin();
  assert.deepEqual(await call("copy", { text: "你好" }), { ok: true });
  assert.deepEqual(state.copied, ["你好"]);
  assert.equal((await call("copy", { text: "" })).code, "EMPTY");
});

test("the configured language is the one the model is asked for", async () => {
  const { call, state } = await plugin({ settings: { language: "ja" } });
  const started = await call("translate", { text: "Hello there." });
  assert.equal(started.target, "ja");
  assert.equal(started.targetLabel, "日本語");
  await settle();
  assert.match(state.completed[0].system, /into Japanese/);
});

test("an unknown language in the settings file falls back to Simplified Chinese", async () => {
  const { call, state } = await plugin({ settings: { language: "klingon" } });
  const started = await call("translate", { text: "Hello there." });
  assert.equal(started.target, "zh-CN");
  await settle();
  assert.match(state.completed[0].system, /Simplified Chinese/);
});

test("the card can switch the language, and the same setting is written", async () => {
  const { call, state } = await plugin();
  const options = await call("options", {});
  assert.equal(options.language, "zh-CN");
  assert.equal(options.languages.length, 10);
  assert.deepEqual(options.languages[0], { code: "zh-CN", label: "简体中文" });

  assert.deepEqual(await call("setLanguage", { language: "de" }), { ok: true, language: "de" });
  assert.deepEqual(state.writes, [{ language: "de" }]);

  const refused = await call("setLanguage", { language: "klingon" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "UNKNOWN_LANGUAGE");
  assert.equal(state.writes.length, 1);
});

test("an undeclared method throws instead of answering", async () => {
  const { call } = await plugin();
  await assert.rejects(() => call("openRecent", {}), (error) => error.code === "UNSUPPORTED");
});

test("unloading cancels everything in flight", async () => {
  const { call } = await plugin({
    complete: () => new Promise(() => {}),
  });
  const started = await call("translate", { text: "Hello there." });
  const loaded = require("../main.js");
  await loaded.onUnload();
  assert.equal((await call("poll", { jobId: started.jobId })).state, "cancelled");
});