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
await writeFile(path.join(vault, "Note.md"), "---\ntitle: Note\ntype: topic\n---\n# Note\n");
process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
await writeFile(process.env.PERSONAL_KNOWLEDGE_CONFIG, JSON.stringify({ vaultPath: vault }));
const require = createRequire(import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function backend(t) {
  globalThis.pi = {};
  delete require.cache[require.resolve("../main.js")];
  const plugin = require("../main.js");
  t.after(() => plugin.onUnload());
  return plugin;
}

test("load returns before scanning; the first panel request shares background readiness", async (t) => {
  const plugin = backend(t);
  const original = VaultIndex.prototype.refresh;
  const entered = deferred();
  const release = deferred();
  const indexes = new Set();
  VaultIndex.prototype.refresh = async function (options) {
    indexes.add(this);
    entered.resolve();
    await release.promise;
    return original.call(this, options);
  };
  t.after(() => { VaultIndex.prototype.refresh = original; release.resolve(); });
  // A held scan makes this fail on the old implementation without waiting 15s.
  const loaded = plugin.onLoad();
  assert.equal(await Promise.race([loaded.then(() => "loaded"), entered.promise.then(() => "scan")]), "loaded");
  await entered.promise;
  assert.equal((await plugin.onPanelInvoke("kg.prefs.get", {})).available, false);
  const request = plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  release.resolve();
  const result = await request;
  assert.ok(JSON.stringify(result).includes("Note"));
  // The channel may refresh the existing index, but must never create another.
  assert.equal(indexes.size, 1);
});

test("unload aborts background scanning and a reload can initialize again", async (t) => {
  const plugin = backend(t);
  const original = VaultIndex.prototype.refresh;
  const entered = deferred();
  let aborted = false;
  VaultIndex.prototype.refresh = async function ({ signal }) {
    entered.resolve();
    assert.ok(signal);
    await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    signal.throwIfAborted();
  };
  t.after(() => { VaultIndex.prototype.refresh = original; });
  await plugin.onLoad();
  await entered.promise;
  await plugin.onUnload();
  assert.equal(aborted, true);
  VaultIndex.prototype.refresh = original;
  await plugin.onLoad();
  const result = await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  assert.ok(JSON.stringify(result).includes("Note"));
});

test("a failed background scan is logged and the next panel request retries", async (t) => {
  const plugin = backend(t);
  const original = VaultIndex.prototype.refresh;
  const originalError = console.error;
  const logged = deferred();
  console.error = (...args) => logged.resolve(args);
  VaultIndex.prototype.refresh = async () => { throw new Error("fixture scan failure"); };
  t.after(() => { VaultIndex.prototype.refresh = original; console.error = originalError; });
  await plugin.onLoad();
  const args = await logged.promise;
  assert.match(args[0], /background startup failed/);
  assert.match(args[1].message, /fixture scan failure/);
  VaultIndex.prototype.refresh = original;
  assert.ok(JSON.stringify(await plugin.onPanelInvoke("kg.note", { path: "Note.md" })).includes("Note"));
});

test("unload before the scheduled warm-up prevents scanning", async (t) => {
  const plugin = backend(t);
  const original = VaultIndex.prototype.refresh;
  let scanned = false;
  VaultIndex.prototype.refresh = async () => { scanned = true; };
  t.after(() => { VaultIndex.prototype.refresh = original; });
  await plugin.onLoad();
  await plugin.onUnload();
  await new Promise(setImmediate);
  assert.equal(scanned, false);
});


test("the real index stops an in-flight scan and can retry", async () => {
  const index = new VaultIndex({ root: vault });
  const controller = new AbortController();
  const pending = index.refresh({ force: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(index.notes.size, 0);
  await index.refresh({ force: true });
  assert.ok(index.note("Note.md"));
});
