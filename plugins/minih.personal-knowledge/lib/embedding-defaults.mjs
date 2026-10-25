/**
 * The embedding defaults, shared by the backend validator and the view's
 * retrieval-settings form so there is exactly one source of truth.
 *
 * Kept dependency-free: `lib/embeddings.mjs` re-exports it, and
 * `scripts/build.mjs` bundles this file into `view/vendor/` for the view.
 */

export const EMBEDDING_DEFAULTS = Object.freeze({
  enabled: true,
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "bge-m3",
  allowRemote: false,
  apiKeyEnv: "",
  exclude: [],
});
