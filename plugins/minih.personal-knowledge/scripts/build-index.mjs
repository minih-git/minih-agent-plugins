#!/usr/bin/env node
/**
 * Rebuild the whole vector index from the command line (ADR 0001 §6).
 *
 *   node scripts/build-index.mjs
 *
 * Embeds every chunk of redacted text through the configured embedding
 * provider (ADR 0001 §6.1): a local Ollama by default, or a remote
 * openai-compatible endpoint with `allowRemote: true` and https.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createKnowledgeService } from "../mcp/knowledge-core.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const service = await createKnowledgeService({ pluginRoot });
if (!service.embedding) {
  process.stderr.write(
    service.embeddingSettingsError
      ? `embedding settings are invalid: ${service.embeddingSettingsError.message}\n`
      : "the vector channel is disabled in embedding.json; nothing to build.\n",
  );
  process.exit(1);
}
await service.index.refresh({ force: true });
const started = Date.now();
await service.ensureVectors({ budgetMs: Number.POSITIVE_INFINITY, force: true });
const state = {
  provider: service.embedding.settings.provider,
  model: service.embedding.settings.model,
  indexDirectory: service.indexDirectory,
  chunks: service.vectors.chunks.length,
  pending: service.pendingChunkCount,
  reason: service.vectorReason,
  ms: Date.now() - started,
};
process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
if (state.pending > 0 || state.reason) process.exit(1);
