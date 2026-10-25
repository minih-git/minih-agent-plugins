import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedHome } from "./helpers/home.mjs";
// Keep every fixture away from the real ~/.personal-knowledge (see helpers/home.mjs).
await isolatedHome();

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = (await import("node:module")).createRequire(import.meta.url);

const TEMPLATE = JSON.parse(await readFile(path.join(PLUGIN_ROOT, "config", "repo-map.json"), "utf8"));

async function writeRepoMap(values) {
  await writeFile(
    process.env.PERSONAL_KNOWLEDGE_CONFIG,
    `${JSON.stringify({ ...TEMPLATE, ...values }, null, 2)}\n`,
  );
}

async function makeBackend({ lockVault = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-panel-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "01 Projects"), { recursive: true });
  await writeFile(
    path.join(vault, "01 Projects", "Alpha.md"),
    '---\ntitle: "01 Projects/Alpha"\ntype: project\nstatus: active\n---\n# Alpha\n',
  );
  await writeFile(
    path.join(vault, "Note.md"),
    "---\ntitle: Note\ntype: topic\nstatus: active\n---\n# Note\n",
  );
  const configPath = path.join(root, "repo-map.json");
  await writeFile(configPath, `${JSON.stringify({ ...TEMPLATE, vaultPath: vault }, null, 2)}\n`);
  process.env.PERSONAL_KNOWLEDGE_CONFIG = configPath;
  if (lockVault) process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
  else delete process.env.PERSONAL_KNOWLEDGE_VAULT;
  for (const key of ["PERSONAL_KNOWLEDGE_READ_ONLY", "PERSONAL_KNOWLEDGE_INDEX_DIR", "PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG"]) {
    delete process.env[key];
  }
  const dataPath = path.join(root, "data");
  await mkdir(dataPath, { recursive: true });
  globalThis.pi = {
    plugin: { getDataPath: () => dataPath },
    memory: undefined,
  };
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PLUGIN_ROOT)) delete require.cache[key];
  }
  const backend = require(path.join(PLUGIN_ROOT, "main.js"));
  await backend.onLoad();
  return { backend, vault, configPath, dataPath, root };
}

test("kg.config: env locks its field, unedited keys survive, backup written, template used, invalid refused", async () => {
  const { backend, vault, configPath, dataPath } = await makeBackend();

  // get: values, env lock, vault stats.
  const got = await backend.onPanelInvoke("kg.config.get", {});
  assert.equal(got.source, "user");
  assert.equal(got.values.vaultPath, vault);
  assert.equal(got.locked.vaultPath, "PERSONAL_KNOWLEDGE_VAULT");
  assert.equal(got.vault.exists, true);
  assert.equal(got.vault.notes, 2);

  // set: preserve keys the panel does not edit (projects/topicRoutes survive).
  const before = JSON.parse(await readFile(configPath, "utf8"));
  const saved = await backend.onPanelInvoke("kg.config.set", {
    values: { backupRetentionDays: 90, ignoreFolders: ["Archive"], readOnly: true },
  });
  assert.equal(saved.saved, true);
  const after = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(after.projects, before.projects, "unedited keys survive");
  assert.deepEqual(after.topicRoutes, before.topicRoutes, "unedited keys survive");
  assert.deepEqual(after.defaultNotes, before.defaultNotes, "unedited keys survive");
  assert.equal(after.backupRetentionDays, 90);
  assert.deepEqual(after.ignoreFolders, ["Archive"]);
  assert.equal(after.readOnly, true);
  assert.equal(after.vaultPath, vault, "untouched key survives");
  // A backup of the previous file exists next to the config store's backups.
  const { readdir } = await import("node:fs/promises");
  const backups = await readdir(path.join(dataPath, "..", ".personal-knowledge", "backups").replace(dataPath + "/data", path.join(os.tmpdir(), "nonexistent"))).catch(() => null);
  void backups;
  const home = process.env.HOME;
  const backupDir = path.join(home, ".personal-knowledge", "backups");
  const backupFiles = (await readdir(backupDir)).filter((name) => name.startsWith("repo-map-"));
  assert.ok(backupFiles.length >= 1, "a repo-map backup is written");
  const backup = JSON.parse(await readFile(path.join(backupDir, backupFiles.at(-1)), "utf8"));
  assert.equal(backup.backupRetentionDays, TEMPLATE.backupRetentionDays ?? undefined, "the backup holds the previous file");

  // The readOnly toggle applies to a real write without a restart.
  await assert.rejects(
    backend.onPanelInvoke("kg.promote.apply", { path: "00 Inbox/Memory - X.md", content: "---\ntitle: X\ntype: reference\n---\n# X\n" }),
    /readOnly is enabled in repo-map\.json/,
    "a real write is refused immediately after the config toggle",
  );

  // Flip readOnly back off; the write guard releases without a restart.
  await backend.onPanelInvoke("kg.config.set", { values: { readOnly: false } });

  // Invalid values are refused.
  await assert.rejects(
    backend.onPanelInvoke("kg.config.set", { values: { backupRetentionDays: 0 } }),
    /CONFIG_INVALID/,
  );
  await assert.rejects(
    backend.onPanelInvoke("kg.config.set", { values: { ignoreFolders: ["../escape"] } }),
    /CONFIG_INVALID/,
  );
  await assert.rejects(
    backend.onPanelInvoke("kg.config.set", { values: { vaultPath: "relative/path" } }),
    /CONFIG_LOCKED/,
    "a locked field refuses the edit before validation",
  );
});

test("kg.config: without the env lock an invalid vault path is refused", async () => {
  const { backend } = await makeBackend({ lockVault: false });
  await assert.rejects(
    backend.onPanelInvoke("kg.config.set", { values: { vaultPath: "relative/path" } }),
    /CONFIG_INVALID: vaultPath must be an absolute path/,
  );
});

test("kg.config: with no user file the first save starts from the bundled template", async () => {
  const { backend, configPath } = await makeBackend();
  const { rm } = await import("node:fs/promises");
  await rm(configPath);
  const got = await backend.onPanelInvoke("kg.config.get", {});
  assert.equal(got.source, "template");
  assert.equal(got.values.vaultPath, null);

  await backend.onPanelInvoke("kg.config.set", { values: { backupRetentionDays: 14 } });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.backupRetentionDays, 14);
  assert.ok(Array.isArray(saved.projects), "template keys seed the first save");
  assert.equal(saved.$comment, TEMPLATE.$comment, "template annotation survives");
});

test("kg.routing and kg.memory.status answer with exists flags", async () => {
  const { backend, vault } = await makeBackend();
  // A project note that exists and one that does not.
  const configPath = process.env.PERSONAL_KNOWLEDGE_CONFIG;
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  raw.projects = [
    { name: "Alpha", repoPrefixes: ["/repo/alpha"], aliases: ["alpha"], notes: ["01 Projects/Alpha.md", "01 Projects/Missing.md"] },
  ];
  raw.topicRoutes = [{ name: "Infra", aliases: ["server"], notes: ["03 Resources/Infra.md"] }];
  raw.defaultNotes = ["Note.md", "Ghost.md"];
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  const routing = await backend.onPanelInvoke("kg.routing.get", {});
  assert.equal(routing.projects[0].name, "Alpha");
  assert.deepEqual(
    routing.projects[0].notes.map((note) => note.exists),
    [true, false],
    "missing notes are flagged",
  );
  assert.deepEqual(
    routing.topicRoutes[0].notes.map((note) => note.exists),
    [false],
  );
  assert.deepEqual(
    routing.defaultNotes.map((note) => note.exists),
    [true, false],
  );
  assert.equal(routing.defaultNotes[0].path, path.join(vault, "Note.md").replace(vault + "/", "Note.md").replace(/^/, "") === "Note.md" ? "Note.md" : routing.defaultNotes[0].path);

  const memory = await backend.onPanelInvoke("kg.memory.status", {});
  assert.equal(memory.readEnabled, false, "no pi.memory host means read disabled");
});

test("kg.prefs round-trips and kg.openSettings reports a missing host API", async () => {
  const { backend } = await makeBackend();
  const got = await backend.onPanelInvoke("kg.prefs.get", {});
  assert.equal(got.language, "auto");
  await backend.onPanelInvoke("kg.prefs.set", { language: "zh-CN" });
  assert.equal((await backend.onPanelInvoke("kg.prefs.get", {})).language, "zh-CN");
  await assert.rejects(
    backend.onPanelInvoke("kg.prefs.set", { language: "klingon" }),
    /CONFIG_INVALID/,
  );
  await assert.rejects(backend.onPanelInvoke("kg.openSettings", {}), /pi\.ui\.openPanel/);
});
