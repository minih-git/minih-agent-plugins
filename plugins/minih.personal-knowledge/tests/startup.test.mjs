import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { VaultIndex } from "../lib/vault-index.mjs";
import { KnowledgeService } from "../mcp/knowledge-core.mjs";
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

test("retrying after a failed startup also recovers conversation sync", async (t) => {
  const plugin = backend(t);
  globalThis.pi = {
    conversations: { changes: async () => ({ enabled: false, items: [], nextCursor: null }) },
  };
  const original = VaultIndex.prototype.refresh;
  const originalError = console.error;
  const logged = deferred();
  console.error = () => logged.resolve();
  VaultIndex.prototype.refresh = async () => { throw new Error("temporary scan failure"); };
  t.after(() => { VaultIndex.prototype.refresh = original; console.error = originalError; });
  await plugin.onLoad();
  await logged.promise;
  VaultIndex.prototype.refresh = original;
  await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  const synced = await plugin.onPanelInvoke("kg.conversations.sync", {});
  assert.equal(synced.state, "disabled", "the recovered syncer reads the host archive switch");
});

test("manual conversation sync can retry a failed background startup", async (t) => {
  const plugin = backend(t);
  globalThis.pi = {
    conversations: { changes: async () => ({ enabled: false, items: [], nextCursor: null }) },
  };
  const original = VaultIndex.prototype.refresh;
  const originalError = console.error;
  const logged = deferred();
  console.error = () => logged.resolve();
  VaultIndex.prototype.refresh = async () => { throw new Error("temporary scan failure"); };
  t.after(() => { VaultIndex.prototype.refresh = original; console.error = originalError; });
  await plugin.onLoad();
  await logged.promise;
  VaultIndex.prototype.refresh = original;
  assert.equal((await plugin.onPanelInvoke("kg.conversations.sync", {})).state, "disabled");
});

test("concurrent settings requests reuse the startup index and service", async (t) => {
  const plugin = backend(t);
  const original = VaultIndex.prototype.refresh;
  const indexes = new Set();
  VaultIndex.prototype.refresh = async function (options) {
    indexes.add(this);
    return original.call(this, options);
  };
  t.after(() => { VaultIndex.prototype.refresh = original; });
  await plugin.onLoad();
  await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  const [config, status] = await Promise.all([
    plugin.onPanelInvoke("kg.config.get", {}),
    plugin.onPanelInvoke("kg.index.status", {}),
    plugin.onPanelInvoke("kg.routing.get", {}),
  ]);
  assert.ok(config);
  assert.equal(status.notes, 1);
  assert.equal(indexes.size, 1, "all settings channels use the already initialized index");
});

test("archive transcripts and daily notes stay excluded without user ignore rules", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(home, "archive-exclusion-"));
  await writeFile(path.join(root, "Note.md"), "# Note\n");
  for (const folder of ["_raw", "_daily"]) {
    const dir = path.join(root, "09 Conversations", folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "private.md"), "# Private archive\n");
  }
  const index = new VaultIndex({ root, config: { ignoreFolders: [] } });
  await index.refresh();
  assert.deepEqual(index.paths(), ["Note.md"]);
  const service = await new KnowledgeService({ vaultPath: root }).initialize();
  assert.deepEqual(service.index.paths(), ["Note.md"]);
});

test("a failed panel service initialization can retry using the ready index", async (t) => {
  const plugin = backend(t);
  const original = KnowledgeService.prototype.initialize;
  t.after(() => { KnowledgeService.prototype.initialize = original; });
  await plugin.onLoad();
  await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  KnowledgeService.prototype.initialize = async () => { throw new Error("temporary service failure"); };
  await assert.rejects(plugin.onPanelInvoke("kg.index.status", {}), /temporary service failure/);
  KnowledgeService.prototype.initialize = original;
  assert.equal((await plugin.onPanelInvoke("kg.index.status", {})).notes, 1);
});

test("unload drains panel service initialization without publishing a stale result", async (t) => {
  const plugin = backend(t);
  const original = KnowledgeService.prototype.initialize;
  const entered = deferred();
  const release = deferred();
  KnowledgeService.prototype.initialize = async function () {
    entered.resolve();
    await release.promise;
    return original.call(this);
  };
  t.after(() => { KnowledgeService.prototype.initialize = original; release.resolve(); });
  await plugin.onLoad();
  await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  const request = plugin.onPanelInvoke("kg.index.status", {});
  const rejected = assert.rejects(request, { name: "AbortError" });
  await entered.promise;
  const unloading = plugin.onUnload();
  release.resolve();
  await Promise.all([rejected, unloading]);
  KnowledgeService.prototype.initialize = original;
  await plugin.onLoad();
  await plugin.onPanelInvoke("kg.note", { path: "Note.md" });
  assert.equal((await plugin.onPanelInvoke("kg.index.status", {})).notes, 1);
});
