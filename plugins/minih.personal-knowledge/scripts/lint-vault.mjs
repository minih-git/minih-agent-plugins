#!/usr/bin/env node
/**
 * Lint the vault against the ontology (ADR 0001 §3). Read-only.
 *
 *   node scripts/lint-vault.mjs                 # text output
 *   node scripts/lint-vault.mjs --json          # machine-readable
 *   PERSONAL_KNOWLEDGE_CONFIG=~/.personal-knowledge/repo-map.json node scripts/lint-vault.mjs
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createKnowledgeService } from "../mcp/knowledge-core.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const service = await createKnowledgeService({ pluginRoot });
const report = await service.lintVault();

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ...report, ontologySource: service.ontology?.source }, null, 2)}\n`);
} else {
  process.stdout.write(`Ontology source: ${service.ontology?.source ?? "none"}\n`);
  process.stdout.write(`Issues: ${report.total}\n`);
  for (const [code, count] of Object.entries(report.summary)) {
    process.stdout.write(`  ${code}: ${count}\n`);
  }
  process.stdout.write("\n");
  for (const issue of report.issues) {
    process.stdout.write(`${issue.path} | ${issue.code} | ${issue.detail}\n`);
  }
}
