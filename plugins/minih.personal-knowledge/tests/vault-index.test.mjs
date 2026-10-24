import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import { VaultIndex } from "../lib/vault-index.mjs";
import { tokenize } from "../lib/tokens.mjs";
import { locateSection, chunkNote } from "../lib/sections.mjs";

const fixedNow = () => new Date("2026-07-17T00:00:00Z");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p0-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "01 Projects"), { recursive: true });
  await mkdir(path.join(vault, "01 Projects", "Demo", ".worktree", "feature"), { recursive: true });
  await mkdir(path.join(vault, "03 Resources"), { recursive: true });

  await writeFile(
    path.join(vault, "01 Projects", "Project - Demo.md"),
    `---
title: Project - Demo
type: project
status: active
repo: /repo/demo
aliases:
  - Demo
  - demo-app
verified: 2026-07-01
review_interval: quarterly
tags:
  - minih
  - testing
---
# Demo

## Architecture

The gateway talks to the agent host.

## Releases

Release notes live in [[Release 1]] and [[Missing Note]].
`,
  );
  await writeFile(
    path.join(vault, "01 Projects", "Release 1.md"),
    `---
title: Release 1
type: release-record
status: done
project: "[[Project - Demo]]"
---
# Release 1

Shipped.
`,
  );
  await writeFile(
    path.join(vault, "01 Projects", "Notes.md"),
    `---
title: Notes
type: note
---
# Notes

A duplicate basename lives elsewhere: [[Notes]] points nowhere unique.
`,
  );
  await writeFile(
    path.join(vault, "03 Resources", "Notes.md"),
    `---
title: Notes
type: note
---
# Notes (resources copy)
`,
  );
  await writeFile(path.join(vault, "01 Projects", "Demo", ".worktree", "feature", "code.txt"), "not a note");

  const config = {
    ignoreFolders: [],
    backupRetentionDays: 0,
    embedding: { enabled: false },
  };
  const service = await new KnowledgeService({ vaultPath: vault, config, now: fixedNow }).initialize();
  return { root, vault, service };
}

test("frontmatter block lists parse as arrays", async () => {
  const { service } = await fixture();
  const note = await service.read({ note: "01 Projects/Project - Demo.md" });
  assert.deepEqual(note.metadata.tags, ["minih", "testing"]);
  assert.deepEqual(note.metadata.aliases, ["Demo", "demo-app"]);
  assert.equal(note.redacted, false);
});

test("link resolution prefers exact path, then unique basename, then shortest duplicate", async () => {
  const { service } = await fixture();
  const links = await service.links({ note: "01 Projects/Project - Demo.md" });
  assert.deepEqual(links.outgoing, ["Release 1", "Missing Note"]);
  assert.deepEqual(links.ghosts, ["Missing Note"]);
  const index = service.index;
  assert.equal(index.resolveTarget("01 Projects/Release 1"), "01 Projects/Release 1.md");
  assert.equal(index.resolveTarget("Release 1.md"), "01 Projects/Release 1.md");
  assert.equal(index.resolveTarget("release 1"), null, "basename matching is case-sensitive");
  const duplicate = index.resolveTarget("Notes");
  assert.ok(duplicate === "01 Projects/Notes.md" || duplicate === "03 Resources/Notes.md");
  assert.equal(duplicate.length, Math.min("01 Projects/Notes.md".length, "03 Resources/Notes.md".length));
  // Release 1 links back through its frontmatter `project` predicate.
  assert.deepEqual(index.backlinksOf("01 Projects/Project - Demo.md"), ["01 Projects/Release 1.md"]);
});

test("frontmatter wikilinks resolve into backlinks", async () => {
  const { service } = await fixture();
  const links = await service.links({ note: "01 Projects/Project - Demo.md" });
  assert.ok(links.backlinks.includes("01 Projects/Release 1.md"));
});

test("section replace honors CAS and keeps the rest of the note byte-identical", async () => {
  const { vault, service } = await fixture();
  const before = await service.read({ note: "01 Projects/Project - Demo.md" });
  const replacement = `## Architecture

Replaced body.
`;
  const preview = await service.write({
    path: before.path,
    content: replacement,
    section: "Architecture",
    operation: "replaceSection",
    expectedSha256: before.sha256,
  });
  assert.equal(preview.dryRun, true);
  await assert.rejects(
    service.write({
      path: before.path,
      content: replacement,
      section: "Architecture",
      operation: "replaceSection",
      expectedSha256: "0".repeat(64),
    }),
    /changed after it was read/,
  );
  const applied = await service.write({
    path: before.path,
    content: replacement,
    section: "Architecture",
    operation: "replaceSection",
    expectedSha256: before.sha256,
    dryRun: false,
  });
  assert.equal(applied.action, "update");
  const raw = await readFile(path.join(vault, before.path), "utf8");
  assert.match(raw, /## Architecture\n\nReplaced body\./);
  assert.match(raw, /## Releases\n\nRelease notes live in \[\[Release 1\]\] and \[\[Missing Note\]\]\./);
  assert.doesNotMatch(raw, /The gateway talks to the agent host\./);
});

test("appendToSection lands before the next heading with one blank line", async () => {
  const { vault, service } = await fixture();
  const before = await service.read({ note: "01 Projects/Project - Demo.md" });
  await service.write({
    path: before.path,
    content: "New release line.",
    section: "Releases",
    operation: "appendToSection",
    expectedSha256: before.sha256,
    dryRun: false,
  });
  const raw = await readFile(path.join(vault, before.path), "utf8");
  assert.match(raw, /\[\[Missing Note\]\]\.\n\nNew release line\.\n/);
  const after = await service.read({ note: before.path });
  assert.equal(after.metadata.title, "Project - Demo");
  assert.notEqual(after.sha256, before.sha256);
});

test("section addressing reports not-found and ambiguous headings", async () => {
  const { service } = await fixture();
  const before = await service.read({ note: "01 Projects/Project - Demo.md" });
  await assert.rejects(
    service.write({
      path: before.path,
      content: "x",
      section: "Nope",
      operation: "replaceSection",
      expectedSha256: before.sha256,
    }),
    (error) => error.code === "SECTION_NOT_FOUND" && /Architecture; Releases/.test(error.message),
  );
  await writeFile(
    path.join(service.rootRealpath, "01 Projects", "Twins.md"),
    "---\ntitle: Twins\ntype: note\n---\n# Same\n\nOne\n\n# Same\n\nTwo\n",
  );
  await service.index.refresh({ force: true });
  const twins = await service.read({ note: "01 Projects/Twins.md" });
  await assert.rejects(
    service.write({
      path: twins.path,
      content: "x",
      section: "Same",
      operation: "replaceSection",
      expectedSha256: twins.sha256,
    }),
    (error) => error.code === "SECTION_AMBIGUOUS" && /Same > Same/.test(error.message),
  );
});

test("patchFrontmatter changes only the block and preserves body bytes", async () => {
  const { vault, service } = await fixture();
  const before = await service.read({ note: "01 Projects/Release 1.md" });
  const bodyBefore = (await readFile(path.join(vault, before.path), "utf8")).split("---\n").slice(2).join("---\n");
  await service.write({
    path: before.path,
    frontmatter: { status: "succeeded", extra: ["a", "b"], review_interval: null },
    operation: "patchFrontmatter",
    expectedSha256: before.sha256,
    dryRun: false,
  });
  const raw = await readFile(path.join(vault, before.path), "utf8");
  const bodyAfter = raw.split("---\n").slice(2).join("---\n");
  assert.equal(bodyAfter, bodyBefore);
  const after = await service.read({ note: before.path });
  assert.equal(after.metadata.status, "succeeded");
  assert.deepEqual(after.metadata.extra, ["a", "b"]);
  assert.equal("review_interval" in after.metadata, false);
  assert.equal(after.metadata.type, "release-record");
});

test("a write built from a redacted read fails with REDACTED_PLACEHOLDER", async () => {
  const { vault, service } = await fixture();
  const secretPath = "Secret.md";
  await writeFile(
    path.join(vault, secretPath),
    "---\ntitle: Secret\ntype: note\n---\ntoken: abcdefghijklmn\n",
  );
  await service.index.refresh({ force: true });
  const read = await service.read({ note: secretPath });
  assert.equal(read.redacted, true);
  await assert.rejects(
    service.write({
      path: secretPath,
      content: read.content,
      expectedSha256: read.sha256,
      dryRun: false,
    }),
    /REDACTED_PLACEHOLDER/,
  );
});

test("context routes from note metadata: repo prefixes and worktree paths", async () => {
  const { service } = await fixture();
  const inRepo = await service.context({ cwd: "/repo/demo/src", topic: "" });
  assert.deepEqual(inRepo.matchedProjects, ["Project - Demo"]);
  assert.ok(inRepo.requestedNotes.includes("01 Projects/Project - Demo.md"));
  assert.ok(inRepo.notes.some((note) => note.path === "01 Projects/Project - Demo.md"));

  const inWorktree = await service.context({ cwd: "/repo/demo/.worktree/feature", topic: "" });
  assert.deepEqual(inWorktree.matchedProjects, ["Project - Demo"]);

  const byAlias = await service.context({ cwd: "/somewhere/else", topic: "demo-app work" });
  assert.deepEqual(byAlias.matchedProjects, ["Project - Demo"]);

  const elsewhere = await service.context({ cwd: "/somewhere/else", topic: "" });
  assert.deepEqual(elsewhere.matchedProjects, []);
});

test("read returns outline and section slices with their own hash", async () => {
  const { service } = await fixture();
  const read = await service.read({
    note: "01 Projects/Project - Demo.md",
    outline: true,
    section: "Releases",
  });
  assert.deepEqual(read.outline.map((entry) => entry.text), ["Demo", "Architecture", "Releases"]);
  assert.match(read.content, /^## Releases/);
  assert.doesNotMatch(read.content, /# Demo/);
  assert.equal(read.sectionSha256, read.sectionSha256);
  const full = await service.read({ note: "01 Projects/Project - Demo.md" });
  assert.notEqual(read.sha256, undefined);
  assert.equal(read.sha256, full.sha256);
});

test("tokenizer keeps hyphenated words and builds CJK bigrams", () => {
  assert.deepEqual(tokenize("easy-tier 组网"), ["easy-tier", "easy", "tier", "组网"]);
  assert.deepEqual(tokenize("资产服务器"), ["资产", "产服", "服务", "务器"]);
  assert.deepEqual(tokenize("网"), ["网"]);
});

test("sections chunk by headings and cap the piece length", () => {
  const long = `# Top\n\n${"word ".repeat(600)}\n\n## Sub\n\nShort tail.\n`;
  const chunks = chunkNote(long);
  assert.equal(chunks[0].headingPath.join(" > "), "Top");
  assert.ok(chunks.slice(1).every((chunk) => chunk.headingPath.join(" > ") === "Top > Sub" || chunk.headingPath.length === 1));
  const located = locateSection(long, "Top > Sub");
  assert.equal(located.ok, true);
});
