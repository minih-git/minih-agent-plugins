import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REAL_HOME, isolatedHome } from "./helpers/home.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixedNow = () => new Date("2026-07-17T00:00:00Z");

// Sandbox this process first, then snapshot the real directory as it exists.
await isolatedHome();

/** Relative paths of everything under the real ~/.personal-knowledge. */
async function snapshotRealEntries() {
  const root = path.join(REAL_HOME, ".personal-knowledge");
  const names = [];
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(relative);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
    }
  }
  await walk(root, "");
  return names.sort();
}

const before = await snapshotRealEntries();

test("a full test run leaves no new entries under the real ~/.personal-knowledge", async () => {
  // Build a service exactly the way an unisolated test would: default env
  // paths, default config resolution, default embedding settings. The HOME
  // override from the helper must absorb everything.
  delete process.env.PERSONAL_KNOWLEDGE_INDEX_DIR;
  delete process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG;
  delete process.env.PERSONAL_KNOWLEDGE_CONFIG;
  const root = await mkdtemp(path.join(os.tmpdir(), "pk-home-isolation-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  await writeFile(
    path.join(vault, "Note.md"),
    "---\ntitle: Note\ntype: topic\nstatus: active\n---\n# Note\n\nIsolation probe content.\n",
  );
  const { KnowledgeService } = await import("../mcp/knowledge-core.mjs");
  const service = await new KnowledgeService({
    vaultPath: vault,
    config: {},
    now: fixedNow,
    pluginRoot: PLUGIN_ROOT,
  }).initialize();
  await service.search({ query: "probe", mode: "ranked" });
  await service.search({ query: "probe", mode: "all" });
  await service.context({ cwd: root, topic: "" });

  const after = await snapshotRealEntries();
  assert.deepEqual(after, before, "the real ~/.personal-knowledge must be untouched by tests");
});
