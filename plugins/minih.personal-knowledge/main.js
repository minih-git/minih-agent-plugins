/**
 * Personal Knowledge plugin backend (ADR 0001 §10).
 *
 * Since 0.2.0 this module backs the Knowledge Universe view. It loads the same
 * shared index the MCP server uses (raw Node reads, like the MCP server: no
 * `fs.read` grant is needed or requested) and answers the view's fixed
 * channels. The page reaches it only through the sender-bound panel bridge
 * (`window.pluginBridge.invoke`), forwarded by the host as `onPanelInvoke`.
 *
 * 0.2.0 does not declare `memory.read`, so memory satellites report
 * `unsupported`; 0.3.0 adds `kg.memory` data and the promotion channels.
 */
"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");

const pluginRoot = __dirname;
const manifest = require("./manifest.json");

/** Channels the page may call. Anything else is refused, not forwarded. */
const CHANNELS = new Set([
  "kg.graph",
  "kg.note",
  "kg.copyLink",
  "kg.settings.get",
  "kg.settings.set",
  "kg.settings.test",
]);

const MAX_PREVIEW_CHARS = 8000;

let state = null;

async function ensureState() {
  if (state) return state;
  const [{ VaultIndex }, { loadOntology }, { redactSensitiveContent }] = await Promise.all([
    import("./lib/vault-index.mjs"),
    import("./lib/ontology.mjs"),
    import("./lib/redact.mjs"),
  ]);
  const config = await loadMapping();
  const vaultPath =
    process.env.PERSONAL_KNOWLEDGE_VAULT ?? config.vaultPath ?? path.join(require("node:os").homedir(), "Documents", "Knowledge");
  const { realpath, stat } = await import("node:fs/promises");
  const info = await stat(vaultPath);
  if (!info.isDirectory()) throw new Error(`Knowledge vault is not a directory: ${vaultPath}`);
  const index = new VaultIndex({ root: await realpath(vaultPath), config });
  await index.refresh({ force: true });
  const ontology = await loadOntology({ pluginRoot, index });
  state = { index, ontology, redactSensitiveContent, vaultPath };
  return state;
}

async function loadMapping() {
  // Same resolution order as the MCP server: explicit env, then the per-user
  // convention file, then the bundled template, then empty.
  const { readFile } = await import("node:fs/promises");
  const os = require("node:os");
  const candidates = process.env.PERSONAL_KNOWLEDGE_CONFIG
    ? [path.resolve(process.env.PERSONAL_KNOWLEDGE_CONFIG)]
    : [
        path.join(os.homedir(), ".personal-knowledge", "repo-map.json"),
        path.join(pluginRoot, "config", "repo-map.json"),
      ];
  for (const configPath of candidates) {
    try {
      return JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {};
}

function refusal(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

async function graph(payload) {
  const { buildGraphPayload } = await import("./lib/graph.mjs");
  const { index, ontology } = await ensureState();
  await index.refresh();
  return buildGraphPayload({
    index,
    ontology,
    vaultName: path.basename(state.vaultPath),
    memory: { status: "unsupported", count: 0 },
  });
}

async function note(payload) {
  const { index, ontology, redactSensitiveContent } = await ensureState();
  await index.refresh();
  const requested = String(payload?.path ?? "");
  const resolved = index.resolveTarget(requested);
  if (!resolved || !resolved.endsWith(".md") || !index.note(resolved)) {
    throw refusal(`unknown note: ${requested}`);
  }
  const record = index.note(resolved);
  const safe = redactSensitiveContent(record.raw);
  const issues = ontology.validate(record, {
    resolveTarget: (target) => index.resolveTarget(target),
    classOf: (notePath) => {
      const target = index.note(notePath);
      return target ? ontology.classOf(target) : null;
    },
    backlinkCount: index.backlinksOf(resolved).length,
    now: new Date(),
  });
  return {
    path: resolved,
    title: record.title,
    metadata: record.metadata,
    outline: record.outline,
    sha256: record.sha256,
    redacted: safe !== record.raw,
    content: safe.slice(0, MAX_PREVIEW_CHARS),
    truncated: safe.length > MAX_PREVIEW_CHARS,
    issues,
    backlinks: index.backlinksOf(resolved),
  };
}

async function copyLink(payload) {
  const { index } = await ensureState();
  const requested = String(payload?.path ?? "");
  const resolved = index.resolveTarget(requested);
  if (!resolved || !index.note(resolved)) throw refusal(`unknown note: ${requested}`);
  const vaultName = path.basename(state.vaultPath);
  const link = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(resolved)}`;
  if (typeof globalThis.pi?.clipboard?.writeText !== "function") {
    throw new Error("clipboard unavailable in this host");
  }
  await globalThis.pi.clipboard.writeText(link);
  return { copied: true, link };
}


function embeddingSettingsPath() {
  return process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG
    ?? path.join(require("node:os").homedir(), ".personal-knowledge", "embedding.json");
}

async function loadEmbeddingLib() {
  return import("./lib/embeddings.mjs");
}

/**
 * `kg.settings.get`: the current embedding settings (no secret), the key
 * status (found / missing / not-required — never the value), the vector index
 * statistics read from disk, and the send estimate after `exclude` (§6.1).
 */
async function settingsGet() {
  await ensureState();
  const { loadEmbeddingSettings, resolveApiKey } = await loadEmbeddingLib();
  const { readFile, stat } = await import("node:fs/promises");
  const os = require("node:os");
  const filePath = embeddingSettingsPath();
  let settings;
  let settingsError = null;
  try {
    settings = await loadEmbeddingSettings(filePath);
  } catch (error) {
    settings = null;
    settingsError = { code: error.code ?? "EMBEDDING_CONFIG_INVALID", message: error.message };
  }
  let apiKeyStatus = "not-required";
  if (settings && settings.apiKeyEnv) {
    apiKeyStatus = (await resolveApiKey(settings.apiKeyEnv, { home: os.homedir() })).status;
  }
  let index = null;
  try {
    const dirName = createHash("sha1").update(state.index.root).digest("hex");
    const metaPath = path.join(
      process.env.PERSONAL_KNOWLEDGE_INDEX_DIR ?? path.join(os.homedir(), ".personal-knowledge", "index", dirName),
      "meta.json",
    );
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const info = await stat(metaPath);
    index = { identity: meta.identity, dims: meta.dims, chunks: meta.count, builtAt: info.mtime.toISOString() };
  } catch {
    index = null;
  }
  // Send estimate: every chunk that a first remote build would send, after
  // `exclude` and after redaction removes only credentials.
  let estimate = null;
  if (settings) {
    const { isExcluded } = await loadEmbeddingLib();
    await state.index.refresh();
    let chunks = 0;
    let characters = 0;
    for (const relative of state.index.paths()) {
      if (!relative.endsWith(".md") || isExcluded(relative, settings.exclude)) continue;
      const record = state.index.note(relative);
      if (!record) continue;
      chunks += record.chunks.length;
      characters += record.chunkTexts.reduce((sum, text) => sum + state.redactSensitiveContent(text).length, 0);
    }
    estimate = { chunks, characters };
  }
  return { settings, settingsError, apiKeyStatus, index, estimate };
}

/**
 * `kg.settings.set`: validate against §6.1 and write `embedding.json`
 * atomically with mode 0600. The file never holds a key, only its variable
 * name.
 */
async function settingsSet(payload) {
  const { validateEmbeddingSettings } = await loadEmbeddingLib();
  const settings = validateEmbeddingSettings(payload?.embedding);
  const { writeFile, rename, mkdir } = await import("node:fs/promises");
  const filePath = embeddingSettingsPath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
  return { settings };
}

/**
 * `kg.settings.test`: embed one fixed short string with the given settings
 * and report `{ ok, dims, latencyMs }` or a reason code of §6. The key is
 * resolved in memory and never returned.
 */
async function settingsTest(payload) {
  const { validateEmbeddingSettings, resolveApiKey, EmbeddingClient } = await loadEmbeddingLib();
  const os = require("node:os");
  const started = Date.now();
  let settings;
  try {
    settings = validateEmbeddingSettings(payload?.embedding);
  } catch (error) {
    return { ok: false, reason: error.code ?? "EMBEDDING_CONFIG_INVALID", message: error.message };
  }
  const key = await resolveApiKey(settings.apiKeyEnv, { home: os.homedir() });
  if (settings.apiKeyEnv && key.status !== "found") {
    return { ok: false, reason: "EMBEDDING_KEY_MISSING", message: `environment variable ${settings.apiKeyEnv} has no value` };
  }
  const client = new EmbeddingClient({ settings, apiKey: key.value, home: os.homedir() });
  try {
    const [vector] = await client.embed(["personal-knowledge connection test"]);
    return { ok: true, dims: vector.length, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: error.code ?? "EMBED_FAILED", message: error.message };
  }
}

async function onPanelInvoke(channel, payload) {
  if (!CHANNELS.has(channel)) throw refusal(`unknown channel: ${channel}`);
  if (channel === "kg.graph") return graph(payload);
  if (channel === "kg.note") return note(payload);
  if (channel === "kg.copyLink") return copyLink(payload);
  if (channel === "kg.settings.get") return settingsGet();
  if (channel === "kg.settings.set") return settingsSet(payload);
  if (channel === "kg.settings.test") return settingsTest(payload);
  throw refusal(`unknown channel: ${channel}`);
}

async function onLoad() {
  // Warm the index so the first view render does not pay for the vault scan.
  await ensureState().catch(() => {});
}

async function onUnload() {
  state = null;
}

module.exports = { name: manifest.id, version: manifest.version, onLoad, onUnload, onPanelInvoke };
