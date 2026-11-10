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

/**
 * The path an agent actually takes in `host` mode: the main process registers
 * `knowledge_search` / `conversation_search`, and the query vector is computed
 * with `pi.embeddings.embed` there. The vectors below are deterministic and
 * orthogonal, so the ranking can only come from the vector channel.
 */
function fakeAgentApi() {
  const tools = new Map();
  return {
    tools,
    agent: {
      registerTool: async (tool) => {
        tools.set(tool.name, tool);
      },
      unregisterTool: async (name) => {
        tools.delete(name);
      },
    },
  };
}

async function makeToolBackend({ settings = HOST, vaultNotes = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-host-tool-"));
  const vault = path.join(root, "Knowledge");
  const dataPath = path.join(root, "data");
  await mkdir(vault, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  // Two notes whose *lexical* text never mentions the query; only their
  // vectors can put either of them in the result set.
  await writeFile(
    path.join(vault, "Alpha.md"),
    "---\ntitle: Alpha\ntype: topic\n---\n# Alpha\n\nQuarterly revenue discussion.\n",
  );
  await writeFile(
    path.join(vault, "Beta.md"),
    "---\ntitle: Beta\ntype: topic\n---\n# Beta\n\nUnrelated garden notes.\n",
  );
  for (const [name, text] of Object.entries(vaultNotes ?? {})) {
    await writeFile(path.join(vault, `${name}.md`), `---\ntitle: ${name}\ntype: topic\n---\n# ${name}\n\n${text}\n`);
  }
  await writeFile(
    path.join(root, "repo-map.json"),
    JSON.stringify({ vaultPath: vault, ignoreFolders: [], backupRetentionDays: 0 }),
  );
  process.env.PERSONAL_KNOWLEDGE_CONFIG = path.join(root, "repo-map.json");
  process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = path.join(root, "index");
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = path.join(root, "embedding.json");
  delete process.env.PERSONAL_KNOWLEDGE_READ_ONLY;
  await writeFile(path.join(root, "embedding.json"), JSON.stringify(settings));

  const api = fakeAgentApi();
  const embedCalls = [];
  // Alpha points at [1,0], Beta at [0,1]; the query points at Alpha.
  globalThis.pi = {
    plugin: { getDataPath: async () => dataPath },
    agent: api.agent,
    embeddings: {
      embed: async (input) => {
        embedCalls.push(input);
        const vectors = input.texts.map((text) => {
          if (/quarterly revenue/i.test(text)) return [1, 0];
          if (/garden notes/i.test(text)) return [0, 1];
          return [1, 0]; // "takings": the query, and anything neutral
        });
        return { vectors, modelKey: input.modelKey, dims: 2 };
      },
    },
  };
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PLUGIN_ROOT)) delete require.cache[key];
  }
  const backend = require(path.join(PLUGIN_ROOT, "main.js"));
  await backend.onLoad();
  return { backend, vault, root, api, embedCalls };
}

test("in host mode the agent's knowledge_search gets a vector hit", async () => {
  const { backend, api, embedCalls } = await makeToolBackend();
  const tool = api.tools.get("knowledge_search");
  assert.ok(tool, "the main process registers knowledge_search in host mode");
  assert.equal(api.tools.has("conversation_search"), true);

  // The query shares no words with either note: only the vector channel can
  // return anything, and only if this process embeds the query itself.
  // Build the note vectors the way the panel's rebuild does, then wait for
  // that background run to finish.
  await backend.onPanelInvoke("kg.index.rebuild", { mode: "incremental" });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await backend.onPanelInvoke("kg.index.status", {});
    if (!status.running && status.stored > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // "takings" appears in no note: the lexical channel finds nothing, so the
  // answer can only come from a vector.
  const answer = await tool.execute({ query: "takings" });
  assert.match(answer, /Alpha\.md/, `expected a vector hit, got: ${answer}`);
  assert.ok(
    embedCalls.some((call) => call.texts.includes("takings")),
    "the query itself was embedded through pi.embeddings.embed",
  );

  await backend.onUnload();
});

test("the same index answers only when the query vector is supplied", async () => {
  // This mirrors the MCP process in host mode: note vectors exist on disk, but
  // the process holds no `pi.embeddings`, so it can only answer a ranked query
  // if the caller hands it the query vector.
  const { createKnowledgeService } = await import("../mcp/knowledge-core.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-host-query-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  await writeFile(
    path.join(vault, "Alpha.md"),
    "---\ntitle: Alpha\ntype: topic\n---\n# Alpha\n\nQuarterly revenue discussion.\n",
  );
  await writeFile(
    path.join(vault, "Beta.md"),
    "---\ntitle: Beta\ntype: topic\n---\n# Beta\n\nUnrelated garden notes.\n",
  );
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = path.join(root, "index");
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = path.join(root, "embedding.json");
  await writeFile(
    path.join(root, "embedding.json"),
    JSON.stringify({ enabled: true, provider: "host", modelKey: HOST.modelKey, exclude: [] }),
  );
  const embed = async ({ texts }) => ({
    vectors: texts.map((text) => (/garden/i.test(text) ? [0, 1] : [1, 0])),
    modelKey: HOST.modelKey,
    dims: 2,
  });

  // One process builds the index (the plugin main process)…
  const builder = await createKnowledgeService({ vaultPath: vault, config: {}, hostEmbed: embed });
  await builder.ensureVectors({ budgetMs: 60_000, force: true });
  assert.equal(builder.pendingChunkCount, 0, "the note vectors were written");

  // …and another opens the same index with no host API, like the MCP server.
  // `EmbeddingClient` falls back to a global `pi.embeddings` when no function is
  // injected, which is exactly what an MCP child never has.
  const savedPi = globalThis.pi;
  globalThis.pi = { plugin: { getDataPath: async () => root } };
  const mcpSide = await createKnowledgeService({ vaultPath: vault, config: {}, hostEmbed: null });
  const withoutVector = await mcpSide.search({ query: "takings" }, {});
  assert.deepEqual(
    withoutVector.results,
    [],
    "without a query vector this process finds nothing, which is why the tools moved",
  );

  const supplied = await mcpSide.search(
    { query: "takings" },
    { embedQuery: async (text) => (await embed({ texts: [text] })).vectors[0] },
  );
  const alpha = supplied.results.find((item) => item.path === "Alpha.md");
  assert.ok(alpha, `expected Alpha, got ${JSON.stringify(supplied.results)}`);
  assert.ok(alpha.matchedBy.includes("vector"), `expected a vector match, got ${alpha.matchedBy}`);
  globalThis.pi = savedPi;
});

test("leaving host mode removes the main-process tools again", async () => {
  const { backend, api } = await makeToolBackend();
  assert.equal(api.tools.has("knowledge_search"), true);
  await backend.onPanelInvoke("kg.settings.set", {
    embedding: { enabled: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "bge-m3", exclude: [] },
  });
  assert.equal(api.tools.has("knowledge_search"), false, "the MCP server answers again");
  assert.equal(api.tools.has("conversation_search"), false);
  await backend.onUnload();
});

test("unload unregisters the tools so a disabled plugin leaves nothing behind", async () => {
  const { backend, api } = await makeToolBackend();
  await backend.onUnload();
  assert.equal(api.tools.size, 0);
});

test("whoever else owns the tools still answers when host mode is off", async () => {
  const { backend, api } = await makeToolBackend({
    settings: { enabled: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "bge-m3", exclude: [] },
  });
  assert.equal(api.tools.size, 0, "no duplicate tool when the MCP server can embed itself");
  await backend.onUnload();
});
