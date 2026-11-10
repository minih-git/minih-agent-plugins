import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EmbeddingClient,
  HOST_EMBED_BATCH,
  loadEmbeddingSettings,
  mapHostEmbeddingError,
  validateEmbeddingSettings,
} from "../lib/embeddings.mjs";
import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

/**
 * `provider: "host"` (ADR 0003): the vectors come from an embedding model the
 * user configured in Desktop, through `pi.embeddings.embed`. Nothing here
 * touches a real endpoint or a real model.
 */

const HOST_SETTINGS = { provider: "host", modelKey: "minih-router/text-embedding-3-small" };

/** A fake `pi.embeddings.embed` that records every call. */
function fakeHost({ dims = 3, onEmbed = null } = {}) {
  const calls = [];
  return {
    calls,
    embed: async (input) => {
      calls.push(input);
      if (onEmbed) return onEmbed(input, calls.length);
      return {
        vectors: input.texts.map((text, index) => [index + 1, dims, String(text).length]),
        modelKey: input.modelKey,
        dims,
      };
    },
  };
}

test("an old configuration still means the local Ollama model", async () => {
  const settings = validateEmbeddingSettings({
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "bge-m3",
    allowRemote: false,
    apiKeyEnv: "",
    exclude: [],
  });
  assert.equal(settings.provider, "ollama");
  assert.equal(settings.modelKey, "");
  // A file written before this version has no modelKey at all.
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "pk-embed-legacy-")), "embedding.json");
  await (await import("node:fs/promises")).writeFile(
    file,
    JSON.stringify({ enabled: true, provider: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m", allowRemote: true, apiKeyEnv: "", exclude: [] }),
  );
  const loaded = await loadEmbeddingSettings(file);
  assert.equal(loaded.provider, "openai-compatible");
  assert.equal(loaded.modelKey, "");
  assert.equal(loaded.baseUrl, "https://api.example.com/v1");
});

test("the host provider needs a modelKey and ignores endpoint settings", () => {
  const settings = validateEmbeddingSettings({
    ...HOST_SETTINGS,
    baseUrl: "https://ignored.example.com",
    apiKeyEnv: "IGNORED_KEY",
    allowRemote: true,
  });
  assert.equal(settings.provider, "host");
  assert.equal(settings.modelKey, "minih-router/text-embedding-3-small");
  assert.equal(settings.model, "text-embedding-3-small", "the model name follows the key");
  assert.equal(settings.apiKeyEnv, "", "no key is used in host mode");

  assert.throws(() => validateEmbeddingSettings({ provider: "host" }), /modelKey is required/);
  assert.throws(
    () => validateEmbeddingSettings({ provider: "host", modelKey: "not a key" }),
    /modelKey must look like providerId\/modelId/,
  );
});

test("host mode embeds in batches of 64 and normalizes what the app returns", async () => {
  const settings = validateEmbeddingSettings(HOST_SETTINGS);
  const host = fakeHost({ dims: 2 });
  const client = new EmbeddingClient({ settings, hostEmbed: host.embed });
  const texts = Array.from({ length: HOST_EMBED_BATCH + 5 }, (_, index) => `chunk ${index}`);
  const vectors = await client.embed(texts);

  assert.deepEqual(host.calls.map((call) => call.texts.length), [64, 5]);
  assert.ok(host.calls.every((call) => call.modelKey === "minih-router/text-embedding-3-small"));
  assert.equal(vectors.length, texts.length);
  const [a, b] = vectors[0];
  assert.ok(Math.abs(Math.hypot(a, b, vectors[0][2]) - 1) < 1e-9, "vectors are L2-normalized");
  assert.equal(client.dims, 3);
});

test("the index identity names the host model, so switching it rebuilds", () => {
  const first = new EmbeddingClient({ settings: validateEmbeddingSettings(HOST_SETTINGS), hostEmbed: () => {} });
  const second = new EmbeddingClient({
    settings: validateEmbeddingSettings({ provider: "host", modelKey: "other/embed-small" }),
    hostEmbed: () => {},
  });
  assert.equal(first.identityPrefix(), "host:minih-router/text-embedding-3-small|");
  assert.notEqual(first.identityPrefix(), second.identityPrefix());
  // A local model keeps its existing identity shape.
  const local = new EmbeddingClient({ settings: validateEmbeddingSettings({}) });
  assert.equal(local.identityPrefix(), "ollama|http://127.0.0.1:11434|bge-m3|");
});

test("host error codes map onto the reasons the panel already explains", async () => {
  const cases = {
    INVALID_ARGUMENT: "EMBEDDING_CONFIG_INVALID",
    MODEL_NOT_FOUND: "MODEL_MISSING",
    MODEL_NOT_EMBEDDING: "MODEL_NOT_EMBEDDING",
    UNSUPPORTED_PROVIDER: "EMBEDDING_UNSUPPORTED_PROVIDER",
    PROVIDER_UNAUTHORIZED: "EMBEDDING_AUTH_FAILED",
    PROVIDER_RATE_LIMITED: "EMBEDDING_RATE_LIMITED",
    NETWORK_ERROR: "EMBEDDING_UNREACHABLE",
    RATE_LIMITED: "EMBEDDING_RATE_LIMITED",
    TIMEOUT: "EMBED_FAILED",
    SOMETHING_NEW: "EMBED_FAILED",
  };
  for (const [hostCode, expected] of Object.entries(cases)) {
    const mapped = mapHostEmbeddingError(Object.assign(new Error("x"), { code: hostCode }));
    assert.equal(mapped.code, expected, `${hostCode} maps to ${expected}`);
    assert.equal(mapped.hostCode, hostCode, "the host code is kept for the details view");
  }

  const settings = validateEmbeddingSettings(HOST_SETTINGS);
  const failing = new EmbeddingClient({
    settings,
    hostEmbed: async () => {
      throw Object.assign(new Error("no such model"), { code: "MODEL_NOT_FOUND" });
    },
  });
  await assert.rejects(failing.embed(["a"]), (error) => error.code === "MODEL_MISSING" && error.hostCode === "MODEL_NOT_FOUND");
});

test("a host without pi.embeddings says so instead of failing obscurely", async () => {
  const settings = validateEmbeddingSettings(HOST_SETTINGS);
  const client = new EmbeddingClient({ settings });
  await assert.rejects(client.embed(["a"]), (error) => error.code === "EMBEDDING_HOST_UNAVAILABLE");
});

test("a malformed host answer or an oversized text is refused, never normalized blindly", async () => {
  const settings = validateEmbeddingSettings(HOST_SETTINGS);
  const short = new EmbeddingClient({ settings, hostEmbed: async () => ({ vectors: [] }) });
  await assert.rejects(short.embed(["a"]), (error) => error.code === "EMBED_FAILED");

  const empty = new EmbeddingClient({ settings, hostEmbed: async (input) => ({ vectors: input.texts.map(() => []) }) });
  await assert.rejects(empty.embed(["a"]), (error) => error.code === "EMBED_FAILED");

  const calls = [];
  const big = new EmbeddingClient({
    settings,
    hostEmbed: async (input) => {
      calls.push(input);
      return { vectors: input.texts.map(() => [1, 2]) };
    },
  });
  await assert.rejects(big.embed(["x".repeat(9 * 1024)]), /8192 byte limit/);
  assert.deepEqual(calls, [], "an oversized text never reaches the host");
});

test("the settings file path is replaced by the host, not by a baseUrl", async () => {
  // A host config written to disk round-trips through the loader.
  const dir = await mkdtemp(path.join(os.tmpdir(), "pk-embed-host-"));
  const file = path.join(dir, "embedding.json");
  await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ ...HOST_SETTINGS, enabled: true }));
  const loaded = await loadEmbeddingSettings(file);
  assert.equal(loaded.provider, "host");
  assert.equal(loaded.modelKey, "minih-router/text-embedding-3-small");
  assert.equal(loaded.model, "text-embedding-3-small");
});
