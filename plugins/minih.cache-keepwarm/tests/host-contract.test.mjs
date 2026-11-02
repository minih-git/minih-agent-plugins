import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The host's own load sequence, copied from
 * `apps/desktop/electron/main/plugin-host-process.mjs` (`handleInit`):
 *
 *   globalThis.pi = buildApi();
 *   pluginModule = await loadPluginModule(entry);
 *   if (pluginModule?.onLoad) await pluginModule.onLoad();   // no argument
 *
 * 0.1.0 read that hook's parameter, so `host` stayed null in the real app: the
 * control showed "unavailable" and every renderer call answered "plugin is not
 * loaded", while the host had recorded a successful load. The rest of the suite
 * passed `pi` as an argument, which no host does — this file loads the plugin the
 * way the host does, so the failure cannot come back.
 */

const require = createRequire(import.meta.url);
const MAIN = require.resolve("../main.js");

function hostApi({ dataPath, keepWarm }) {
  const events = [];
  return {
    api: {
      app: { getLocale: async () => "zh-CN" },
      plugin: {
        getDataPath: async () => dataPath,
        getSettings: async () => ({}),
        setSettings: async () => undefined,
      },
      // `pi.events.on` returns `void` (SDK `PluginHostApi.events`), which is why
      // the plugin has to keep the handler itself to remove it later.
      events: {
        on: (event, handler) => {
          events.push({ kind: "on", event, handler });
        },
        off: (event, handler) => {
          events.push({ kind: "off", event, handler });
        },
      },
      session: { keepWarm },
    },
    events,
  };
}

function loadLikeHost(options) {
  const { api, events } = hostApi(options);
  globalThis.pi = api;
  delete require.cache[MAIN];
  const plugin = require(MAIN);
  return { plugin, events };
}

test("loads and answers the renderer when onLoad is called with no argument", async (t) => {
  const dataPath = mkdtempSync(join(tmpdir(), "kw-host-contract-"));
  const warmCalls = [];
  const { plugin, events } = loadLikeHost({
    dataPath,
    keepWarm: async ({ sessionId }) => {
      warmCalls.push(sessionId);
      return {
        status: "skipped",
        reason: "no_prior_request",
        model: { providerId: "router", modelId: "claude-sonnet-4-5" },
      };
    },
  });
  t.after(() => {
    rmSync(dataPath, { recursive: true, force: true });
    delete globalThis.pi;
    delete require.cache[MAIN];
  });

  await plugin.onLoad();

  const status = await plugin.onRendererCall("status", { sessionId: "s1" });
  assert.equal(status.enabled, false);
  assert.match(status.label, /缓存保活/);
  assert.ok(status.title, "the control needs a tooltip in the app language");

  const toggled = await plugin.onRendererCall("toggle", { sessionId: "s1", enabled: true });
  assert.equal(toggled.enabled, true);

  // `onUnload` awaits the pending write, so this is also the moment the switch
  // is really on disk rather than only in memory.
  await plugin.onUnload();
  const stateFile = join(dataPath, "sessions.json");
  assert.equal(existsSync(stateFile), true, "toggle must write sessions.json");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).sessions.s1.enabled, true);

  const on = events.filter((entry) => entry.kind === "on");
  const off = events.filter((entry) => entry.kind === "off");
  assert.deepEqual(on.map((entry) => entry.event), ["session:turnEnded"]);
  assert.equal(off.length, 1, "the listener registered at load must be removed");
  assert.equal(off[0].event, "session:turnEnded");
  assert.equal(off[0].handler, on[0].handler, "the exact handler must be removed");
  assert.deepEqual(warmCalls, [], "no request is sent without a real turn");
});

test("a load without the host API fails instead of pretending it worked", async (t) => {
  t.after(() => {
    delete globalThis.pi;
    delete require.cache[MAIN];
  });
  delete globalThis.pi;
  delete require.cache[MAIN];
  const plugin = require(MAIN);
  await assert.rejects(() => plugin.onLoad(), /host API is missing/);
});
