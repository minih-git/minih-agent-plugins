import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Stand-in for the plugin host globals `main.js` reaches for. */
function harness({ settings = {}, response } = {}) {
  const opened = [];
  const listeners = new Map();
  const calls = [];
  globalThis.pi = {
    plugin: { getSettings: async () => settings },
    net: {
      fetch: async (input) => {
        calls.push(input);
        if (typeof response === "function") return response(input);
        return response ?? { status: 200, headers: {}, bodyText: "{}" };
      },
    },
    shell: {
      openExternal: async (url) => {
        opened.push(url);
      },
    },
    events: {
      on: (name, handler) => listeners.set(name, handler),
    },
  };
  return { opened, listeners, calls };
}

function loadModule() {
  // Fresh module state per test: the status cache lives at module scope.
  delete require.cache[require.resolve("../main.js")];
  return require("../main.js");
}

const SESSION_OK = {
  status: 200,
  headers: {},
  bodyText: JSON.stringify({
    data: {
      authenticated: true,
      principal_type: "access_key",
      key_name: "laptop",
      key_prefix: "sk-1",
      key_suffix: "9f",
      status: "active",
    },
  }),
};

test("an unknown channel is refused instead of forwarded", async () => {
  harness();
  const mod = loadModule();
  await assert.rejects(() => mod.onPanelInvoke("router.delete", {}), /unknown router channel/);
});

test("status reports an unconfigured panel without touching the network", async () => {
  const { calls } = harness({ settings: { baseUrl: "", credential: "" } });
  const mod = loadModule();
  const status = await mod.onPanelInvoke("router.status", {});
  assert.equal(status.ok, false);
  assert.equal(status.code, "empty");
  assert.equal(calls.length, 0);
});

test("status asks the Router and returns the identity without the credential", async () => {
  const { calls } = harness({ settings: { baseUrl: "router.example.com", credential: "sk-secret" }, response: SESSION_OK });
  const mod = loadModule();
  const status = await mod.onPanelInvoke("router.status", {});
  assert.equal(status.ok, true);
  assert.equal(status.identity.admin, false);
  assert.equal(status.identity.keyHint, "sk-1…9f");
  assert.equal(calls[0].url, "https://router.example.com/api/auth/session");
  assert.ok(!JSON.stringify(status).includes("sk-secret"));
});

test("a changed setting drops the cached answer", async () => {
  const state = harness({ settings: { baseUrl: "router.example.com", credential: "k" }, response: SESSION_OK });
  const mod = loadModule();
  await mod.onLoad();
  await mod.onPanelInvoke("router.status", {});
  await mod.onPanelInvoke("router.status", {});
  assert.equal(state.calls.length, 1);
  // The listener the host fires after writing the settings sheet.
  state.listeners.get("plugin:settingsChanged")?.();
  await mod.onPanelInvoke("router.status", {});
  assert.equal(state.calls.length, 2);
});

test("open hands the browser the page the identity is allowed on", async () => {
  const { opened } = harness({ settings: { baseUrl: "router.example.com", credential: "k" }, response: SESSION_OK });
  const mod = loadModule();
  const result = await mod.onPanelInvoke("router.open", {});
  assert.deepEqual(opened, ["https://router.example.com/key-usage"]);
  assert.equal(result.admin, false);
});

test("open refuses to guess when the Router did not confirm the credential", async () => {
  const { opened } = harness({
    settings: { baseUrl: "router.example.com", credential: "k" },
    response: { status: 401, headers: {}, bodyText: "" },
  });
  const mod = loadModule();
  await assert.rejects(() => mod.onPanelInvoke("router.open", {}), /not available/);
  assert.deepEqual(opened, []);
});
