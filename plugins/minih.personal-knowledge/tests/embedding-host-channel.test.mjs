import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

/**
 * Host embeddings through the real plugin backend (ADR 0003): the MCP server
 * cannot reach `pi`, so the main process owns the calls. These tests drive
 * `main.js` with a fake host API and a fake vault; no model is called and no
 * real knowledge base is touched.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = (await import("node:module")).createRequire(import.meta.url);

async function makeBackend({ embeddings = null, models = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-host-embed-"));
  const vault = path.join(root, "Knowledge");
  const dataPath = path.join(root, "data");
  await mkdir(vault, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  await writeFile(path.join(vault, "Note.md"), "---\ntitle: Note\ntype: topic\n---\n# Note\n\nSome text about the deploy pipeline.\n");
  await writeFile(
    path.join(root, "repo-map.json"),
    JSON.stringify({ vaultPath: vault, ignoreFolders: [], backupRetentionDays: 0 }),
  );
  process.env.PERSONAL_KNOWLEDGE_CONFIG = path.join(root, "repo-map.json");
  process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = path.join(root, "index");
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = path.join(root, "embedding.json");
  delete process.env.PERSONAL_KNOWLEDGE_READ_ONLY;

  const calls = [];
  globalThis.pi = {
    plugin: { getDataPath: async () => dataPath },
    ...(embeddings
      ? {
          embeddings: {
            embed: async (input) => {
              calls.push(input);
              return embeddings(input);
            },
          },
        }
      : {}),
    ...(models ? { models: { list: models } } : {}),
  };
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PLUGIN_ROOT)) delete require.cache[key];
  }
  const backend = require(path.join(PLUGIN_ROOT, "main.js"));
  await backend.onLoad();
  return { backend, vault, root, calls, dataPath };
}

const HOST = { enabled: true, provider: "host", modelKey: "minih-router/text-embedding-3-small", exclude: [] };

test("a host configuration round-trips through the settings channel", async () => {
  const { backend, root } = await makeBackend();
  const saved = await backend.onPanelInvoke("kg.settings.set", { embedding: HOST });
  assert.equal(saved.settings.provider, "host");
  assert.equal(saved.settings.modelKey, "minih-router/text-embedding-3-small");
  const onDisk = JSON.parse(await readFile(path.join(root, "embedding.json"), "utf8"));
  assert.equal(onDisk.provider, "host");
  assert.equal(onDisk.modelKey, "minih-router/text-embedding-3-small");
  assert.equal(onDisk.apiKeyEnv, "", "a host model never stores a key variable");

  const got = await backend.onPanelInvoke("kg.settings.get", {});
  assert.equal(got.settings.provider, "host");
  assert.equal(got.apiKeyStatus, "not-required", "no key is involved in host mode");
  await backend.onUnload();
});

test("the panel lists the app's embedding models, and says when there are none", async () => {
  const withModels = await makeBackend({
    embeddings: async (input) => ({ vectors: input.texts.map(() => [1, 0]), modelKey: input.modelKey, dims: 2 }),
    models: async (input) => {
      assert.deepEqual(input, { kind: "embedding" }, "the panel asks for embedding models only");
      return [
        { key: "minih-router/embed-small", label: "embed-small", providerName: "Minih Router", kind: "embedding" },
        { key: "minih-router/chat", label: "chat", providerName: "Minih Router", kind: "chat" },
      ];
    },
  });
  const listed = await withModels.backend.onPanelInvoke("kg.models.listEmbedding", {});
  assert.equal(listed.hostSupported, true);
  assert.deepEqual(listed.models.map((model) => model.key), ["minih-router/embed-small"]);
  assert.equal(listed.models[0].providerName, "Minih Router");
  await withModels.backend.onUnload();

  const withoutModels = await makeBackend({
    embeddings: async (input) => ({ vectors: input.texts.map(() => [1, 0]), modelKey: input.modelKey, dims: 2 }),
    models: async () => [],
  });
  const empty = await withoutModels.backend.onPanelInvoke("kg.models.listEmbedding", {});
  assert.deepEqual(empty.models, []);
  assert.equal(empty.hostSupported, true);
  await withoutModels.backend.onUnload();
});

test("an old host that has no pi.embeddings reports support as false", async () => {
  const { backend } = await makeBackend();
  const answer = await backend.onPanelInvoke("kg.models.listEmbedding", {});
  assert.equal(answer.hostSupported, false);
  assert.deepEqual(answer.models, []);
  await backend.onUnload();
});

test("testing a host model calls pi.embeddings and reports dimensions", async () => {
  const { backend, calls } = await makeBackend({
    embeddings: async (input) => ({ vectors: input.texts.map(() => [1, 2, 3]), modelKey: input.modelKey, dims: 3 }),
  });
  const result = await backend.onPanelInvoke("kg.settings.test", { embedding: HOST });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dims, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelKey, "minih-router/text-embedding-3-small");
  await backend.onUnload();
});

test("a host rejection is reported as a mapped reason, never as a raw host crash", async () => {
  const { backend } = await makeBackend({
    embeddings: async () => {
      throw Object.assign(new Error("not an embedding model"), { code: "MODEL_NOT_EMBEDDING" });
    },
  });
  const result = await backend.onPanelInvoke("kg.settings.test", { embedding: HOST });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "MODEL_NOT_EMBEDDING");
  await backend.onUnload();
});

test("the shared index counts what still needs a vector without embedding", async () => {
  const { backend, calls } = await makeBackend({
    embeddings: async (input) => ({ vectors: input.texts.map(() => [1, 0]), modelKey: input.modelKey, dims: 2 }),
  });
  await backend.onPanelInvoke("kg.settings.set", { embedding: HOST });
  // Loading the panel service is what the index-status channel does.
  const status = await backend.onPanelInvoke("kg.index.status", {});
  assert.equal(typeof status.pending, "number");
  assert.ok(calls.length <= 1, "a status read may embed in the background, but does not loop");
  await backend.onUnload();
});
