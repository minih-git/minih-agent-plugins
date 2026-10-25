import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedHome } from "./helpers/home.mjs";
// Keep every fixture away from the real ~/.personal-knowledge (see helpers/home.mjs).
await isolatedHome();

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_PARENT = path.resolve(PLUGIN_ROOT, "..");

/** A vault whose notes chunk deterministically: `chunks` headings per note. */
async function fixtureVault({ notes = 4, chunksPerNote = 12 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-vecfix-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  for (let n = 0; n < notes; n += 1) {
    const sections = [];
    for (let c = 0; c < chunksPerNote; c += 1) {
      sections.push(`## 第 ${n}-${c} 节\n\n内容 ${n}-${c}：向量索引恢复测试用的填充段落。\n`);
    }
    await writeFile(
      path.join(vault, `Note ${n}.md`),
      `---\ntitle: Note ${n}\ntype: topic\nstatus: active\n---\n# Note ${n}\n\n${sections.join("\n")}\n`,
    );
  }
  return vault;
}

function writeEmbeddingSettings({ enabled = true } = {}) {
  // PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG points at the file itself.
  const file = process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG;
  return writeFile(
    file,
    `${JSON.stringify(
      {
        enabled,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:9",
        model: "fake-embedding",
        allowRemote: false,
        apiKeyEnv: "",
        exclude: [],
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Replace the network client with a deterministic fake. Returns a handle:
 * `calls` counts embed() invocations, `texts` records every batch size, and
 * `failFrom` (batch index) makes embed throw from that call on.
 */
async function installFakeEmbeddingClient({ delayMs = 0, failFrom = null, dims = 4 } = {}) {
  const { EmbeddingClient } = await import("../lib/embeddings.mjs");
  const original = {
    embed: EmbeddingClient.prototype.embed,
    probe: EmbeddingClient.prototype.probe,
  };
  const handle = { calls: 0, texts: [], dims, failFrom };
  EmbeddingClient.prototype.probe = async function probe() {};
  EmbeddingClient.prototype.embed = async function embed(texts) {
    if (handle.failFrom !== null && handle.calls >= handle.failFrom) {
      const error = new Error("fake embed failure");
      error.code = "EMBED_FAILED";
      throw error;
    }
    handle.calls += 1;
    handle.texts.push(texts.length);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return texts.map((text) => {
      const vector = new Float32Array(dims);
      for (let i = 0; i < dims; i += 1) vector[i] = ((text.length + i) % 7) / 7;
      return vector;
    });
  };
  return {
    handle,
    restore() {
      EmbeddingClient.prototype.embed = original.embed;
      EmbeddingClient.prototype.probe = original.probe;
    },
  };
}

async function freshIndexDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-vecfix-index-"));
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = dir;
  return dir;
}

async function readMeta(indexDir) {
  return JSON.parse(await readFile(path.join(indexDir, "meta.json"), "utf8"));
}

async function makeService(vault) {
  const { createKnowledgeService } = await import("../mcp/knowledge-core.mjs");
  return createKnowledgeService({ pluginRoot: PLUGIN_ROOT, vaultPath: vault, config: {} });
}

test("a finished index reloads without a single embed request", async () => {
  const vault = await fixtureVault();
  const indexDir = await freshIndexDir();
  await writeEmbeddingSettings();
  const fake = await installFakeEmbeddingClient();
  try {
    const first = await makeService(vault);
    await first.ensureVectors({ budgetMs: 60_000, force: true });
    const n = first.vectors.chunks.length;
    assert.ok(n > 32, `fixture must exceed one batch, got ${n}`);
    assert.equal((await readMeta(indexDir)).count, n);

    fake.handle.calls = 0;
    // A second process worth of state: fresh service over the same index dir.
    const second = await makeService(vault);
    // The constructor's 3-second kick settles with nothing to do.
    await second.ensureVectors({ budgetMs: 60_000, force: false });
    assert.equal(second.vectors.chunks.length, n, "the full index must reload from disk");
    assert.equal(fake.handle.calls, 0, `reload must not embed (old code re-embedded ${fake.handle.calls} batches)`);
    assert.equal((await readMeta(indexDir)).count, n, "disk count must not change across a reload");
    assert.equal(second.pendingChunkCount, 0);
  } finally {
    fake.restore();
  }
});

test("a failed load never shrinks a same-identity index on disk", async () => {
  const vault = await fixtureVault();
  const indexDir = await freshIndexDir();
  await writeEmbeddingSettings();
  const fake = await installFakeEmbeddingClient();
  const { VectorIndex } = await import("../lib/vector-index.mjs");
  const originalLoad = VectorIndex.prototype.load;
  try {
    const first = await makeService(vault);
    await first.ensureVectors({ budgetMs: 60_000, force: true });
    const n = first.vectors.chunks.length;
    // From now on the second batch fails: the next pass ends with 32 of N
    // rows — exactly the shrink the guard must refuse.
    fake.handle.failFrom = 1;
    fake.handle.calls = 0;
    // Simulate the load failing (I/O hiccup) for the second service only.
    VectorIndex.prototype.load = async () => false;

    const second = await makeService(vault);
    // The constructor kick embeds one batch, the next batch fails, and the
    // pass ends holding a strict subset of N — the shrink that must not
    // reach the disk.
    await second.ensureVectors({ budgetMs: 3000, force: false });
    const meta = await readMeta(indexDir);
    assert.equal(meta.count, n, `disk count must not shrink (old code wrote ${meta.count} of ${n})`);
    assert.equal(second.vectorReason, "INDEX_LOAD_FAILED", "the refused save must be observable");
  } finally {
    VectorIndex.prototype.load = originalLoad;
    fake.restore();
  }
});

test("embedding runs in EMBED_BATCH batches and keeps successes before a failure", async () => {
  const vault = await fixtureVault({ notes: 4, chunksPerNote: 18 });
  const indexDir = await freshIndexDir();
  await writeEmbeddingSettings();
  // Fail from the third batch call: two full batches must survive on disk.
  const fake = await installFakeEmbeddingClient({ failFrom: 2 });
  try {
    const service = await makeService(vault);
    await service.ensureVectors({ budgetMs: 60_000, force: true });
    assert.equal(fake.handle.calls, 2, `embed call count must equal batch count (old code made ${fake.handle.calls} single-chunk calls)`);
    assert.deepEqual(fake.handle.texts, [32, 32], "batch sizes follow EMBED_BATCH");
    const meta = await readMeta(indexDir);
    assert.equal(meta.count, 64, "rows from successful batches must be saved before the failure");
    assert.ok(service.pendingChunkCount > 0, "the tail batches stay pending");
    assert.equal(service.vectorReason, "EMBED_FAILED", "the failing batch must be observable");
  } finally {
    fake.restore();
  }
});
