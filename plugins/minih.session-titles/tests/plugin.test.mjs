import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { createTitlePlugin } = require("../main.js");
const { buildRequest, normalizeTitle } = require("../lib/prompt.js");

function fixture() {
  const handlers = new Map(), requests = [], writes = [];
  let title = "Fix login", source = "default", settings = { model: "other/title", enabled: true };
  let complete = async () => ({ text: "Title: 修复登录。" });
  const host = {
    plugin: { getSettings: async () => ({ ...settings }) },
    events: { on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) },
    models: { list: async () => [{ key: "session/chat", isDefault: true }, { key: "other/title", thinkingLevels: ["low"] }] },
    session: {
      getAutoTitleContext: async input => source === "manual" || (source === "generated" && !input.summaryFingerprint) ? null : {
        sessionId: input.sessionId, expectedTitle: title, userPrompt: "帮我修复登录", modelKey: "session/chat",
        ...(input.summaryFingerprint ? { summary: "Now fixing logout", summaryFingerprint: input.summaryFingerprint } : {}),
      },
      setAutoTitle: async input => {
        writes.push(input);
        if (source === "manual" || title !== input.expectedTitle) return { updated: false };
        title = input.title; source = "generated"; return { updated: true };
      },
    },
    agent: { complete: async input => { requests.push(input); return complete(input); } },
  };
  const plugin = createTitlePlugin(host); plugin.onLoad();
  return {
    plugin, requests, writes, handlers,
    emit: (name, data = {}) => handlers.get(name)?.({ sessionId: "s1", ...data }),
    setSettings: patch => { settings = { ...settings, ...patch }; },
    setComplete: fn => { complete = fn; },
    manual: () => { title = "My title"; source = "manual"; },
    get title() { return title; },
  };
}
const deferred = () => Promise.withResolvers();

test("first prompt generates one localized title using the configured model", async () => {
  const f = fixture();
  await f.emit("session:promptSent");
  assert.equal(f.title, "修复登录");
  assert.equal(f.requests[0].modelKey, "other/title");
  assert.equal(f.requests[0].includeSessionContext, false);
  assert.match(f.requests[0].messages[0].content, /Han script/);
  await f.emit("session:turnEnded"); await f.emit("session:promptSent");
  assert.equal(f.requests.length, 1);
  f.plugin.onUnload();
});

test("model settings are read per job; explicit unavailable models never fall back", async () => {
  const f = fixture(); f.setSettings({ model: "missing/model" });
  await f.emit("session:promptSent"); assert.equal(f.requests.length, 0);
  f.setSettings({ model: "" }); await f.emit("session:turnEnded");
  assert.equal(f.requests[0].modelKey, "session/chat");
});

test("turn-end retry waits for a failing send-time request and retries", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.setComplete(async () => { entered.resolve(); return gate.promise; });
  const sending = f.emit("session:promptSent"); await entered.promise;
  const retry = f.emit("session:turnEnded");
  f.setComplete(async () => ({ text: "Recovered title" })); gate.reject(Object.assign(new Error("failed"), { code: "TEST_ERROR" }));
  await sending; await retry;
  assert.equal(f.requests.length, 2); assert.equal(f.title, "Recovered title");
});

test("duplicate events serialize; successful send never spends a retry", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.setComplete(async () => { entered.resolve(); return gate.promise; });
  const first = f.emit("session:promptSent"); await entered.promise;
  const second = f.emit("session:promptSent"), ended = f.emit("session:turnEnded");
  gate.resolve({ text: "One title" }); await Promise.all([first, second, ended]);
  assert.equal(f.requests.length, 1);
});

test("failed first-title completions are bounded and a changed model permits recovery", async () => {
  const f = fixture(); f.setComplete(async () => { throw Object.assign(new Error("failed"), { code: "TEST_ERROR" }); });
  for (let i = 0; i < 8; i++) await f.emit("session:turnEnded");
  assert.equal(f.requests.length, 3); assert.equal(f.title, "Fix login");
  f.setSettings({ model: "session/chat" }); f.setComplete(async () => ({ text: "Recovered" }));
  await f.emit("session:turnEnded"); assert.equal(f.title, "Recovered");
});

test("manual rename wins while the model is running", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.setComplete(async () => { entered.resolve(); return gate.promise; });
  const job = f.emit("session:promptSent"); await entered.promise; f.manual();
  gate.resolve({ text: "Overwritten" }); await job;
  assert.equal(f.title, "My title");
});

test("unload removes listeners and discards late completions across reload", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.setComplete(async () => { entered.resolve(); return gate.promise; });
  const job = f.emit("session:promptSent"); await entered.promise;
  f.plugin.onUnload(); assert.equal(f.handlers.size, 0); f.plugin.onLoad();
  gate.resolve({ text: "Late title" }); await job;
  assert.equal(f.writes.length, 0);
});

test("switching off generation while a request runs prevents a late write", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.setComplete(async () => { entered.resolve(); return gate.promise; });
  const job = f.emit("session:promptSent"); await entered.promise; f.setSettings({ enabled: false });
  gate.resolve({ text: "Late title" }); await job; assert.equal(f.writes.length, 0);
});

test("compaction refresh serializes and deduplicates; manual titles stay untouched", async () => {
  const f = fixture(); await f.emit("session:promptSent");
  f.setComplete(async () => ({ text: "Logout work" }));
  await f.emit("session:compacted", { summaryFingerprint: "fp1" });
  assert.equal(f.title, "Logout work"); assert.equal(f.writes.at(-1).summaryFingerprint, "fp1");
  await f.emit("session:compacted", { summaryFingerprint: "fp1" }); assert.equal(f.requests.length, 2);
  f.manual(); await f.emit("session:compacted", { summaryFingerprint: "fp2" }); assert.equal(f.title, "My title");
});

test("disabled generation, disabled refresh and native sessions spend no model calls", async () => {
  const f = fixture(); f.setSettings({ enabled: false }); await f.emit("session:promptSent");
  f.setSettings({ enabled: true, retitleAfterCompaction: false }); await f.emit("session:compacted", { summaryFingerprint: "fp1" });
  await f.emit("session:promptSent", { sessionId: "native-pi:a" }); assert.equal(f.requests.length, 0);
});

test("bounded material, reference-only prompts, reasoning and title normalization", () => {
  const model = { key: "a/b", thinkingLevels: ["low"] };
  const request = buildRequest({ userPrompt: "", pastedMaterial: "中".repeat(5000), referencedFiles: ["login.ts"] }, model, "high");
  assert.equal(request.thinkingLevel, "off");
  assert.ok(!request.messages[0].content.includes("中".repeat(3001)));
  assert.match(buildRequest({ userPrompt: "", referencedFiles: ["login.ts"] }, model, "low").messages[0].content, /login.ts/);
  assert.equal(Array.from(normalizeTitle("界".repeat(90))).length, 80);
  assert.equal(normalizeTitle("Title: “Hello”"), "Hello");
  assert.equal(normalizeTitle(""), "");
});
