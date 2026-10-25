import assert from "node:assert/strict";
import test from "node:test";

import { EmbeddingClient } from "../lib/embeddings.mjs";

/**
 * A gateway that caps the per-request input rejects oversized batches with
 * 400. The client must retry the rejected batch in halves instead of failing
 * the whole run, and must keep the per-batch request contract.
 */
test("a 400 on a full batch is retried in halves down to the texts", async () => {
  const served = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.input.length > 16) {
      served.push(`reject:${body.input.length}`);
      return { ok: false, status: 400, text: async () => '{"error":"InvalidParameter"}' };
    }
    served.push(`ok:${body.input.length}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((text, index) => ({ index, embedding: [text.length, 1, 0, 0] })),
      }),
    };
  };
  const client = new EmbeddingClient({
    settings: {
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      model: "fake-embedding",
      allowRemote: true,
      apiKeyEnv: "",
      exclude: [],
    },
    fetchImpl: fakeFetch,
  });
  const texts = Array.from({ length: 32 }, (_, i) => `text-${i}`);
  const vectors = await client.embed(texts);
  assert.equal(vectors.length, 32);
  assert.equal(client.dims, 4);
  // 32 → 400 → two 16-halves; nothing smaller is ever requested.
  assert.deepEqual(served, ["reject:32", "ok:16", "ok:16"]);
});

test("other error statuses do not trigger the split retry", async () => {
  let requests = 0;
  const fakeFetch = async (_url, init) => {
    requests += 1;
    return { ok: false, status: 500, text: async () => "boom" };
  };
  const client = new EmbeddingClient({
    settings: {
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      model: "fake-embedding",
      allowRemote: true,
      apiKeyEnv: "",
      exclude: [],
    },
    fetchImpl: fakeFetch,
  });
  await assert.rejects(
    client.embed(["a", "b"]),
    (error) => error.code === "EMBED_FAILED" && error.status === 500,
  );
  assert.equal(requests, 1, "a 500 fails the batch without halving");
});
