/**
 * Retrieval settings: what the panel can say before it sends anything (ADR
 * 0003 §4.3).
 *
 * Pure functions only, so the reasoning is testable without a browser: the
 * panel renders the result, and the same rules decide whether Save and Test
 * are allowed to make a request at all.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Read a baseUrl into its parts, or `null` when it is not a URL yet. */
export function parseBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { protocol: url.protocol, hostname: url.hostname, loopback: LOOPBACK_HOSTS.has(url.hostname) };
  } catch {
    return null;
  }
}

/**
 * The state of one custom-endpoint form.
 *
 * `blockedReason` is the only thing that stops Save and Test from sending a
 * request: an incomplete or suspicious address is a hint, not a failure, so
 * the user can keep typing. `focus` names the control the panel should move
 * to, which is the checkbox the message is about.
 */
export function inspectEndpointForm({ provider = "ollama", baseUrl = "", allowRemote = false } = {}) {
  const parsed = parseBaseUrl(baseUrl);
  if (provider === "host") {
    return { blockedReason: null, focus: null, hint: null, highlightAllowRemote: false, remote: false };
  }
  if (!baseUrl.trim()) {
    return { blockedReason: null, focus: null, hint: "settingsHintUrlEmpty", highlightAllowRemote: false, remote: false };
  }
  if (!parsed) {
    return {
      blockedReason: "EMBEDDING_CONFIG_INVALID",
      focus: "settings-baseurl",
      hint: "settingsHintUrlInvalid",
      highlightAllowRemote: false,
      remote: false,
    };
  }
  if (parsed.loopback) {
    return { blockedReason: null, focus: null, hint: null, highlightAllowRemote: false, remote: false };
  }
  if (!allowRemote) {
    return {
      blockedReason: "EMBEDDING_NOT_LOOPBACK",
      focus: "settings-allow-remote",
      hint: "settingsHintNotLoopback",
      highlightAllowRemote: true,
      remote: true,
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      blockedReason: "EMBEDDING_INSECURE_URL",
      focus: "settings-baseurl",
      hint: "settingsHintInsecureUrl",
      highlightAllowRemote: false,
      remote: true,
    };
  }
  return { blockedReason: null, focus: null, hint: "settingsHintRemoteOk", highlightAllowRemote: false, remote: true };
}

/**
 * Every reason the backend can report, with the message key that explains it
 * in the user's language. The raw code stays available as `title`, so a bug
 * report keeps the detail without the panel shouting it.
 */
export const EMBEDDING_REASON_KEYS = Object.freeze({
  EMBEDDING_CONFIG_INVALID: "embedReasonConfigInvalid",
  EMBEDDING_NOT_LOOPBACK: "embedReasonNotLoopback",
  EMBEDDING_INSECURE_URL: "embedReasonInsecureUrl",
  EMBEDDING_KEY_MISSING: "embedReasonKeyMissing",
  EMBEDDING_AUTH_FAILED: "embedReasonAuthFailed",
  EMBEDDING_RATE_LIMITED: "embedReasonRateLimited",
  EMBEDDING_UNREACHABLE: "embedReasonUnreachable",
  EMBEDDING_UNSUPPORTED_PROVIDER: "embedReasonUnsupportedProvider",
  EMBEDDING_HOST_UNAVAILABLE: "embedReasonHostUnavailable",
  EMBEDDING_DISABLED: "embedReasonDisabled",
  MODEL_MISSING: "embedReasonModelMissing",
  MODEL_NOT_EMBEDDING: "embedReasonModelNotEmbedding",
  OLLAMA_UNREACHABLE: "embedReasonOllamaUnreachable",
  EMBED_FAILED: "embedReasonFailed",
});

/**
 * Turn a backend error into `{ code, messageKey }`. The code is taken from an
 * `error.code`, from a `CODE: rest` message, or from the reason string the
 * backend returns in a result object.
 */
export function describeEmbeddingError(input) {
  const raw = typeof input === "string" ? input : String(input?.code ?? input?.reason ?? input?.message ?? "");
  const match = /^([A-Z][A-Z0-9_]{2,})\b/.exec(raw.trim());
  const code = match ? match[1] : "";
  return { code: code || raw.trim(), messageKey: EMBEDDING_REASON_KEYS[code] ?? null };
}

/** Ordered shape of a host embedding model option: provider, then model. */
export function embeddingModelLabel(model) {
  const key = String(model?.key ?? "");
  const [keyProvider, ...keyModel] = key.split("/");
  const provider = String(model?.providerName ?? "").trim() || (key.includes("/") ? keyProvider : "");
  const label = String(model?.label ?? "").trim();
  const name = label || (key.includes("/") ? keyModel.join("/") : key);
  return provider && name ? `${provider} · ${name}` : name || provider;
}

/** Body of the model dropdown: entries, or the reason it is empty. */
export function embeddingModelChoices(answer) {
  const hostSupported = answer?.hostSupported !== false;
  const models = Array.isArray(answer?.models) ? answer.models.filter((model) => model?.key) : [];
  if (!hostSupported) return { models: [], reasonKey: "settingsHostEmbeddingUnsupported", selectable: false };
  if (models.length === 0) return { models: [], reasonKey: "settingsHostEmbeddingEmpty", selectable: true };
  return { models: models.map((model) => ({ ...model, optionLabel: embeddingModelLabel(model) })), reasonKey: null, selectable: true };
}
