import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import { Ontology } from "../lib/ontology.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixedNow = () => new Date("2026-07-17T00:00:00Z");

async function fixture({ enforcement = "warn", ontologyNote = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p1-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "01 Projects", "Demo"), { recursive: true });
  await mkdir(path.join(vault, "08 Standards"), { recursive: true });

  const write = async (relative, content) => {
    const absolute = path.join(vault, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  };

  await write("01 Projects/Project - Demo.md", `---
title: Project - Demo
type: project
status: active
repo: /repo/demo
verified: 2026-07-01
review_interval: quarterly
---
# Demo

See [[01 Projects/Demo/Runbook]] and [[Environment - Lab]].
`);
  // Legacy type resolves through the alias table.
  await write("01 Projects/Demo/Runbook.md", `---
title: Runbook
type: runbook
status: active
project: "[[Project - Demo]]"
verified: 2026-07-01
review_interval: on-change
---
# Runbook

Deploy steps.
`);
  // Unknown status + odd stability + broken predicate target.
  await write("Incident.md", `---
title: Incident
type: incident
status: succeeded-runtime-verified
stability: verified
resolved_by: "[[Ghost Release]]"
---
# Incident

Something broke.
`);
  // Oversized and orphaned.
  await write("Big.md", `---\ntitle: Big\ntype: topic\nstatus: active\n---\n# Big\n\n${"x".repeat(25000)}\n`);
  // Navigation notes are exempt from the orphan rule.
  await write("Map.md", `---\ntitle: Map\ntype: moc\n---\n# Map\n`);
  // A note with an explicit exception.
  await write("Ignored.md", `---\ntitle: Ignored\ntype: topic\nstatus: active\nlint_ignore: [ORPHAN]\n---\n# Ignored\n`);

  if (ontologyNote) {
    await write("08 Standards/知识本体.md", `---\ntitle: 知识本体\ntype: convention\n---\n\n\`\`\`yaml\n${ontologyNote}\n\`\`\`\n`);
  }

  const config = { ignoreFolders: [], backupRetentionDays: 0, embedding: { enabled: false } };
  const service = await new KnowledgeService({
    vaultPath: vault,
    config,
    now: fixedNow,
    pluginRoot: PLUGIN_ROOT,
  }).initialize();
  if (enforcement === "enforce") service.ontology.enforcement = "enforce";
  return { root, vault, service, write };
}

test("legacy types read as classes; issues carry stable codes", async () => {
  const { service } = await fixture();
  const report = await service.lintVault();
  const byPath = new Map();
  for (const issue of report.issues) {
    byPath.set(`${issue.path}|${issue.code}`, issue);
  }
  assert.ok(byPath.has("01 Projects/Demo/Runbook.md|LEGACY_TYPE"), "runbook is a legacy alias");
  assert.ok(byPath.has("Incident.md|UNKNOWN_STATUS"));
  assert.ok(byPath.has("Incident.md|UNKNOWN_STABILITY"));
  assert.ok(byPath.has("Incident.md|UNKNOWN_PREDICATE_TARGET"), "ghost release");
  assert.ok(byPath.has("Big.md|OVERSIZE"));
  assert.ok(byPath.has("Ignored.md|ORPHAN") === false, "lint_ignore suppresses ORPHAN");
  assert.ok(byPath.has("Map.md|ORPHAN") === false, "navigation notes are exempt");
});

test("enforce blocks only issues the write introduces; editing an old note is never blocked", async () => {
  const { service } = await fixture({ enforcement: "enforce" });
  // The stored note already violates; patching another key must succeed.
  const runbook = await service.read({ note: "01 Projects/Demo/Runbook.md" });
  const result = await service.write({
    path: runbook.path,
    frontmatter: { verified: "2026-07-02" },
    operation: "patchFrontmatter",
    expectedSha256: runbook.sha256,
  });
  assert.equal(result.action, "update");
  assert.ok(Array.isArray(result.warnings));

  // A write that introduces a NEW violation fails under enforce.
  const project = await service.read({ note: "01 Projects/Project - Demo.md" });
  await assert.rejects(
    service.write({
      path: project.path,
      frontmatter: { deployed_to: "[[Ghost Env]]" },
      operation: "patchFrontmatter",
      expectedSha256: project.sha256,
    }),
    /ONTOLOGY_VIOLATION.*UNKNOWN_PREDICATE_TARGET/,
  );
});

test("warn mode returns new issues as warnings without failing", async () => {
  const { service } = await fixture({ enforcement: "warn" });
  const project = await service.read({ note: "01 Projects/Project - Demo.md" });
  const result = await service.write({
    path: project.path,
    frontmatter: { deployed_to: "[[Ghost Env]]" },
    operation: "patchFrontmatter",
    expectedSha256: project.sha256,
  });
  assert.equal(result.action, "update");
  assert.ok(result.warnings.some((warning) => warning.code === "UNKNOWN_PREDICATE_TARGET"));
});

test("ontology defaults load and the vault note overrides vocabulary", async () => {
  const { service } = await fixture({
    ontologyNote: "classes:\n  gadget:\n    family: entity\n    status: [on, off]\n",
  });
  assert.equal(service.ontology.resolveClass("gadget"), "gadget");
  assert.equal(service.ontology.source, "08 Standards/知识本体.md");
  assert.equal(service.ontology.resolveClass("runbook"), "procedure", "aliases survive an override");
});

test("migration plan lists alias rewrites, base filters, and review items; applies in batches", async () => {
  const { vault, service } = await fixture();
  const report = await service.lintVault();
  assert.ok(report.total > 0);

  await writeFile(path.join(vault, "Board.base"), 'filters:\n  and:\n    - type == "runbook"\n');
  await service.index.refresh({ force: true });

  const { spawnSync } = await import("node:child_process");
  const pluginRoot = PLUGIN_ROOT;
  const outDir = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-plan-"));
  const emptyConfig = path.join(outDir, "repo-map.json");
  await writeFile(emptyConfig, '{"embedding": {"enabled": false}}\n');
  const env = {
    ...process.env,
    PERSONAL_KNOWLEDGE_VAULT: vault,
    PERSONAL_KNOWLEDGE_CONFIG: emptyConfig,
  };
  const planned = spawnSync(process.execPath, ["scripts/ontology-migrate.mjs", "--plan", "--out", outDir], {
    cwd: pluginRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(await readFile(path.join(outDir, "plan.json"), "utf8"));
  const runbook = plan.notes.find((note) => note.path === "01 Projects/Demo/Runbook.md");
  assert.ok(runbook.changes.some((change) => change.key === "type" && change.to === "procedure" && change.review === false));
  assert.ok(plan.bases.some((base) => base.path === "Board.base" && base.to === "procedure"));
  assert.ok(plan.notes.some((note) => note.path === "Incident.md" && note.changes.some((change) => change.review)));

  // Applying batch 1 rewrites the frontmatter only; the body stays identical.
  const bodyBefore = (await readFile(path.join(vault, "01 Projects/Demo/Runbook.md"), "utf8")).split("---\n").slice(2).join("---\n");
  const applied = spawnSync(process.execPath, ["scripts/ontology-migrate.mjs", "--apply", outDir, "--batch", "1"], {
    cwd: pluginRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(applied.status, 0, applied.stderr);
  const raw = await readFile(path.join(vault, "01 Projects/Demo/Runbook.md"), "utf8");
  assert.equal(raw.split("---\n").slice(2).join("---\n"), bodyBefore);
  assert.match(raw, /type: procedure/);
  const log = JSON.parse(await readFile(path.join(outDir, "applied.json"), "utf8"));
  assert.equal(log.batches[0].batch, 1);
  assert.ok(log.batches[0].applied.length >= 1);
});

test("Ontology.validate tolerates notes without frontmatter", () => {
  const ontology = new Ontology({
    classes: { topic: { family: "entity", status: ["active"], defaultStability: "stable" } },
    predicates: {},
  });
  const issues = ontology.validate(
    { path: "X.md", metadata: {}, frontmatter: { invalid: true, error: "bad yaml" }, chars: 10 },
    { backlinkCount: 0, now: fixedNow() },
  );
  assert.ok(issues.some((issue) => issue.code === "FRONTMATTER_INVALID"));
  assert.ok(issues.some((issue) => issue.code === "UNKNOWN_TYPE"));
});
