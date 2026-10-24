/**
 * Local embedding client for Ollama (ADR 0001 §6, vector channel).
 *
 * The only network peer allowed is a loopback embedding server: a `baseUrl`
 * whose host is not 127.0.0.1 / localhost / ::1 is rejected at load time with
 * `EMBEDDING_NOT_LOOPBACK`, keeping the "nothing leaves the machine" promise.
 *
 * Defaults: `baseUrl = http://127.0.0.1:11434`, `model = bge-m3` (1,024
 * dimensions), 32 inputs per request, 30-second request timeout, 500 ms probe
 * timeout. An unreachable server is cached for 60 seconds so a missing Ollama
 * costs at most one probe per minute.
 */

const EMBED_BATCH = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 500;
const UNREACHABLE_CACHE_MS = 60_000;

export function assertLoopback(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`EMBEDDING_NOT_LOOPBACK: invalid embedding.baseUrl: ${baseUrl}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`EMBEDDING_NOT_LOOPBACK: embedding.baseUrl must be http on the loopback interface: ${baseUrl}`);
  }
  const host = url.hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`EMBEDDING_NOT_LOOPBACK: embedding.baseUrl must stay on this machine, got ${host}`);
  }
  return url.toString().replace(/\/$/, "");
}

export class EmbeddingClient {
  constructor({ enabled = true, baseUrl = "http://127.0.0.1:11434", model = "bge-m3", now = () => new Date(), fetchImpl = fetch } = {}) {
    this.enabled = enabled;
    this.baseUrl = assertLoopback(baseUrl);
    this.model = model;
    this.now = now;
    this.fetch = fetchImpl;
    this.unreachableSince = 0;
  }

  /** True while the 60-second unreachable cache is hot. */
  recentlyUnreachable() {
    return this.unreachableSince > 0 && this.now().getTime() - this.unreachableSince < UNREACHABLE_CACHE_MS;
  }

  async #request(pathname, body, timeoutMs) {
    const response = await this.fetch(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      const error = new Error(`MODEL_MISSING: model ${this.model} is not available on ${this.baseUrl}`);
      error.code = "MODEL_MISSING";
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMBED_FAILED: ${pathname} answered ${response.status}`);
      error.code = "EMBED_FAILED";
      throw error;
    }
    return response.json();
  }

  /** Cheap reachability probe; OLLAMA_UNREACHABLE when nothing answers. */
  async probe() {
    if (this.recentlyUnreachable()) {
      const error = new Error("OLLAMA_UNREACHABLE: no embedding server answered recently");
      error.code = "OLLAMA_UNREACHABLE";
      throw error;
    }
    try {
      await this.fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      this.unreachableSince = 0;
    } catch {
      this.unreachableSince = this.now().getTime();
      const error = new Error(`OLLAMA_UNREACHABLE: nothing answered at ${this.baseUrl}`);
      error.code = "OLLAMA_UNREACHABLE";
      throw error;
    }
  }

  /** Embed texts in batches; returns one L2-normalized vector per text. */
  async embed(texts) {
    if (!this.enabled) {
      const error = new Error("EMBED_DISABLED");
      error.code = "EMBED_DISABLED";
      throw error;
    }
    const vectors = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const payload = await this.#request("/api/embed", { model: this.model, input: batch }, REQUEST_TIMEOUT_MS);
      const embedded = payload?.embeddings;
      if (!Array.isArray(embedded) || embedded.length !== batch.length) {
        const error = new Error("EMBED_FAILED: unexpected /api/embed response shape");
        error.code = "EMBED_FAILED";
        throw error;
      }
      for (const vector of embedded) vectors.push(normalize(vector));
    }
    return vectors;
  }
}

/** L2-normalize in place; zero vectors stay zero. */
export function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= magnitude;
  return vector;
}

/** Map a config blob to client options; throws EMBEDDING_NOT_LOOPBACK early. */
export function embeddingOptions(config = {}) {
  const embedding = config.embedding ?? {};
  return {
    enabled: embedding.enabled !== false,
    baseUrl: embedding.baseUrl ?? "http://127.0.0.1:11434",
    model: embedding.model ?? "bge-m3",
  };
}
