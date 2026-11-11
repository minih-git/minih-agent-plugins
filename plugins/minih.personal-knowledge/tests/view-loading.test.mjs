import assert from "node:assert/strict";
import { test } from "node:test";
import { createVaultWaiter } from "../view/vault-loading.mjs";

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function makeWindow(invoke) {
  const target = new EventTarget();
  target.pluginBridge = { invoke };
  globalThis.window = target;
  return target;
}
let moduleSequence = 0;
const bridge = () => import(new URL(`../view/bridge.js?test=${++moduleSequence}`, import.meta.url));

test("concurrent view requests share real readiness for more than thirty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let ready = false;
  const win = makeWindow(async (channel, payload) => {
    calls.push({ channel, payload });
    return channel === "kg.status" ? { state: ready ? "ready" : "loading", completed: 1, total: 2 }
      : channel === "kg.config.get" ? { path: "real-config" } : { real: true };
  });
  const { invokeBridge } = await bridge();
  const first = invokeBridge("kg.graph");
  const second = invokeBridge("kg.index.status");
  let completed = false;
  first.then(() => { completed = true; });
  await flush();
  assert.deepEqual(await invokeBridge("kg.config.get"), { path: "real-config" });
  for (let turn = 0; turn < 45; turn += 1) { t.mock.timers.tick(750); await flush(); }
  assert.equal(completed, false);
  assert.equal(calls.filter((call) => call.channel === "kg.status").length, 46, "one shared poll per interval");
  assert.equal(calls.some((call) => call.channel === "kg.graph"), false);
  assert.deepEqual(calls[0].payload, { retry: true, refresh: true });
  assert.deepEqual(calls[2].payload, { retry: false, refresh: false });
  ready = true;
  t.mock.timers.tick(750); await flush();
  assert.deepEqual(await Promise.all([first, second]), [{ real: true }, { real: true }]);
  win.dispatchEvent(new Event("pagehide"));
});

test("a real readiness error propagates and an explicit second attempt can recover", async () => {
  let fail = true;
  let graphCalls = 0;
  const win = makeWindow(async (channel) => {
    if (channel === "kg.status") return fail ? { state: "error", error: { code: "EACCES", message: "Permission denied reading notes" } } : { state: "ready" };
    graphCalls += 1;
    return { nodes: [{ id: "actual-note" }] };
  });
  const { invokeBridge, hasBridge } = await bridge();
  await assert.rejects(invokeBridge("kg.graph"), { code: "EACCES" });
  assert.equal(graphCalls, 0);
  fail = false;
  assert.equal((await invokeBridge("kg.graph")).nodes[0].id, "actual-note");
  delete win.pluginBridge;
  assert.equal(hasBridge(), true, "disconnection does not turn an installed page into a demo");
  await assert.rejects(invokeBridge("kg.graph"), { code: "BRIDGE_MISSING" });
  win.dispatchEvent(new Event("pagehide"));
});

test("page disposal cancels an outstanding status RPC and ignores its late result", async () => {
  let release;
  const updates = [];
  const win = makeWindow(() => new Promise((resolve) => { release = resolve; }));
  win.addEventListener("kg:loading", (event) => updates.push(event.detail));
  const { invokeBridge } = await bridge();
  const pending = invokeBridge("kg.graph");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await flush();
  win.dispatchEvent(new Event("pagehide"));
  await rejected;
  const count = updates.length;
  release({ state: "ready" });
  await flush();
  assert.equal(updates.length, count);
});

test("actual bridge operations still retain their own timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const win = makeWindow((channel) => channel === "kg.status" ? Promise.resolve({ state: "ready" }) : new Promise(() => {}));
  const { invokeBridge } = await bridge();
  const rejected = assert.rejects(invokeBridge("kg.graph", {}, 50), { code: "BRIDGE_TIMEOUT" });
  await flush();t.mock.timers.tick(50);await flush();
  await rejected;
  win.dispatchEvent(new Event("pagehide"));
});

test("disposing the shared readiness wait clears a scheduled poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [];
  const waiter = createVaultWaiter({ request: async () => ({ state: "loading" }), onStatus: (status) => statuses.push(status) });
  const pending = waiter.wait();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await flush();waiter.dispose();await rejected;
  const count = statuses.length;t.mock.timers.tick(60000);await flush();
  assert.equal(statuses.length, count);
});
