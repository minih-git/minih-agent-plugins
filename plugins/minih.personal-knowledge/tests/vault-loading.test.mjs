import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { VaultIndex } from "../lib/vault-index.mjs";
import { isolatedHome } from "./helpers/home.mjs";

const home = await isolatedHome();
const vault = path.join(home, "Knowledge");
await mkdir(vault);
await writeFile(path.join(vault, "Note.md"), "---\ntitle: Real note\ntype: topic\n---\n# Real note\n");
await writeFile(process.env.PERSONAL_KNOWLEDGE_CONFIG, JSON.stringify({ vaultPath: vault }));
process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
const require = createRequire(import.meta.url);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}
function backend() {
  globalThis.pi = {};
  delete require.cache[require.resolve("../main.js")];
  return require("../main.js");
}

test("status and configuration answer while the actual vault scan is held", async () => {
  const original = VaultIndex.prototype.refresh;
  const release = deferred();
  const entered = deferred();
  VaultIndex.prototype.refresh = async function (options = {}) {
    options.onProgress?.({ phase: "read", completed: 2, total: 20 });
    entered.resolve();
    await release.promise;
    return original.call(this, options);
  };
  const plugin = backend();
  try {
    await plugin.onLoad();
    await entered.promise;
    const loading = await plugin.onPanelInvoke("kg.status", {});
    assert.equal(loading.state, "loading");
    assert.equal(loading.completed, 2);
    assert.equal(loading.total, 20);
    const config = await plugin.onPanelInvoke("kg.config.get", {});
    assert.equal(config.values.vaultPath, vault);
    assert.equal(config.vault.notes, null);
    release.resolve();
    await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
    assert.equal((await plugin.onPanelInvoke("kg.status", {})).state, "ready");
  } finally {
    release.resolve();
    await plugin.onUnload();
    VaultIndex.prototype.refresh = original;
  }
});

test("a status failure stays visible until an explicit retry and then recovers", async () => {
  const original = VaultIndex.prototype.refresh;
  const originalError = console.error;
  const failed = deferred();
  VaultIndex.prototype.refresh = async () => { throw Object.assign(new Error("vault read refused"), { code: "EACCES" }); };
  console.error = () => failed.resolve();
  const plugin = backend();
  try {
    await plugin.onLoad();
    await failed.promise;
    const error = await plugin.onPanelInvoke("kg.status", {});
    assert.equal(error.state, "error");
    assert.equal(error.error.code, "EACCES");
    assert.match(error.error.message, /vault read refused/);
    VaultIndex.prototype.refresh = original;
    assert.equal((await plugin.onPanelInvoke("kg.status", {})).state, "error");
    await plugin.onPanelInvoke("kg.status", { retry: true });
    await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
    assert.equal((await plugin.onPanelInvoke("kg.status", {})).state, "ready");
  } finally {
    await plugin.onUnload();
    VaultIndex.prototype.refresh = original;
    console.error = originalError;
  }
});

test("status tracks a later refresh without opening a long graph request", async () => {
  const plugin = backend();
  const original = VaultIndex.prototype.refresh;
  const release = deferred();
  const entered = deferred();
  try {
    await plugin.onLoad();
    await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
    VaultIndex.prototype.refresh = async function (options = {}) {
      options.onProgress?.({ phase: "read", completed: 1, total: 3 });
      entered.resolve();
      await release.promise;
      return original.call(this, options);
    };
    await plugin.onPanelInvoke("kg.status", { refresh: true });
    await entered.promise;
    const status = await plugin.onPanelInvoke("kg.status", {});
    assert.equal(status.state, "loading");
    assert.equal(status.total, 3);
    VaultIndex.prototype.refresh = original;
    release.resolve();
    await plugin.onUnload();
    await plugin.onLoad();
    const graph = await plugin.onPanelInvoke("kg.graph", {});
    assert.ok(graph.nodes.some((node) => node.title === "Real note"));
  } finally {
    release.resolve();
    VaultIndex.prototype.refresh = original;
    await plugin.onUnload();
  }
});

test("graph memory preparation also stays outside a timed bridge request", async () => {
  const plugin = backend();
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  globalThis.pi = { memory: { list: async () => {
    reads += 1;
    entered.resolve();
    await release.promise;
    return { readEnabled: true, entries: [], nextOffset: null };
  } } };
  try {
    await plugin.onLoad();
    await plugin.onPanelInvoke("kg.status", { refresh: true });
    await entered.promise;
    const pending = await plugin.onPanelInvoke("kg.status", {});
    assert.equal(pending.state, "loading");
    assert.equal(pending.phase, "services");
    release.resolve();
    let ready;
    for (let turn = 0; turn < 10; turn += 1) {
      ready = await plugin.onPanelInvoke("kg.status", {});
      if (ready.state === "ready") break;
      await new Promise(setImmediate);
    }
    assert.equal(ready.state, "ready");
    const graph = await plugin.onPanelInvoke("kg.graph", { includeMemory: true });
    assert.equal(graph.memory.status, "ok");
    assert.equal(reads, 1, "the timed graph request reuses its prepared memory");
  } finally {
    release.resolve();
    await plugin.onUnload();
  }
});
