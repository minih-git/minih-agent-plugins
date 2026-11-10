import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Embedding providers and the remote switch (ADR 0001 §6.1).
 *
 * Settings live in `~/.personal-knowledge/embedding.json` and nowhere else.
 * When the file is missing every field takes its default, so the behavior is
 * exactly the default local `ollama` setup. A non-loopback `baseUrl` needs
 * `allowRemote: true` AND `https:`; the API key is never stored — only the
 * name of an environment variable is, and the value is resolved from the
 * process environment first and from the user's shell rc second. A resolved
 * key stays in process memory and never appears in a file, a log, a tool
 * result, a view payload, or an error message.
 */

export { EMBEDDING_DEFAULTS } from "./embedding-defaults.mjs";
import { EMBEDDING_DEFAULTS } from "./embedding-defaults.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const API_KEY_ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const EMBED_BATCH = 32;
/** `pi.embeddings.embed` accepts at most 64 texts per call (ADR 0003). */
export const HOST_EMBED_BATCH = 64;
/** A single text the host will accept, measured in UTF-8 bytes. */
export const HOST_EMBED_MAX_TEXT_BYTES = 8 * 1024;
/** …and a whole call: 64 × 8 KiB would be twice this, so batches split on bytes. */
export const HOST_EMBED_MAX_BATCH_BYTES = 256 * 1024;
/** The host allows 120 calls per plugin per minute. */
export const HOST_EMBED_RATE_PER_MINUTE = 120;
/** Attempts per batch before a rate limit is reported as a failure. */
export const HOST_EMBED_MAX_ATTEMPTS = 4;
/** Base of the linear backoff between those attempts. */
export const HOST_EMBED_BACKOFF_MS = 1_000;

/**
 * Split texts into calls the host will accept: at most 64 entries, at most
 * 8 KiB each (UTF-8), and at most 256 KiB per call. Blank texts are dropped —
 * the host refuses them and they carry nothing to embed.
 *
 * A single text over 8 KiB is reported by the caller, not silently truncated.
 */
export function splitHostBatches(texts) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const raw of texts ?? []) {
    const text = String(raw ?? "");
    if (text.trim() === "") continue;
    const size = Buffer.byteLength(text, "utf8");
    const wouldExceed =
      current.length >= HOST_EMBED_BATCH || bytes + size > HOST_EMBED_MAX_BATCH_BYTES;
    if (wouldExceed && current.length > 0) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(text);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Host error code → the reason this plugin already reports for a direct
 * endpoint. The panel maps these to a sentence the user can act on.
 */
const HOST_ERROR_MAP = Object.freeze({
  INVALID_ARGUMENT: "EMBEDDING_CONFIG_INVALID",
  MODEL_NOT_FOUND: "MODEL_MISSING",
  MODEL_NOT_EMBEDDING: "MODEL_NOT_EMBEDDING",
  UNSUPPORTED_PROVIDER: "EMBEDDING_UNSUPPORTED_PROVIDER",
  PROVIDER_UNAUTHORIZED: "EMBEDDING_AUTH_FAILED",
  PROVIDER_RATE_LIMITED: "EMBEDDING_RATE_LIMITED",
  NETWORK_ERROR: "EMBEDDING_UNREACHABLE",
  RATE_LIMITED: "EMBEDDING_RATE_LIMITED",
  TIMEOUT: "EMBED_FAILED",
});

/** Map one host rejection onto a plugin reason code, keeping the host code. */
export function mapHostEmbeddingError(error) {
  const hostCode = String(error?.code ?? "");
  const mapped = HOST_ERROR_MAP[hostCode] ?? "EMBED_FAILED";
  const reason = transportError(mapped, `the app answered ${hostCode || "an error"}`);
  reason.hostCode = hostCode || null;
  return reason;
}
const OLLAMA_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 500;
const UNREACHABLE_CACHE_MS = 60_000;

function configError(code, message) {
  // The code prefixes the message so tool output and view errors name the
  // reason even when only the text survives; the key never appears here.
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function parseBaseUrl(value, field = "baseUrl") {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw configError("EMBEDDING_CONFIG_INVALID", `${field} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configError("EMBEDDING_CONFIG_INVALID", `${field} must use http or https`);
  }
  return url;
}

function isLoopback(url) {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Validate one raw settings object; returns the normalized settings or throws
 * `EMBEDDING_CONFIG_INVALID` / `EMBEDDING_NOT_LOOPBACK` /
 * `EMBEDDING_INSECURE_URL` with the offending field named.
 */
export function validateEmbeddingSettings(raw, { applyRemoteRules = true } = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError("EMBEDDING_CONFIG_INVALID", "the embedding settings must be a JSON object");
  }
  const value = raw;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw configError("EMBEDDING_CONFIG_INVALID", "enabled must be a boolean");
  }
  const provider = value.provider ?? EMBEDDING_DEFAULTS.provider;
  if (provider !== "ollama" && provider !== "openai-compatible" && provider !== "host") {
    throw configError(
      "EMBEDDING_CONFIG_INVALID",
      'provider must be "ollama", "openai-compatible", or "host"',
    );
  }
  if (value.allowRemote !== undefined && typeof value.allowRemote !== "boolean") {
    throw configError("EMBEDDING_CONFIG_INVALID", "allowRemote must be a boolean");
  }
  const apiKeyEnv = value.apiKeyEnv ?? EMBEDDING_DEFAULTS.apiKeyEnv;
  if (apiKeyEnv !== "" && !API_KEY_ENV_PATTERN.test(apiKeyEnv)) {
    throw configError("EMBEDDING_CONFIG_INVALID", "apiKeyEnv must be empty or an environment variable name (A-Z, digits, underscore)");
  }
  const exclude = value.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== "string")) {
    throw configError("EMBEDDING_CONFIG_INVALID", "exclude must be a list of vault-relative folder prefixes");
  }
  for (const entry of exclude) {
    if (!entry.trim() || entry.includes("..") || path.posix.isAbsolute(entry)) {
      throw configError("EMBEDDING_CONFIG_INVALID", `exclude entry "${entry}" must be a relative vault folder without ".."`);
    }
  }
  // A host model is named by `${providerId}/${modelId}`; the endpoint, the key,
  // and the remote switch belong to Desktop in that mode, so they are neither
  // validated nor used here.
  const modelKey = value.modelKey ?? EMBEDDING_DEFAULTS.modelKey;
  if (modelKey !== "" && (typeof modelKey !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(modelKey))) {
    throw configError("EMBEDDING_CONFIG_INVALID", "modelKey must look like providerId/modelId");
  }
  if (provider === "host") {
    if (typeof modelKey !== "string" || !modelKey.trim()) {
      throw configError("EMBEDDING_CONFIG_INVALID", "modelKey is required when provider is \"host\"");
    }
    const hostModel = value.model === undefined ? modelKey.split("/").slice(1).join("/") : value.model;
    if (typeof hostModel !== "string" || !hostModel.trim()) {
      throw configError("EMBEDDING_CONFIG_INVALID", "model must be a non-empty string");
    }
    const hostAllowRemote = value.allowRemote ?? EMBEDDING_DEFAULTS.allowRemote;
    if (typeof hostAllowRemote !== "boolean") {
      throw configError("EMBEDDING_CONFIG_INVALID", "allowRemote must be a boolean");
    }
    return {
      enabled: value.enabled ?? EMBEDDING_DEFAULTS.enabled,
      provider: "host",
      baseUrl: EMBEDDING_DEFAULTS.baseUrl,
      model: hostModel,
      modelKey,
      allowRemote: hostAllowRemote,
      apiKeyEnv: "",
      exclude: [...exclude],
    };
  }
  const model = value.model ?? EMBEDDING_DEFAULTS.model;
  if (typeof model !== "string" || !model.trim()) {
    throw configError("EMBEDDING_CONFIG_INVALID", "model must be a non-empty string");
  }
  const baseUrl = value.baseUrl ?? EMBEDDING_DEFAULTS.baseUrl;
  const url = parseBaseUrl(baseUrl);
  const allowRemote = value.allowRemote ?? EMBEDDING_DEFAULTS.allowRemote;
  if (applyRemoteRules && !isLoopback(url)) {
    if (!allowRemote) {
      throw configError("EMBEDDING_NOT_LOOPBACK", `baseUrl host "${url.hostname}" is not on this machine; set allowRemote to true to allow it`);
    }
    if (url.protocol !== "https:") {
      throw configError("EMBEDDING_INSECURE_URL", "a non-loopback baseUrl must use https");
    }
  }
  return {
    enabled: value.enabled ?? EMBEDDING_DEFAULTS.enabled,
    provider,
    baseUrl: url.toString().replace(/\/$/, ""),
    model,
    modelKey: typeof modelKey === "string" ? modelKey : "",
    allowRemote,
    apiKeyEnv,
    exclude: [...exclude],
  };
}

/** Read and validate `embedding.json`; a missing file means the defaults. */
export async function loadEmbeddingSettings(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ...EMBEDDING_DEFAULTS };
    throw configError("EMBEDDING_CONFIG_INVALID", `embedding settings are unreadable: ${error.code ?? error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("EMBEDDING_CONFIG_INVALID", "embedding.json is not valid JSON");
  }
  return validateEmbeddingSettings(parsed);
}

/** mtime of the settings file, or 0 when it does not exist (hot reload). */
export async function embeddingSettingsMtime(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolve the API key: the process environment first, then one child process
 * that sources the user's shell rc. The value never leaves this function
 * except as the return value; callers embed it in a header only.
 */
export async function resolveApiKey(apiKeyEnv, { env = process.env, home = os.homedir() } = {}) {
  if (!apiKeyEnv) return { status: "not-required", value: null };
  const fromEnv = env[apiKeyEnv];
  if (fromEnv) return { status: "found", value: fromEnv };
  const fromRc = await resolveApiKeyFromShell(apiKeyEnv, { home });
  if (fromRc) return { status: "found", value: fromRc };
  return { status: "missing", value: null };
}

function resolveApiKeyFromShell(apiKeyEnv, { home }) {
  const shell = process.env.SHELL ?? "";
  const usable = /\/(zsh|bash)$/.test(shell) ? shell : "/bin/zsh";
  const rc = usable.endsWith("/zsh")
    ? path.join(home, ".zshrc")
    : path.join(home, ".bashrc");
  const command = `source '${rc}' >/dev/null 2>&1; printf %s "$${apiKeyEnv}"`;
  return new Promise((resolve) => {
    // No stdin, stderr discarded, 5-second timeout. Only the variable value is
    // printed to stdout; neither the command nor the key is ever logged.
    const child = execFile(usable, ["-c", command], { timeout: 5000 }, (error, stdout) => {
      const value = String(stdout ?? "").trim();
      resolve(error ? null : value || null);
    });
    child.stdin?.end();
    child.on("error", () => resolve(null));
  });
}

function transportError(code, message) {
  return configError(code, message);
}

/** Short provider error text, truncated; never carries note text or the key. */
async function shortResponseText(response) {
  try {
    const body = await response.text();
    return body.replace(/\s+/g, " ").slice(0, 160);
  } catch {
    return "";
  }
}

/**
 * One embedding client for either provider. `settings` comes from
 * `validateEmbeddingSettings`; `apiKey` is the already-resolved secret.
 */
export class EmbeddingClient {
  constructor({
    settings,
    apiKey = null,
    now = () => new Date(),
    fetchImpl = fetch,
    home = os.homedir(),
    hostEmbed = null,
    sleep = null,
  } = {}) {
    this.settings = settings;
    this.apiKey = apiKey;
    this.now = now;
    this.fetch = fetchImpl;
    this.home = home;
    this.hostEmbed = hostEmbed;
    this.sleep = sleep;
    this.hostCallTimes = [];
    this.dims = null;
    this.unreachableSince = 0;
    // A host model has no endpoint of its own; the wait is the host's budget.
    this.loopback = settings.provider === "host" ? true : isLoopback(parseBaseUrl(settings.baseUrl));
    this.queryTimeoutMs = this.loopback ? 3000 : 8000;
  }

  /** `host` runs the request inside Desktop, through the user's own model. */
  get isHost() {
    return this.settings.provider === "host";
  }

  /**
   * Provider identity: a change invalidates the vector index (§6.1). A host
   * model is named `host:<modelKey>`, so switching models rebuilds the index
   * exactly as switching a local model does.
   */
  identity() {
    return `${this.#identitySource()}|${this.dims ?? "?"}`;
  }

  /** Identity without dimensions, for comparing before the first embed. */
  identityPrefix() {
    return `${this.#identitySource()}|`;
  }

  #identitySource() {
    if (this.isHost) return `host:${this.settings.modelKey}`;
    return `${this.settings.provider}|${this.settings.baseUrl}|${this.settings.model}`;
  }

  recentlyUnreachable() {
    return this.unreachableSince > 0 && this.now().getTime() - this.unreachableSince < UNREACHABLE_CACHE_MS;
  }

  async #post(pathname, body, timeoutMs, extraHeaders = {}) {
    const headers = { "content-type": "application/json", ...extraHeaders };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response;
    try {
      response = await this.fetch(`${this.settings.baseUrl}${pathname}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.code === "ABORT_ERR") {
        throw transportError("EMBED_FAILED", `embedding request timed out after ${timeoutMs} ms`);
      }
      const code = this.settings.provider === "ollama" ? "OLLAMA_UNREACHABLE" : "EMBEDDING_UNREACHABLE";
      throw transportError(code, `no answer from ${this.settings.baseUrl}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw transportError("EMBEDDING_AUTH_FAILED", `the endpoint answered ${response.status}; the key was rejected`);
    }
    if (response.status === 404) {
      throw transportError("MODEL_MISSING", `the endpoint answered 404 for model ${this.settings.model}`);
    }
    if (response.status === 429) {
      throw transportError("EMBEDDING_RATE_LIMITED", `the endpoint answered 429 (rate limited)`);
    }
    if (!response.ok) {
      const error = transportError("EMBED_FAILED", `the endpoint answered ${response.status}: ${await shortResponseText(response)}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /** Cheap reachability probe for `ollama`; the compatible provider has none —
   * its first real request serves as the probe, so no quota is spent. */
  async probe() {
    if (this.settings.provider !== "ollama") return;
    if (this.recentlyUnreachable()) {
      throw transportError("OLLAMA_UNREACHABLE", `no answer from ${this.settings.baseUrl} recently`);
    }
    try {
      await this.fetch(`${this.settings.baseUrl}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      this.unreachableSince = 0;
    } catch {
      this.unreachableSince = this.now().getTime();
      throw transportError("OLLAMA_UNREACHABLE", `no answer from ${this.settings.baseUrl}`);
    }
  }

  /** Mark the unreachable cache after a failed real request. */
  markUnreachable() {
    this.unreachableSince = this.now().getTime();
  }

  /**
   * Embed texts in batches; returns one L2-normalized vector per text (a
   * blank text is skipped for a host model, which refuses them).
   */
  async embed(texts, { timeoutMs = OLLAMA_TIMEOUT_MS } = {}) {
    if (this.isHost) {
      const vectors = [];
      for (const batch of splitHostBatches(texts)) {
        const produced = await this.#embedBatch(batch, timeoutMs);
        vectors.push(...produced);
      }
      return vectors;
    }
    const vectors = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      vectors.push(...(await this.#embedBatch(batch, timeoutMs)));
    }
    return vectors;
  }

  /**
   * Call the host, waiting out its rate limits (ADR 0003 §5).
   *
   * The host allows 120 calls per plugin per minute and answers `RATE_LIMITED`
   * when that is used up; a provider answers `PROVIDER_RATE_LIMITED` when it is
   * throttling on its own. Both are transient, so the run backs off instead of
   * failing: `retryAfterMs` grows linearly and the attempt count is small, so a
   * long index pass pauses rather than dies.
   */
  async #callHostWithBackoff(embed, input) {
    const attempts = HOST_EMBED_MAX_ATTEMPTS;
    let waited = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#throttleHostCall(embed, input);
      } catch (error) {
        const code = String(error?.code ?? "");
        const retryable = code === "RATE_LIMITED" || code === "PROVIDER_RATE_LIMITED";
        if (!retryable || attempt >= attempts) throw error;
        // Linear backoff: a heavy build spreads its calls over minutes.
        const delay = HOST_EMBED_BACKOFF_MS * attempt;
        waited += delay;
        await this.#sleep(delay);
        void waited;
      }
    }
  }

  /**
   * Keep this plugin inside the host's per-minute allowance. Calls are spaced
   * so at most `HOST_EMBED_RATE_PER_MINUTE` start in any minute; a caller that
   * would exceed it waits instead of being rejected.
   */
  async #throttleHostCall(embed, input) {
    const now = this.now().getTime();
    const windowStart = now - 60_000;
    this.hostCallTimes = (this.hostCallTimes ?? []).filter((at) => at > windowStart);
    if (this.hostCallTimes.length >= HOST_EMBED_RATE_PER_MINUTE) {
      const wait = this.hostCallTimes[0] + 60_000 - now;
      if (wait > 0) await this.#sleep(wait);
      const after = this.now().getTime();
      this.hostCallTimes = this.hostCallTimes.filter((at) => at > after - 60_000);
    }
    this.hostCallTimes.push(this.now().getTime());
    return embed(input);
  }

  /** `setTimeout`, injectable so tests do not wait in real time. */
  #sleep(ms) {
    if (typeof this.sleep === "function") return this.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Embed one batch through the app's own model (`pi.embeddings.embed`). The
   * host caps a batch at 64 texts, a single text at 8 KiB, and a call at
   * 256 KiB — all measured in UTF-8 bytes — so `splitHostBatches` keeps every
   * call inside all three.
   */
  async #embedThroughHost(batch) {
    const embed = this.hostEmbed ?? (typeof globalThis.pi?.embeddings?.embed === "function" ? globalThis.pi.embeddings.embed.bind(globalThis.pi.embeddings) : null);
    if (typeof embed !== "function") {
      throw transportError("EMBEDDING_HOST_UNAVAILABLE", "this Desktop version has no pi.embeddings.embed (needs Desktop 1.5.0)");
    }
    // The host measures UTF-8 bytes, and it rejects a blank text outright.
    // Chunks are trimmed by the indexer, so a blank one here means nothing to
    // send: skip it rather than fail the whole run.
    const texts = batch.filter((text) => String(text ?? "").trim() !== "");
    if (texts.length === 0) return [];
    for (const text of texts) {
      if (Buffer.byteLength(text, "utf8") > HOST_EMBED_MAX_TEXT_BYTES) {
        throw transportError("EMBED_FAILED", `one text exceeds the ${HOST_EMBED_MAX_TEXT_BYTES} byte limit of the app's embedding API`);
      }
    }
    if (Buffer.byteLength(texts.join(""), "utf8") > HOST_EMBED_MAX_BATCH_BYTES) {
      throw transportError("EMBED_FAILED", `one batch exceeds the ${HOST_EMBED_MAX_BATCH_BYTES} byte limit of the app's embedding API`);
    }
    let result;
    try {
      result = await this.#callHostWithBackoff(embed, { modelKey: this.settings.modelKey, texts });
    } catch (error) {
      throw mapHostEmbeddingError(error);
    }
    const vectors = result?.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw transportError("EMBED_FAILED", "unexpected pi.embeddings.embed response shape");
    }
    return vectors.map((vector) => {
      if (!Array.isArray(vector) || vector.length === 0) {
        throw transportError("EMBED_FAILED", "the app returned an empty vector");
      }
      if (this.dims === null) this.dims = vector.length;
      return normalize([...vector]);
    });
  }

  /**
   * Embed one batch. Some gateways cap the per-request input size and answer
   * 400 for a full batch; on that rejection the batch is retried in halves
   * down to single texts, so one oversized request degrades throughput
   * instead of failing the whole run.
   */
  async #embedBatch(batch, timeoutMs) {
    if (this.isHost) return this.#embedThroughHost(batch);
    const post = () =>
      this.settings.provider === "ollama"
        ? this.#post("/api/embed", { model: this.settings.model, input: batch }, timeoutMs)
        : this.#post("/embeddings", { model: this.settings.model, input: batch }, timeoutMs);
    let payload;
    try {
      payload = await post();
    } catch (error) {
      const status = error?.status;
      if (batch.length > 1 && (status === 400 || status === 413)) {
        const middle = Math.floor(batch.length / 2);
        const [head, tail] = await Promise.all([
          this.#embedBatch(batch.slice(0, middle), timeoutMs),
          this.#embedBatch(batch.slice(middle), timeoutMs),
        ]);
        return [...head, ...tail];
      }
      throw error;
    }
    return this.#extractVectors(payload, batch.length);
  }

  #extractVectors(payload, expectedCount) {
    if (this.settings.provider === "ollama") {
      const embedded = payload?.embeddings;
      if (!Array.isArray(embedded) || embedded.length !== expectedCount) {
        throw transportError("EMBED_FAILED", "unexpected /api/embed response shape");
      }
      return embedded.map((vector) => {
        if (this.dims === null) this.dims = vector.length;
        return normalize(vector);
      });
    }
    const data = payload?.data;
    if (!Array.isArray(data) || data.length !== expectedCount) {
      throw transportError("EMBED_FAILED", "unexpected /embeddings response shape");
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row) => {
      if (!Array.isArray(row?.embedding)) {
        throw transportError("EMBED_FAILED", "unexpected /embeddings response shape");
      }
      if (this.dims === null) this.dims = row.embedding.length;
      return normalize([...row.embedding]);
    });
  }

  /** Remember the dimension after any successful embed (both providers). */
  noteDims(dims) {
    if (this.dims === null && Number.isInteger(dims) && dims > 0) this.dims = dims;
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

/** Chunks under an excluded folder prefix are never embedded (§6.1). */
export function isExcluded(relativePath, exclude) {
  if (!exclude?.length) return false;
  return exclude.some((prefix) => {
    const clean = String(prefix).replace(/\/$/, "");
    return relativePath === clean || relativePath.startsWith(`${clean}/`);
  });
}
