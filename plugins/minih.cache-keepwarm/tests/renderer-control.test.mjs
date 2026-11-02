import assert from "node:assert/strict";
import { test } from "node:test";

import { controlView, createReader } from "../renderer/control-state.mjs";

/**
 * What the composer control shows, driven without React: the component is only
 * the drawing, and these are the states a user actually hit in 0.1.0.
 */

const settle = async () => {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test("an unavailable plugin says so and names the reason in its tooltip", () => {
  const view = controlView({
    error: Object.assign(new Error("plugin is not loaded"), { code: "PLUGIN_CALL_FAILED" }),
    language: "zh-CN",
  });
  assert.equal(view.label, "不可用");
  assert.match(view.title, /PLUGIN_CALL_FAILED/);
  assert.match(view.title, /plugin is not loaded/);
  assert.equal(view.disabled, true);
  assert.equal(view.dataOn, false);

  const english = controlView({ error: new Error("boom"), language: "en-US" });
  assert.equal(english.label, "Unavailable");
  assert.equal(english.title, "boom");
});

test("the control recovers by itself once the plugin answers again", async () => {
  const views = [];
  const timers = [];
  let attempt = 0;
  const reader = createReader({
    call: async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error("plugin is not loaded"), { code: "PLUGIN_CALL_FAILED" });
      }
      return {
        label: "缓存保活 · 下次 15:20 · 今日 $0.09",
        title: "停止为这个会话保活 prompt 缓存",
        enabled: true,
        stopped: null,
      };
    },
    onChange: (change) => views.push(controlView({ ...change, language: "zh-CN" })),
    // Injected so the test advances the interval instead of waiting for it.
    setTimeout: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearTimeout: () => {},
  });

  reader.start();
  await settle();
  assert.equal(views.length, 1);
  assert.equal(views[0].label, "不可用");
  assert.match(views[0].title, /PLUGIN_CALL_FAILED/);
  assert.equal(timers.length, 1, "a failed read keeps polling");

  timers.shift()();
  await settle();
  assert.equal(views.length, 2);
  assert.equal(views[1].label, "缓存保活 · 下次 15:20 · 今日 $0.09");
  assert.equal(views[1].title, "停止为这个会话保活 prompt 缓存");
  assert.equal(views[1].dataOn, true);
  assert.equal(views[1].disabled, false);

  reader.stop();
  assert.equal(timers.length, 1, "stop leaves nothing scheduled behind");
});

test("a stopped schedule reads as stopped, and a plain model never claims one", () => {
  const stopped = controlView({
    status: { label: "已停止：达到今日上限", title: "为这个会话保活 prompt 缓存", enabled: true, stopped: "dailyLimit" },
    language: "zh-CN",
  });
  assert.equal(stopped.dataStopped, true);
  assert.equal(stopped.disabled, false);

  const idle = controlView({ status: null, language: "zh-CN" });
  assert.equal(idle.disabled, true);
  assert.equal(idle.dataStopped, false);
});
