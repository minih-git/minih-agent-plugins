import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VaultIndex } from "../lib/vault-index.mjs";
import { loadOntology } from "../lib/ontology.mjs";
import { buildGraphPayload } from "../lib/graph.mjs";
import { isolatedHome } from "./helpers/home.mjs";
// Keep every fixture away from the real ~/.personal-knowledge (see helpers/home.mjs).
await isolatedHome();

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = () => new Date("2026-07-17T00:00:00Z");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-graph-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  const write = async (name, content) => writeFile(path.join(vault, name), content);
  await write("Project - Demo.md", `---
title: Project - Demo
type: project
status: active
repo: /repo/demo
depends_on: "[[Lab]]"
verified: 2026-07-01
review_interval: quarterly
---
# Demo

Body link to [[Runbook]] and a ghost [[Nowhere]].
`);
  await write("Lab.md", `---
title: Lab
type: environment
status: active
project: "[[Project - Demo]]"
---
# Lab
`);
  await write("Runbook.md", `---
title: Runbook
type: procedure
status: active
project: "[[Project - Demo]]"
---
# Runbook
`);
  await write("Old.md", `---
title: Old
type: topic
status: archived
---
# Old
`);
  const index = new VaultIndex({ root: vault, config: { ignoreFolders: [] }, now });
  await index.refresh({ force: true });
  const ontology = await loadOntology({ pluginRoot: PLUGIN_ROOT, index });
  return { index, ontology };
}

test("graph payload: classes, families, project anchors, and memory block", async () => {
  const { index, ontology } = await fixture();
  const payload = buildGraphPayload({ index, ontology, now: now(), vaultName: "Knowledge" });
  assert.equal(payload.vaultName, "Knowledge");
  const byPath = new Map(payload.nodes.map((node) => [node.id, node]));
  assert.equal(byPath.get("Project - Demo.md").cls, "project");
  assert.equal(byPath.get("Project - Demo.md").family, "entity");
  assert.equal(byPath.get("Lab.md").cls, "environment");
  assert.equal(byPath.get("Runbook.md").project, "Project - Demo.md");
  assert.equal(byPath.get("Old.md").archived, true);
  assert.equal(payload.memory.status, "unsupported");
  assert.equal(payload.generatedAt, now().toISOString());
});

test("typed predicate links win over weak body links; ghosts are reported", async () => {
  const { index, ontology } = await fixture();
  const payload = buildGraphPayload({ index, ontology, now: now() });
  const typed = payload.links.filter((link) => link.predicate === "depends_on");
  assert.ok(typed.some((link) => link.source === "Project - Demo.md" && link.target === "Lab.md"));
  const duplicates = payload.links.filter(
    (link) => link.source === "Project - Demo.md" && link.target === "Lab.md",
  );
  assert.equal(duplicates.length, 1, "a typed link is not duplicated as a wikilink");
  const weak = payload.links.find(
    (link) => link.source === "Project - Demo.md" && link.target === "Runbook.md",
  );
  assert.equal(weak.predicate, "wikilink");
  assert.deepEqual(payload.ghosts, [{ id: "Nowhere", referencedBy: ["Project - Demo.md"] }]);
});

test("issues and stale flags ride on nodes", async () => {
  const { index, ontology } = await fixture();
  const payload = buildGraphPayload({ index, ontology, now: now() });
  const demo = payload.nodes.find((node) => node.id === "Project - Demo.md");
  assert.ok(Array.isArray(demo.issues));
  const lab = payload.nodes.find((node) => node.id === "Lab.md");
  assert.equal(lab.stale, false);
  // Project - Demo verified 2026-07-01 with quarterly window → not stale.
  assert.equal(demo.stale, false);
});
