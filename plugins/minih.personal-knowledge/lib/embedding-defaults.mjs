/**
 * The embedding defaults, shared by the backend validator and the view's
 * retrieval-settings form so there is exactly one source of truth.
 *
 * Kept dependency-free: `lib/embeddings.mjs` re-exports it, and
 * `scripts/build.mjs` bundles this file into `view/vendor/` for the view.
 */

export const EMBEDDING_DEFAULTS = Object.freeze({
  enabled: true,
  // `host` uses an embedding model configured in Desktop (ADR 0003); the other
  // two call an endpoint directly. The default stays the local Ollama so an
  // existing install keeps behaving exactly as before.
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "bge-m3",
  // `${providerId}/${modelId}` of a Desktop embedding model, `host` only.
  modelKey: "",
  allowRemote: false,
  apiKeyEnv: "",
  exclude: [],
});
