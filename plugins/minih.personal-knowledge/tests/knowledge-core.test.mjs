import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import { createContextVault, createVault } from "./helpers/context-fixture.mjs";
import { isolatedHome } from "./helpers/home.mjs";
// Keep every fixture away from the real ~/.personal-knowledge (see helpers/home.mjs).
await isolatedHome();

const SANDBOX_EMBEDDING_PATH = process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG;
const fixedNow = () => new Date("2026-07-17T00:00:00Z");

/** The shared fixture vault, with the vector channel off unless a test enables it. */
async function fixture() {
  // Same vault as the `knowledge_context` snapshot test (helpers/context-fixture).
  const { root, vault, config } = await createContextVault();
  // Deterministic and offline: no vector channel unless a test turns it on.
  await writeFile(SANDBOX_EMBEDDING_PATH, '{"enabled": false}\n');
  const service = await new KnowledgeService({ vaultPath: vault, config, now: fixedNow }).initialize();
  return { root, vault, service };
}

test("repository and topic routes produce a bounded context pack", async () => {
  const { service } = await fixture();
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "Demo server", maxChars: 20_000 });
  assert.deepEqual(context.matchedProjects, ["Demo"]);
  assert.deepEqual(context.matchedRoutes, ["Infrastructure"]);
  assert.equal(context.notes.length, 4);
  assert.equal(context.missing.length, 0);
});

test("context loads project notes before truncated default notes even on a small budget", async () => {
  const { service } = await fixture();
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "", maxChars: 6_000, mode: "full" });
  assert.deepEqual(context.matchedProjects, ["Demo"]);
  const paths = context.notes.map((note) => note.path);
  assert.ok(paths[0].startsWith("01 Projects/"), "project notes must load first");
  assert.ok(paths[0] !== "02 Areas/Preferences.md", "default notes must not consume the budget first");
  assert.ok(paths.some((candidate) => candidate === "02 Areas/Preferences.md"), "default note still appears as a head summary");
  const preferences = context.notes.find((note) => note.path === "02 Areas/Preferences.md");
  assert.ok(preferences && preferences.content.length <= 4_000, "default notes are head-only summaries");
});

test("navigate leads with default notes and returns no body for routed notes", async () => {
  const { service } = await fixture();
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "Demo server" });
  assert.equal(context.mode, "navigate");
  assert.equal(context.notes[0].path, "02 Areas/Preferences.md", "the default note leads");
  assert.ok(context.notes[0].head.content.length > 0, "the default note keeps a head excerpt");
  for (const note of context.notes) {
    assert.equal(note.content, undefined, `${note.path} must not carry its body`);
    assert.equal(typeof note.abstract, "string");
    assert.ok(Array.isArray(note.outline));
  }
});

test("write prunes backup snapshots past the retention window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-prune-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "02 Areas"), { recursive: true });
  const notePath = path.join(vault, "02 Areas", "Preferences.md");
  await writeFile(notePath, `---\ntitle: Preferences\ntype: area\n---\n# Preferences\nv1\n`);
  const config = { defaultNotes: [], backupRetentionDays: 30 };
  const early = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-07-17T00:00:00Z");
  const oldService = await new KnowledgeService({ vaultPath: vault, config, now: () => early }).initialize();
  const earlyRead = await oldService.read({ note: "02 Areas/Preferences.md" });
  assert.equal(earlyRead.path, "02 Areas/Preferences.md");
  const firstWrite = await oldService.write({ path: earlyRead.path, content: `---\ntitle: Preferences\ntype: area\n---\n# Preferences\nv2\n`, expectedSha256: earlyRead.sha256, dryRun: false });
  assert.equal(firstWrite.action, "update");
  const freshService = await new KnowledgeService({ vaultPath: vault, config, now: () => now }).initialize();
  const readBack = await freshService.read({ note: "02 Areas/Preferences.md" });
  assert.equal(readBack.path, "02 Areas/Preferences.md");
  const secondWrite = await freshService.write({ path: readBack.path, content: `---\ntitle: Preferences\ntype: area\n---\n# Preferences\nv3\n`, expectedSha256: readBack.sha256, dryRun: false });
  assert.equal(secondWrite.action, "update");
  const backupsRoot = path.join(vault, ".personal-knowledge", "backups");
  const { readdir } = await import("node:fs/promises");
  const stamps = await readdir(backupsRoot);
  const january = stamps.filter((stamp) => stamp.startsWith("2026-01-01"));
  assert.equal(january.length, 0, "the January snapshot must be pruned");
  assert.ok(stamps.some((stamp) => stamp.startsWith("2026-07-17")), "the fresh snapshot survives");
});

test("search is deterministic and note reads redact likely credentials", async () => {
  const { service } = await fixture();
  const search = await service.search({ query: "EasyTier center", mode: "all" });
  assert.equal(search.count, 1);
  assert.equal(search.results[0].path, "03 Resources/Deploy/Infrastructure.md");
  const secret = await service.read({ note: "Secret" });
  assert.match(secret.content, /\[REDACTED\]/);
  assert.doesNotMatch(secret.content, /abcdefghijklmnopqrstuvwxyz/);
});

test("freshness follows verified dates and review intervals", async () => {
  const { service } = await fixture();
  const stale = await service.stale();
  const byPath = new Map(stale.due.map((item) => [item.path, item]));
  assert.equal(byPath.get("01 Projects/Project - Demo.md").reason, "past-review-window");
  assert.equal(byPath.get("01 Projects/Demo/Knowledge Map.md").reason, "unverified");
  assert.equal(byPath.get("03 Resources/Deploy/Infrastructure.md").reason, "unverified");
  assert.equal(byPath.has("02 Areas/Preferences.md"), false);
});

test("wikilinks return both outgoing links and backlinks", async () => {
  const { service } = await fixture();
  const links = await service.links({ note: "01 Projects/Project - Demo.md" });
  assert.deepEqual(links.outgoing, []);
  assert.deepEqual(links.backlinks.sort(), ["01 Projects/Demo/Knowledge Map.md", "02 Areas/Preferences.md"]);
});

test("write defaults to dry-run, checks hashes, backs up, and writes atomically", async () => {
  const { vault, service } = await fixture();
  const current = await service.read({ note: "02 Areas/Preferences.md" });
  const replacement = `---
title: Preferences
type: area
status: active
updated: 2026-07-17
verified: 2026-07-17
review_interval: on-change
---
# Preferences

Prefer evidence-backed work and concise reports.
`;
  const preview = await service.write({ path: current.path, content: replacement, expectedSha256: current.sha256 });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.action, "update");
  assert.match(await readFile(path.join(vault, current.path), "utf8"), /See \[\[Project - Demo\]\]/);

  const applied = await service.write({ path: current.path, content: replacement, expectedSha256: current.sha256, dryRun: false });
  assert.equal(applied.action, "update");
  assert.match(applied.backupPath, /^\.personal-knowledge\/backups\//);
  assert.match(await readFile(path.join(vault, current.path), "utf8"), /concise reports/);
  assert.match(await readFile(path.join(vault, applied.backupPath), "utf8"), /See \[\[Project - Demo\]\]/);
});

test("write rejects traversal, stale hashes, and probable secrets", async () => {
  const { service } = await fixture();
  const current = await service.read({ note: "02 Areas/Preferences.md" });
  const safe = `---
title: Preferences
type: area
---
# Preferences
`;
  await assert.rejects(
    service.write({ path: "../outside.md", content: safe, create: true }),
    /unsafe|relative|escapes/,
  );
  await assert.rejects(
    service.write({ path: current.path, content: safe, expectedSha256: "0".repeat(64), dryRun: false }),
    /changed after it was read/,
  );
  const unsafe = `---
title: Credentials
type: resource
---
api_key: sk-abcdefghijklmnopqrstuvwxyz123456
`;
  await assert.rejects(
    service.write({ path: "Credentials.md", content: unsafe, create: true, dryRun: false }),
    /sensitive credentials/,
  );
});

test("ranked search keeps the chunk that matched, not the note's last chunk", async () => {
  // One note, two sections: the query fills the first and appears once in the
  // second. Keeping the last chunk seen instead of the best one made `section`
  // and `snippet` describe the wrong half of the note.
  const note = `---
title: Demo
type: project
status: active
repo: /workspace/demo
---
# Demo

## Alpha

${"zebra ".repeat(12).trim()}

## Beta

zebra once.
`;
  const { vault } = await createVault({ "Demo.md": note });
  await writeFile(SANDBOX_EMBEDDING_PATH, '{"enabled": false}\n');
  const service = await new KnowledgeService({
    vaultPath: vault,
    config: { ignoreFolders: [], backupRetentionDays: 0 },
    now: fixedNow,
  }).initialize();

  const ranked = await service.search({ query: "zebra", mode: "ranked" });
  assert.equal(ranked.results[0].path, "Demo.md");
  assert.equal(ranked.results[0].section, "Demo > Alpha", "the matching chunk names the section");
  assert.match(ranked.results[0].snippet, /zebra zebra/);
  assert.doesNotMatch(ranked.results[0].snippet, /once/, "the snippet comes from the same chunk");
});
