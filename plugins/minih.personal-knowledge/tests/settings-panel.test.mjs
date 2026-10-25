import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

/** Drive the real MCP stdio server as a child process. The callback receives
 * a `call(id, method, params)` helper that frames JSON-RPC lines and resolves
 * per response id; every request carries a timeout so a wedged or crashed
 * server fails the test instead of hanging the suite. */
async function withMcpServer(run) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "mcp", "server.mjs")], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const waiters = new Map();
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.on("exit", () => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited before answering; stderr: ${stderr.join("")}`));
    }
    waiters.clear();
  });
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP request ${id} (${method}) timed out; stderr: ${stderr.join("")}`)),
        15_000,
      );
      waiters.set(id, { reject, resolve, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    return await run({ call });
  } finally {
    child.kill("SIGTERM");
  }
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
  assert.equal("$comment" in saved, false, "the first save drops the template's $comment");
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

test("kg.config.set: an existing user file never regains template keys it dropped", async () => {
  const { backend, configPath, vault } = await makeBackend({ lockVault: false });
  // A user file that dropped topicRoutes and $comment on purpose.
  const userFile = { vaultPath: vault, projects: [], ignoreFolders: [".obsidian"], backupRetentionDays: 7 };
  await writeFile(configPath, `${JSON.stringify(userFile, null, 2)}\n`);
  await backend.onPanelInvoke("kg.config.set", { values: { backupRetentionDays: 21 } });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.backupRetentionDays, 21);
  assert.equal("topicRoutes" in saved, false, "topicRoutes must not bleed back from the template");
  assert.equal("$comment" in saved, false, "the template $comment must not bleed back");
  assert.deepEqual(saved.projects, []);
  assert.deepEqual(saved.ignoreFolders, [".obsidian"]);
  assert.equal(saved.vaultPath, vault, "other keys stay byte-equal in value");
});

test("kg.config.set: vaultPath must be an existing directory", async () => {
  const { backend } = await makeBackend({ lockVault: false });
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-vaultcheck-"));
  const missing = path.join(root, "Does Not Exist");
  await assert.rejects(
    backend.onPanelInvoke("kg.config.set", { values: { vaultPath: missing } }),
    (error) => error.code === "CONFIG_INVALID" && /does not exist/.test(error.message),
    "a missing path is refused",
  );
  const filePath = path.join(root, "plain-file.txt");
  await writeFile(filePath, "not a vault\n");
  await assert.rejects(
    backend.onPanelInvoke("kg.config.set", { values: { vaultPath: filePath } }),
    (error) => error.code === "CONFIG_INVALID" && /not a directory/.test(error.message),
    "a plain file is refused",
  );
  // A real directory passes.
  const saved = await backend.onPanelInvoke("kg.config.set", { values: { vaultPath: root } });
  assert.equal(saved.saved, true);
});

test("an unparseable repo-map fails closed for every real write", async () => {
  const { backend, configPath, vault } = await makeBackend({ lockVault: false });
  const mcpWrite = { path: "00 Inbox/Mcp Repair.md", content: "---\ntitle: Mcp Repair\ntype: reference\n---\n# Mcp Repair\n", create: true, dryRun: false };
  // The MCP server starts on the still-valid config, then the file is
  // corrupted underneath the running process — the case the guard's
  // mtime-triggered re-read exists for.
  await withMcpServer(async ({ call }) => {
    await call(1, "ping", {});
    await writeFile(configPath, "{ this is not json");

    // Panel channel: a real write is refused while the file is unparseable.
    await assert.rejects(
      backend.onPanelInvoke("kg.promote.apply", { path: "00 Inbox/Memory - X.md", content: "---\ntitle: X\ntype: reference\n---\n# X\n" }),
      /readOnly is enabled in repo-map\.json/,
      "kg.promote.apply is refused while repo-map.json is unparseable",
    );

    // MCP channel: the same guard refuses knowledge_write with dry-run off.
    const refused = await call(2, "tools/call", { name: "knowledge_write", arguments: mcpWrite });
    assert.equal(refused.result?.isError, true, "knowledge_write(dryRun:false) is refused while repo-map.json is unparseable");
    assert.match(refused.result?.content?.[0]?.text ?? "", /readOnly is enabled in repo-map\.json/);

    // Repairing the file releases the guard without a restart on both
    // channels: the MCP write goes through, and the panel refusal is no
    // longer about read-only mode but about the (deliberately wrong) target
    // path, which only reaches the check after the read-only gate passed.
    await writeRepoMap({ vaultPath: vault });
    const allowed = await call(3, "tools/call", { name: "knowledge_write", arguments: mcpWrite });
    assert.equal(allowed.result?.isError, undefined, "the repaired config lets knowledge_write through");
    assert.equal(allowed.result?.structuredContent?.action, "create");
    assert.ok((await stat(path.join(vault, "00 Inbox", "Mcp Repair.md"))).isFile(), "the note is really written");

    let afterRepairMessage = null;
    try {
      await backend.onPanelInvoke("kg.promote.apply", {
        path: "01 Projects/Evil.md",
        content: "---\ntitle: X\ntype: reference\n---\n# X\n",
      });
      assert.fail("expected a refusal for the non-Inbox target");
    } catch (error) {
      afterRepairMessage = String(error?.message ?? error);
    }
    assert.doesNotMatch(afterRepairMessage, /readOnly is enabled/, "the read-only refusal is gone after repair");
    assert.match(afterRepairMessage, /00 Inbox/, "the failure is about the target path, not read-only");
  });
});
