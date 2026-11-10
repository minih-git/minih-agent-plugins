import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPrefsStore } from "../lib/panel.mjs";
import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

/**
 * Regression cover for `pi.plugin.getDataPath`, which the host declares as
 * `() => Promise<string>`. Treating that promise as a path reached
 * `path.join(dataPath, ...)` and failed every panel channel with
 * "The \"path\" argument must be of type string. Received an instance of Promise".
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = (await import("node:module")).createRequire(import.meta.url);

async function makeBackend({ getDataPath } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-datapath-"));
  const vault = path.join(root, "Knowledge");
  const dataPath = path.join(root, "data");
  await mkdir(vault, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  await writeFile(path.join(vault, "Note.md"), "---\ntitle: Note\ntype: topic\n---\n# Note\n");
  const configPath = path.join(root, "repo-map.json");
  await writeFile(configPath, JSON.stringify({ vaultPath: vault, ignoreFolders: [], backupRetentionDays: 0 }));
  process.env.PERSONAL_KNOWLEDGE_CONFIG = configPath;
  process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
  delete process.env.PERSONAL_KNOWLEDGE_READ_ONLY;

  const calls = { getDataPath: 0 };
  globalThis.pi = {
    plugin: {
      getDataPath:
        getDataPath ??
        (async () => {
          calls.getDataPath += 1;
          // A tick of delay so two concurrent channels really overlap.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return dataPath;
        }),
    },
  };
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PLUGIN_ROOT)) delete require.cache[key];
  }
  const backend = require(path.join(PLUGIN_ROOT, "main.js"));
  await backend.onLoad();
  return { backend, vault, dataPath, root, calls };
}

test("an async getDataPath no longer breaks the panel channels", async () => {
  const { backend, dataPath } = await makeBackend();

  // The exact channel sequence the panel issues on open.
  await backend.onPanelInvoke("kg.prefs.get", {});
  await backend.onPanelInvoke("kg.config.get", {});
  await backend.onPanelInvoke("kg.conversations.status", {});
  await backend.onPanelInvoke("kg.profile.status", {});
  await backend.onPanelInvoke("kg.index.status", {});
  await backend.onPanelInvoke("kg.memory.status", {});

  const saved = await backend.onPanelInvoke("kg.prefs.set", { language: "en" });
  assert.equal(saved.saved, true);
  const stored = JSON.parse(await readFile(path.join(dataPath, "view-prefs.json"), "utf8"));
  assert.equal(stored.language, "en", "view-prefs.json lands in the host data path");
  assert.equal((await backend.onPanelInvoke("kg.prefs.get", {})).language, "en");

  await backend.onUnload();
});

test("concurrent channels build the panel stores once", async () => {
  const { backend, calls } = await makeBackend();
  await Promise.all([
    backend.onPanelInvoke("kg.prefs.get", {}),
    backend.onPanelInvoke("kg.conversations.status", {}),
    backend.onPanelInvoke("kg.profile.status", {}),
    backend.onPanelInvoke("kg.prefs.set", { language: "zh-CN" }),
    backend.onPanelInvoke("kg.conversations.device", { deviceName: "mac-a" }),
  ]);
  // onLoad itself may resolve the device once; the panel channels must share
  // the same store rather than each asking the host again.
  assert.ok(calls.getDataPath <= 2, `getDataPath was called ${calls.getDataPath} times`);
  await backend.onUnload();
});

test("a host without a usable data path reports prefs unavailable instead of throwing", async () => {
  for (const getDataPath of [
    async () => undefined,
    async () => "",
    async () => 42,
    async () => ({ path: "/tmp/x" }),
    async () => {
      throw new Error("host refused");
    },
  ]) {
    const { backend } = await makeBackend({ getDataPath });
    const got = await backend.onPanelInvoke("kg.prefs.get", {});
    assert.equal(got.available, false, `available must be false for ${String(getDataPath)}`);
    assert.equal(got.language, "auto");
    // Saving refuses with a named reason rather than a Promise-in-path crash.
    await assert.rejects(backend.onPanelInvoke("kg.prefs.set", { language: "en" }), /data path is unavailable/);
    await backend.onUnload();
  }
});

test("createPrefsStore never passes a non-string to path.join", async () => {
  for (const dataPath of [undefined, null, "", "   ", 7, {}, [], Promise.resolve("/tmp/x")]) {
    const store = createPrefsStore({ dataPath });
    const got = await store.get();
    assert.equal(got.available, false);
  }
  const ok = createPrefsStore({ dataPath: "/tmp/personal-knowledge-prefs" });
  assert.equal((await ok.get()).available, true);
});

test("a failed first build does not poison the next panel call", async () => {
  const { backend, dataPath } = await makeBackend();
  await backend.onUnload();
  // After unload the stores are gone; the next channel rebuilds them.
  assert.equal((await backend.onPanelInvoke("kg.prefs.get", {})).available, true);
  const saved = await backend.onPanelInvoke("kg.prefs.set", { language: "en" });
  assert.equal(saved.saved, true);
  assert.equal(JSON.parse(await readFile(path.join(dataPath, "view-prefs.json"), "utf8")).language, "en");
});
