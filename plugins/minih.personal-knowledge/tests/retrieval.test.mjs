import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import {
  EmbeddingClient,
  validateEmbeddingSettings,
} from "../lib/embeddings.mjs";
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

/**
 * Fake embedding endpoint for both providers.
 * - `ollama`: `/api/version` probe + `/api/embed` with `{ embeddings }`.
 * - `openai-compatible`: `/embeddings` with `{ data: [{ index, embedding }] }`
 *   and Bearer auth when `key` is set.
 * `status` forces that HTTP status. `requests` records method-level facts
 * (URL, auth header, input texts) for assertions.
 */
function fakeEmbedServer({ provider = "ollama", status = 200, key = null } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const auth = request.headers.authorization ?? "";
      let input = [];
      try {
        input = JSON.parse(body || "{}").input ?? [];
      } catch {
        input = [];
      }
      requests.push({ url: request.url, auth, input });
      if (provider === "ollama" && request.url === "/api/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version: "0-fake" }));
        return;
      }
      const embedPath = provider === "ollama" ? "/api/embed" : "/embeddings";
      if (request.url !== embedPath) {
        response.writeHead(404).end();
        return;
      }
      if (key !== null && auth !== `Bearer ${key}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid api key" }));
        return;
      }
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `forced ${status}` }));
        return;
      }
      const embeddings = input.map((text) => {
        const vector = new Array(8).fill(0);
        for (const token of String(text).toLowerCase().split(/\s+/)) {
          vector[token.charCodeAt(0) % 8] += 1;
        }
        return vector;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        provider === "ollama"
          ? JSON.stringify({ model: "fake", embeddings })
          : JSON.stringify({
              model: "fake",
              data: embeddings.map((embedding, index) => ({ index, embedding })),
            }),
      );
    });
  });
  FAKE_SERVERS.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, requests }),
    );
  });
}

async function fixture(settings, vaultFiles) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p2-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  for (const [name, content] of Object.entries(vaultFiles ?? {})) {
    const absolute = path.join(vault, name);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  // Embedding settings come only from embedding.json (ADR §6.1). Passing
  // `undefined` simulates a missing file, which means the local defaults.
  const settingsPath = path.join(root, "embedding.json");
  if (settings !== undefined) {
    await writeFile(settingsPath, `${JSON.stringify(settings)}\n`);
  }
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = settingsPath;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-vec-"));
  const service = await new KnowledgeService({
    vaultPath: vault,
    config: { ignoreFolders: [], backupRetentionDays: 0 },
    now: fixedNow,
    pluginRoot: PLUGIN_ROOT,
  }).initialize();
  return { root, vault, service, settingsPath };
}

const SERVER_NOTE = `---
title: Servers
type: environment
status: active
project: "[[Project - Demo]]"
---
# Servers

资产服务器 EasyTier center node at 10.0.0.1.
`;
const DEMO_NOTE = `---
title: Project - Demo
type: project
status: active
depends_on: "[[Servers]]"
---
# Demo

Demo repository architecture.
`;

const ollamaSettings = (url) => ({ enabled: true, provider: "ollama", baseUrl: url, model: "bge-m3" });
const openaiSettings = (url, extra = {}) => ({
  enabled: true,
  provider: "openai-compatible",
  baseUrl: url,
  model: "text-embed-3",
  apiKeyEnv: "PK_TEST_KEY",
  ...extra,
});

test("settings validation: remote needs the switch and https; rules name the field", () => {
  assert.throws(
    () => validateEmbeddingSettings({ baseUrl: "https://api.example.com/v1" }),
    (error) => error.code === "EMBEDDING_NOT_LOOPBACK" && /allowRemote/.test(error.message),
  );
  assert.throws(
    () => validateEmbeddingSettings({ baseUrl: "http://api.example.com/v1", allowRemote: true }),
    (error) => error.code === "EMBEDDING_INSECURE_URL",
  );
  const remote = validateEmbeddingSettings({ baseUrl: "https://api.example.com/v1", allowRemote: true, apiKeyEnv: "MY_KEY" });
  assert.equal(remote.allowRemote, true);
  assert.equal(remote.baseUrl, "https://api.example.com/v1");
  assert.throws(
    () => validateEmbeddingSettings({ apiKeyEnv: "lower-case" }),
    (error) => error.code === "EMBEDDING_CONFIG_INVALID" && /apiKeyEnv/.test(error.message),
  );
  assert.throws(
    () => validateEmbeddingSettings({ exclude: ["../outside"] }),
    (error) => error.code === "EMBEDDING_CONFIG_INVALID" && /exclude/.test(error.message),
  );
  assert.throws(
    () => validateEmbeddingSettings({ provider: "vertex" }),
    (error) => error.code === "EMBEDDING_CONFIG_INVALID" && /provider/.test(error.message),
  );
});

test("a missing embedding.json behaves exactly like the local default", async () => {
  const { service } = await fixture(undefined, { "A.md": DEMO_NOTE });
  assert.equal(service.embedding.settings.provider, "ollama");
  assert.equal(service.embedding.settings.baseUrl, "http://127.0.0.1:11434");
  assert.equal(service.embedding.settings.allowRemote, false);
  assert.deepEqual(service.embeddingSettings.exclude, []);
});

test("ranked search fuses lexical and vector channels; retrieval reports ready", async () => {
  const embed = await fakeEmbedServer({ provider: "ollama" });
  const { service } = await fixture(ollamaSettings(embed.url), {
    "Servers.md": SERVER_NOTE,
    "Project - Demo.md": DEMO_NOTE,
  });
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(service.pendingChunkCount, 0);

  const ranked = await service.search({ query: "服务器", mode: "ranked" });
  assert.equal(ranked.mode, "ranked");
  assert.equal(ranked.retrieval.vector, "ready");
  assert.ok(ranked.results.length >= 1);
  const project = ranked.results.find((result) => result.path === "Project - Demo.md");
  assert.ok(project, "the dependent project note is reachable");
  assert.ok(project.matchedBy.includes("graph") || project.matchedBy.includes("vector"));
});

test("CJK reordering: 资产服务器 finds the note in ranked mode, not in all mode", async () => {
  const embed = await fakeEmbedServer({ provider: "ollama" });
  const { service } = await fixture(ollamaSettings(embed.url), { "Servers.md": SERVER_NOTE });
  const literal = await service.search({ query: "服务器资产", mode: "all" });
  assert.equal(literal.count, 0, "all keeps literal substring matching");
  const ranked = await service.search({ query: "资产服务器", mode: "ranked" });
  assert.ok(ranked.results.some((result) => result.path === "Servers.md"));
});

test("an unreachable local server degrades to lexical with OLLAMA_UNREACHABLE", async () => {
  const { service } = await fixture(ollamaSettings("http://127.0.0.1:1"), { "Servers.md": SERVER_NOTE });
  const ranked = await service.search({ query: "EasyTier", mode: "ranked" });
  assert.equal(ranked.retrieval.vector, "unavailable");
  assert.match(String(ranked.retrieval.reason), /OLLAMA_UNREACHABLE/);
  assert.ok(ranked.results.length >= 1);
});

test("openai-compatible: Bearer key is sent, status maps to reason codes, key never leaks", async () => {
  const embed = await fakeEmbedServer({ provider: "openai-compatible", key: "sk-test-1234567890" });
  process.env.PK_TEST_KEY = "sk-test-1234567890";
  try {
    const { service } = await fixture(openaiSettings(embed.url), { "Servers.md": SERVER_NOTE });
    await service.ensureVectors({ budgetMs: 5000, force: true });
    assert.equal(service.pendingChunkCount, 0);
    assert.ok(embed.requests.some((request) => request.auth === "Bearer sk-test-1234567890"));
    assert.equal(service.vectors.meta.identity.startsWith("openai-compatible|"), true);

    // 404 → MODEL_MISSING, 429 → EMBEDDING_RATE_LIMITED; the stored reason
    // never carries the key value or note text.
    for (const [status, code] of [[404, "MODEL_MISSING"], [429, "EMBEDDING_RATE_LIMITED"]]) {
      const failing = await fakeEmbedServer({ provider: "openai-compatible", key: "sk-test-1234567890", status });
      const { service: failingService } = await fixture(openaiSettings(failing.url), { "Servers.md": SERVER_NOTE });
      await failingService.ensureVectors({ budgetMs: 5000, force: true });
      assert.equal(failingService.vectorReason, code);
      assert.ok(!String(failingService.vectorReason).includes("sk-test-1234567890"));
    }
  } finally {
    delete process.env.PK_TEST_KEY;
  }

  // 401 from a wrong key → EMBEDDING_AUTH_FAILED, again without the key.
  const authFail = await fakeEmbedServer({ provider: "openai-compatible", key: "sk-correct-key" });
  const { service: authService } = await fixture(openaiSettings(authFail.url), { "Servers.md": SERVER_NOTE });
  process.env.PK_TEST_KEY = "sk-wrong-key";
  try {
    await authService.ensureVectors({ budgetMs: 5000, force: true });
    assert.equal(authService.vectorReason, "EMBEDDING_AUTH_FAILED");
    assert.ok(!String(authService.vectorReason).includes("sk-wrong-key"));
  } finally {
    delete process.env.PK_TEST_KEY;
  }
});

test("a provider identity change invalidates the vector index", async () => {
  const embed = await fakeEmbedServer({ provider: "ollama" });
  const { root, vault, service, settingsPath } = await fixture(ollamaSettings(embed.url), {
    "Only.md": "---\ntitle: Only\ntype: topic\nstatus: active\n---\n# Only\n\nStandalone content.\n",
  });
  await service.ensureVectors({ budgetMs: 5000, force: true });
  const identityBefore = service.vectors.meta.identity;
  assert.ok(service.vectors.chunks.length > 0);

  // Same vault, new model in embedding.json: the identity changes and the
  // stored vectors are rebuilt under the new identity.
  await writeFile(settingsPath, `${JSON.stringify({ ...ollamaSettings(embed.url), model: "other-model" })}\n`);
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(service.vectors.meta.identity.startsWith("ollama|"), true);
  assert.notEqual(service.vectors.meta.identity, identityBefore);
  assert.ok(service.vectors.chunks.length > 0);
  void root; void vault;
});

test("excluded folders are never sent to the embedder", async () => {
  const embed = await fakeEmbedServer({ provider: "ollama" });
  const { service } = await fixture(
    { ...ollamaSettings(embed.url), exclude: ["03 Private"] },
    {
      "Open.md": DEMO_NOTE,
      "03 Private/Secrets.md": "---\ntitle: Secrets\ntype: topic\nstatus: active\n---\n# Secrets\n\nCLASSIFIED-MARKER-12345\n",
    },
  );
  await service.ensureVectors({ budgetMs: 5000, force: true });
  const sent = embed.requests.flatMap((request) => request.input).join("\n");
  assert.ok(!sent.includes("CLASSIFIED-MARKER-12345"), "excluded note text must not reach the endpoint");
  assert.ok(service.vectors.chunks.every((row) => !row.path.startsWith("03 Private")));
  // Lexical search still covers the excluded folder.
  const literal = await service.search({ query: "CLASSIFIED-MARKER-12345", mode: "all" });
  assert.equal(literal.count, 1);
});

test("editing embedding.json hot-reloads without a restart", async () => {
  const embed = await fakeEmbedServer({ provider: "ollama" });
  const { service, settingsPath } = await fixture({ enabled: false }, { "Only.md": DEMO_NOTE });
  assert.equal(service.embedding, null);
  const ranked1 = await service.search({ query: "Demo", mode: "ranked" });
  assert.equal(ranked1.retrieval.vector, "disabled");

  await writeFile(settingsPath, `${JSON.stringify(ollamaSettings(embed.url))}\n`);
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(service.embedding.settings.provider, "ollama");
  assert.ok(service.vectors.chunks.length > 0);
  const ranked2 = await service.search({ query: "Demo", mode: "ranked" });
  assert.equal(ranked2.retrieval.vector, "ready");
});

test("a concurrent writer holding the lock leaves the index as it is", async () => {
  const embed = await fakeEmbedServer({ provider: "ollama" });
  const { service } = await fixture(ollamaSettings(embed.url), { "Only.md": DEMO_NOTE });
  const holder = await service.vectors.acquireLock();
  assert.ok(holder, "the test holds the writer lock");
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.equal(service.vectors.chunks.length, 0, "no write happened under lock");
  await holder.release();
  await service.ensureVectors({ budgetMs: 5000, force: true });
  assert.ok(service.vectors.chunks.length > 0, "after release the rebuild succeeds");
});

test("literal modes keep their exact-substring behavior", async () => {
  const { service } = await fixture({ enabled: false }, { "Servers.md": SERVER_NOTE });
  const ordered = await service.search({ query: "资产服务器", mode: "all" });
  assert.equal(ordered.count, 1);
  assert.equal(ordered.mode, "all");
  const reversed = await service.search({ query: "服务器资产", mode: "all" });
  assert.equal(reversed.count, 0, "all keeps literal substring matching");
});

test("embedding client batches inputs, normalizes vectors, and records dims for both providers", async () => {
  for (const provider of ["ollama", "openai-compatible"]) {
    const embed = await fakeEmbedServer({ provider, key: provider === "openai-compatible" ? "k" : null });
    const client = new EmbeddingClient({
      settings: provider === "ollama"
        ? ollamaSettings(embed.url)
        : { ...openaiSettings(embed.url), apiKeyEnv: "PK_ANY" },
      apiKey: provider === "openai-compatible" ? "k" : null,
      now: fixedNow,
    });
    const vectors = await client.embed(["alpha beta", "gamma", "alpha beta"]);
    assert.equal(vectors.length, 3);
    for (const vector of vectors) {
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(magnitude - 1) < 1e-6, "L2 normalized");
    }
    assert.deepEqual([...vectors[0]], [...vectors[2]], "same text, same vector");
    assert.equal(client.dims, 8);
  }
});
