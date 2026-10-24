/**
 * Personal Knowledge plugin backend (ADR 0001 §10 and §9).
 *
 * Since 0.2.0 this module backs the Knowledge Universe view. It loads the same
 * shared index the MCP server uses (raw Node reads, like the MCP server: no
 * `fs.read` grant is needed or requested) and answers the view's fixed
 * channels. The page reaches it only through the sender-bound panel bridge
 * (`window.pluginBridge.invoke`), forwarded by the host as `onPanelInvoke`.
 *
 * Since 0.3.0 the manifest declares `memory.read` (Desktop D682): the view can
 * show learned-memory satellites next to their project and promote a mature
 * `fact` or `reference` into a vault note. Memory is read-only here; archiving
 * the original entry stays the user's action in the Desktop memory manager.
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
  "kg.promote.preview",
  "kg.promote.apply",
  "kg.settings.get",
  "kg.settings.set",
  "kg.settings.test",
]);

const MAX_PREVIEW_CHARS = 8000;
const USER_CENTER_ID = "memory:user-center";

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
  state = { index, ontology, redactSensitiveContent, vaultPath, config };
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

function isReadOnlyMode() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.PERSONAL_KNOWLEDGE_READ_ONLY ?? "").trim().toLowerCase(),
  );
}

/** Page through `pi.memory.list` until `nextOffset` is null (ADR 0001 §9). */
async function listAllMemoryEntries(input) {
  const entries = [];
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = await globalThis.pi.memory.list({ ...input, limit: 200, offset });
    if (result.readEnabled === false) return { readEnabled: false, entries: [] };
    entries.push(...result.entries);
    if (result.nextOffset === null || result.nextOffset === undefined) break;
    offset = result.nextOffset;
  }
  return { readEnabled: true, entries };
}

/**
 * Collect learned-memory satellites: the user scope once, plus one project
 * scope per project note `repo` path. Read-only; no Desktop write path exists.
 */
async function collectMemory(projectNodes) {
  const empty = { status: "unsupported", count: 0, byProject: new Map(), userEntries: [] };
  if (typeof globalThis.pi?.memory?.list !== "function") return empty;
  try {
    const byProject = new Map();
    let readEnabledSeen = true;
    const userEntries = [];
    for (const node of projectNodes) {
      const repo = typeof node.metadata?.repo === "string" ? node.metadata.repo.trim() : "";
      if (!repo) continue;
      const listed = await listAllMemoryEntries({ scope: "project", path: repo });
      if (!listed.readEnabled) {
        readEnabledSeen = false;
        break;
      }
      if (listed.entries.length > 0) byProject.set(node.path, listed.entries);
    }
    if (!readEnabledSeen) return { status: "disabled", count: 0, byProject: new Map(), userEntries: [] };
    const userListed = await listAllMemoryEntries({ scope: "user" });
    if (!userListed.readEnabled) return { status: "disabled", count: 0, byProject: new Map(), userEntries: [] };
    userEntries.push(...userListed.entries);
    const count =
      [...byProject.values()].reduce((sum, list) => sum + list.length, 0) + userEntries.length;
    return { status: "ok", count, byProject, userEntries };
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? "");
    if (/PERMISSION|FORBIDDEN|NOT_AUTHORIZED/i.test(code)) {
      return { status: "permission-missing", count: 0, byProject: new Map(), userEntries: [] };
    }
    return empty;
  }
}

function memoryDate(epochMs) {
  const value = new Date(epochMs);
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
}

function memoryTitle(entry) {
  const firstLine = String(entry.content ?? "").split("\n")[0].trim();
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine || `Memory ${entry.id}`;
}

/** Append memory satellites (nodes + links) to a built graph payload. */
function attachMemory(payload, memory) {
  if (memory.status !== "ok") return;
  payload.nodes.push({
    id: USER_CENTER_ID,
    title: "Me",
    cls: "memory",
    family: "memory",
    stale: false,
    archived: false,
    degree: memory.userEntries.length,
    chars: 0,
    issues: [],
  });
  for (const entry of memory.userEntries) {
    payload.nodes.push({
      id: `memory:${entry.id}`,
      title: memoryTitle(entry),
      cls: "memory",
      family: "memory",
      project: USER_CENTER_ID,
      status: undefined,
      stability: undefined,
      created: memoryDate(entry.createdAt),
      updated: memoryDate(entry.updatedAt),
      stale: false,
      archived: false,
      degree: 1,
      chars: String(entry.content ?? "").length,
      issues: [],
      memoryKind: entry.kind,
    });
    payload.links.push({ source: `memory:${entry.id}`, target: USER_CENTER_ID, predicate: "memory" });
  }
  for (const [projectPath, entries] of memory.byProject) {
    for (const entry of entries) {
      payload.nodes.push({
        id: `memory:${entry.id}`,
        title: memoryTitle(entry),
        cls: "memory",
        family: "memory",
        project: projectPath,
        created: memoryDate(entry.createdAt),
        updated: memoryDate(entry.updatedAt),
        stale: false,
        archived: false,
        degree: 1,
        chars: String(entry.content ?? "").length,
        issues: [],
        memoryKind: entry.kind,
      });
      payload.links.push({ source: `memory:${entry.id}`, target: projectPath, predicate: "memory" });
    }
  }
  payload.memory = { status: "ok", count: memory.count };
}

async function graph(payload) {
  const { buildGraphPayload } = await import("./lib/graph.mjs");
  const { index, ontology } = await ensureState();
  await index.refresh();
  const projectNodes = index
    .paths()
    .filter((relative) => relative.endsWith(".md"))
    .map((relative) => index.note(relative))
    .filter((record) => ontology.resolveClass(record.metadata.type) === "project");
  const includeMemory = payload?.includeMemory === true;
  const memory = includeMemory
    ? await collectMemory(projectNodes)
    : { status: "unsupported", count: 0, byProject: new Map(), userEntries: [] };
  const result = buildGraphPayload({
    index,
    ontology,
    vaultName: path.basename(state.vaultPath),
    memory: { status: memory.status, count: memory.count },
  });
  attachMemory(result, memory);
  state.memory = memory;
  return result;
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

function findMemoryEntry(memoryId) {
  const memory = state?.memory;
  if (!memory || memory.status !== "ok") return null;
  for (const entries of memory.byProject.values()) {
    const found = entries.find((entry) => entry.id === memoryId);
    if (found) return found;
  }
  return memory.userEntries.find((entry) => entry.id === memoryId) ?? null;
}

function promotionClass(kind) {
  return kind === "fact" || kind === "reference" ? "reference" : "record";
}

function promotionDraft(entry) {
  const title = memoryTitle(entry).replace(/[\\/:*?"<>|#^\[\]]/g, "-").replace(/\s+/g, " ").trim() || `Memory ${entry.id}`;
  const cls = promotionClass(entry.kind);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `type: ${cls}`,
    "status: active",
    `created: ${memoryDate(entry.createdAt) ?? new Date().toISOString().slice(0, 10)}`,
    `updated: ${memoryDate(entry.updatedAt) ?? new Date().toISOString().slice(0, 10)}`,
    'source: "memory:' + entry.id + '"',
    "stability: volatile",
    "review_interval: on-change",
    "---",
  ].join("\n");
  const rationale = entry.rationale ? `\n> ${String(entry.rationale).replace(/\n/g, "\n> ")}\n` : "";
  const content = `${frontmatter}\n# ${title}\n\n${entry.content}\n${rationale}\n- Promoted from Desktop learned memory (${entry.kind}, ${entry.origin}, ${entry.evidence}) on ${new Date().toISOString().slice(0, 10)}. Archiving the original entry is a separate, manual action in the memory manager.\n`;
  return { title, cls, content };
}

async function uniqueMemoryPath(baseTitle) {
  const { index } = await ensureState();
  const clean = baseTitle.replace(/[\\/:*?"<>|#^\[\]]/g, "-").trim();
  let candidate = `00 Inbox/Memory - ${clean}.md`;
  for (let suffix = 2; index.note(candidate); suffix += 1) {
    candidate = `00 Inbox/Memory - ${clean} ${suffix}.md`;
  }
  return candidate;
}

/**
 * Draft a note under `00 Inbox/` from a memory entry and show the dry-run
 * result. Nothing is written until kg.promote.apply (ADR 0001 §9).
 */
async function promotePreview(payload) {
  const memoryId = String(payload?.memoryId ?? "");
  const entry = findMemoryEntry(memoryId);
  if (!entry) throw refusal(`unknown memory entry: ${memoryId}`);
  const { createKnowledgeService } = await import("./mcp/knowledge-core.mjs");
  const service = await createKnowledgeService({ pluginRoot, vaultPath: state.vaultPath, config: state.config });
  const draft = promotionDraft(entry);
  const notePath = await uniqueMemoryPath(draft.title);
  const summary = await service.write({ path: notePath, content: draft.content, create: true });
  return { memoryId, draft: { path: notePath, content: draft.content }, summary };
}

/** Apply a confirmed promotion. Refused in read-only mode; every guard of
 * knowledge_write (dry-run off, CAS n/a for create, credential detector,
 * atomic write) still applies. */
async function promoteApply(payload) {
  if (isReadOnlyMode()) {
    throw new Error("promotion is refused because PERSONAL_KNOWLEDGE_READ_ONLY=1");
  }
  const notePath = String(payload?.path ?? "");
  const content = String(payload?.content ?? "");
  if (!notePath.startsWith("00 Inbox/") || !notePath.endsWith(".md")) {
    throw refusal("promotion writes only under 00 Inbox/ as .md");
  }
  const { createKnowledgeService } = await import("./mcp/knowledge-core.mjs");
  const service = await createKnowledgeService({ pluginRoot, vaultPath: state.vaultPath, config: state.config });
  const summary = await service.write({ path: notePath, content, create: true, dryRun: false });
  return { promoted: summary.action === "create", summary };
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
  if (channel === "kg.promote.preview") return promotePreview(payload);
  if (channel === "kg.promote.apply") return promoteApply(payload);
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
