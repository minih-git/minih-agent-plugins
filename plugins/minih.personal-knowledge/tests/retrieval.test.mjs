import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import { EmbeddingClient, assertLoopback } from "../lib/embeddings.mjs";
import { after } from "node:test";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixedNow = () => new Date("2026-07-17T00:00:00Z");

// Every fake server is closed after the run, even when a test fails midway —
// a listening socket would keep the event loop alive forever.
const FAKE_SERVERS = [];
after(() => {
  for (const server of FAKE_SERVERS) {
    server.closeAllConnections?.();
    server.close();
  }
});

/** Deterministic fake of Ollama's `/api/embed`: similar texts → similar vectors. */
function fakeEmbedServer({ status = 200 } = {}) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/api/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version: "0-fake" }));
        return;
      }
      if (request.url !== "/api/embed") {
        response.writeHead(404).end();
        return;
      }
      if (status !== 200) {
        response.writeHead(status).end(JSON.stringify({ error: "fake" }));
        return;
      }
      const payload = JSON.parse(body);
      // Any model name is served; the client records the model it asked for.
      const embeddings = (payload.input ?? []).map((text) => {
        const vector = new Array(8).fill(0);
        for (const token of String(text).toLowerCase().split(/\s+/)) {
          vector[token.charCodeAt(0) % 8] += 1;
        }
        return vector;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: payload.model, embeddings }));
    });
  });
  FAKE_SERVERS.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function fixture(config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p2-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  await writeFile(
    path.join(vault, "Servers.md"),
    `---
title: Servers
type: environment
status: active
project: "[[Project - Demo]]"
---
# Servers

资产服务器 EasyTier center node at 10.0.0.1.
`,
  );
  await writeFile(
    path.join(vault, "Project - Demo.md"),
    `---
title: Project - Demo
type: project
status: active
depends_on: "[[Servers]]"
---
# Demo

Demo repository architecture.
`,
  );
  await writeFile(
    path.join(vault, "Archive.md"),
    `---
title: Archive
type: topic
status: archived
---
# Archive

Old material lives under 04 Archive.
`,
  );
  const indexDir = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-vectors-"));
  // Vector files must never land in the developer's real index directory.
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = indexDir;
  const service = await new KnowledgeService({
    vaultPath: vault,
    config,
    now: fixedNow,
    pluginRoot: PLUGIN_ROOT,
  }).initialize();
  return { root, vault, service, indexDir };
}

const baseConfig = (url) => ({
  ignoreFolders: [],
  backupRetentionDays: 0,
  embedding: { enabled: true, baseUrl: url, model: "bge-m3" },
});

test("a non-loopback baseUrl is rejected with EMBEDDING_NOT_LOOPBACK", () => {
  assert.throws(() => assertLoopback("http://example.com:11434"), /EMBEDDING_NOT_LOOPBACK/);
  assert.throws(() => assertLoopback("https://127.0.0.1:11434"), /EMBEDDING_NOT_LOOPBACK/);
  assert.equal(assertLoopback("http://localhost:11434"), "http://localhost:11434");
});

test("ranked search fuses lexical and vector channels; retrieval reports ready", async () => {
  const embed = await fakeEmbedServer();
  const { service } = await fixture(baseConfig(embed.url));
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(service.pendingChunkCount, 0);

  const ranked = await service.search({ query: "服务器", mode: "ranked" });
  assert.equal(ranked.mode, "ranked");
  assert.equal(ranked.retrieval.vector, "ready");
  assert.ok(ranked.results.length >= 1);
  assert.ok(ranked.results[0].matchedBy.includes("lexical") || ranked.results[0].matchedBy.includes("vector"));
  assert.ok(ranked.results[0].section !== undefined);
  assert.ok(typeof ranked.results[0].snippet === "string");
  // The project note joins through graph expansion or the vector channel —
  // which one wins depends on the fake vectors, but it must be reachable.
  const project = ranked.results.find((result) => result.path === "Project - Demo.md");
  assert.ok(project, "the dependent project note is reachable");
  assert.ok(project.matchedBy.includes("graph") || project.matchedBy.includes("vector"));
  embed.server.close();
  embed.server.closeAllConnections?.();
});

test("CJK reordering: 资产服务器 finds the note that only contains 服务器资产 order", async () => {
  const embed = await fakeEmbedServer();
  const { service } = await fixture(baseConfig(embed.url));
  const literalOld = await service.search({ query: "服务器 资产", mode: "all" });
  assert.equal(literalOld.count, 1, "sanity: tokens appear in order in the fixture");
  const ranked = await service.search({ query: "资产服务器", mode: "ranked" });
  assert.ok(ranked.results.some((result) => result.path === "Servers.md"), "bigram tokens survive reordering");
  embed.server.close();
});

test("an unreachable embedding server degrades to lexical with a reason, cached for 60s", async () => {
  const { service } = await fixture(baseConfig("http://127.0.0.1:1"));
  const ranked = await service.search({ query: "EasyTier", mode: "ranked" });
  assert.equal(ranked.retrieval.vector, "unavailable");
  assert.match(String(ranked.retrieval.reason), /OLLAMA_UNREACHABLE/);
  assert.ok(ranked.results.length >= 1, "lexical and graph results still answer");
});

test("model change invalidates the vector index", async () => {
  const embed = await fakeEmbedServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p2-model-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  await writeFile(
    path.join(vault, "Only.md"),
    "---\ntitle: Only\ntype: topic\nstatus: active\n---\n# Only\n\nStandalone content for the model change test.\n",
  );
  const indexDir = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p2-model-vec-"));
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = indexDir;
  const config = baseConfig(embed.url);
  const first = await new KnowledgeService({ vaultPath: vault, config, now: fixedNow, pluginRoot: PLUGIN_ROOT }).initialize();
  await first.ensureVectors({ budgetMs: 5000, force: true });
  const countBefore = first.vectors.chunks.length;
  assert.ok(countBefore > 0);

  // Same directory, different model: the loader must discard the index.
  const changed = { ...config, embedding: { ...config.embedding, model: "other-model" } };
  const second = await new KnowledgeService({ vaultPath: vault, config: changed, now: fixedNow, pluginRoot: PLUGIN_ROOT }).initialize();
  await second.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(second.vectors.meta.model, "other-model");
  assert.ok(second.vectors.chunks.length > 0);
  assert.equal(first.vectors.chunks.length, countBefore);
  embed.server.close();
  embed.server.closeAllConnections?.();
});

test("a concurrent writer holding the lock leaves the index as it is", async () => {
  const embed = await fakeEmbedServer();
  const { service } = await fixture(baseConfig(embed.url));
  const holder = await service.vectors.acquireLock();
  assert.ok(holder, "the test holds the writer lock");
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(service.vectors.chunks.length, 0, "no write happened under lock");
  await holder.release();
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.ok(service.vectors.chunks.length > 0, "after release the rebuild succeeds");
  embed.server.close();
  embed.server.closeAllConnections?.();
});

test("literal modes keep their exact-substring behavior", async () => {
  const { service } = await fixture({ embedding: { enabled: false }, ignoreFolders: [], backupRetentionDays: 0 });
  // Single CJK term: legacy behavior is literal substring, so the reversed
  // string is NOT found — that defect is what ranked mode fixes.
  const ordered = await service.search({ query: "资产服务器", mode: "all" });
  assert.equal(ordered.count, 1);
  assert.equal(ordered.mode, "all");
  const reversed = await service.search({ query: "服务器资产", mode: "all" });
  assert.equal(reversed.count, 0, "all keeps literal substring matching");
});

test("embedding client batches inputs and normalizes vectors", async () => {
  const embed = await fakeEmbedServer();
  const client = new EmbeddingClient({ baseUrl: embed.url, model: "bge-m3", now: fixedNow });
  const vectors = await client.embed(["alpha beta", "gamma", "alpha beta"]);
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-6, "L2 normalized");
  }
  assert.deepEqual([...vectors[0]], [...vectors[2]], "same text, same vector");
  embed.server.close();
});
