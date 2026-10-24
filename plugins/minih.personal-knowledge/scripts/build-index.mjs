#!/usr/bin/env node
/**
 * Rebuild the whole vector index from the command line (ADR 0001 §6).
 *
 *   node scripts/build-index.mjs
 *
 * Embeds every chunk from redacted text through the loopback embedding server.
 * Requires a reachable Ollama (`embedding.enabled` in the repo-map); refuses
 * non-loopback base URLs at load.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createKnowledgeService } from "../mcp/knowledge-core.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const service = await createKnowledgeService({ pluginRoot });
if (!service.embedding?.enabled) {
  process.stderr.write("embedding.enabled is false in the repo-map; nothing to build.\n");
  process.exit(1);
}
await service.index.refresh({ force: true });
const started = Date.now();
await service.ensureVectors({ budgetMs: Number.POSITIVE_INFINITY, force: true });
const state = {
  model: service.embedding.model,
  indexDirectory: service.indexDirectory,
  chunks: service.vectors.chunks.length,
  pending: service.pendingChunkCount,
  reason: service.vectorReason,
  ms: Date.now() - started,
};
process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
if (state.pending > 0 || state.reason) process.exit(1);
