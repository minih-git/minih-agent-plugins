/**
 * Personal Knowledge plugin backend (ADR 0001 §10 and §9; conversation archive
 * in ADR 0002).
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
 *
 * Since 0.5.0 the backend also runs the conversation archive syncer: one pass
 * at startup and one every five minutes, writing L2/L3 notes under
 * `09 Conversations/` for sessions the host reports through the read-only
 * `conversation.read` API (ADR 0002). The syncer owns the timer and stops with
 * the plugin.
 *
 * Since 0.7.0 the vault is read as plain Markdown: the drawer renders a note
 * instead of showing its raw text, follows its wikilinks, and the settings
 * panel derives the two dashboard tables the vault used to show through
 * Obsidian Bases (`docs/design/obsidian-independence.md`). Obsidian is
 * optional; `obsidian://` links stay as a secondary action.
 */
"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");

const { createReadOnlyState } = require("./lib/read-only.mjs");
const { createConfigStore, createPrefsStore, createConversationSettingsStore } = require("./lib/panel.mjs");
const { defaultDeviceName } = require("./lib/conversation-sync.mjs");

const pluginRoot = __dirname;
const manifest = require("./manifest.json");

/** Channels the page may call. Anything else is refused, not forwarded. */
const CHANNELS = new Set([
  "kg.graph",
  "kg.note",
  "kg.copyLink",
  "kg.copyPath",
  "kg.openExternal",
  "kg.dashboard",
  "kg.promote.preview",
  "kg.promote.apply",
  "kg.settings.get",
  "kg.settings.set",
  "kg.settings.test",
  "kg.config.get",
  "kg.config.set",
  "kg.routing.get",
  "kg.index.status",
  "kg.index.rebuild",
  "kg.memory.status",
  "kg.prefs.get",
  "kg.prefs.set",
  "kg.conversations.status",
  "kg.conversations.sync",
  "kg.profile.status",
  "kg.profile.set",
  "kg.profile.run",
  "kg.conversations.device",
  "kg.models.list",
  "kg.models.listEmbedding",
  "kg.openSettings",
]);

const MAX_PREVIEW_CHARS = 8000;
/** The only editable profile-candidate fields (`kg.profile.set`). */
const PROFILE_VALUES = new Set(["enabled", "modelKey"]);
const USER_CENTER_ID = "memory:user-center";

let state = null;
let panelStores = null;
let conversationSyncer = null;
let profileScheduler = null;
let syncDevices = null; // { store, name } — the device name the syncer writes under
let indexRun = null; // { controller, done, total, mode, error }
let lastIndexRun = null; // survives unload so status can still report

/**
 * The panel's stores. `pi.plugin.getDataPath` is async in the host contract
 * (`getDataPath: () => Promise<string>`), so this is async too and the first
 * caller's promise is shared: concurrent channels build the stores once.
 * A failed build clears the cache, so the next call can retry instead of
 * inheriting a rejected promise forever.
 */
function panelStoresFor() {
  if (!panelStores) {
    panelStores = buildPanelStores().catch((error) => {
      panelStores = null;
      throw error;
    });
  }
  return panelStores;
}

async function buildPanelStores() {
  const dataPath = await resolveDataPath();
  return {
    config: createConfigStore({ env: process.env, pluginRoot }),
    prefs: createPrefsStore({ dataPath }),
    devices: createConversationSettingsStore({ env: process.env }),
  };
}

/**
 * The plugin's data directory, or `null` when the host cannot provide one.
 * `createPrefsStore` treats a missing path as "unavailable" rather than
 * throwing, so a host without the API only loses the language preference.
 */
async function resolveDataPath() {
  const read = globalThis.pi?.plugin?.getDataPath;
  if (typeof read !== "function") return null;
  try {
    const value = await read.call(globalThis.pi.plugin);
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The name this computer archives under. A rename in the panel is stored in
 * `~/.personal-knowledge/conversation-settings.json`; until one exists the
 * host name is used, so the first pass has a stable value.
 */
async function currentDeviceName() {
  const { devices: store } = await panelStoresFor();
  const stored = await store.get();
  return stored.deviceName || defaultDeviceName();
}

/** The KnowledgeService for panel channels (vector index, notes count). */
/**
 * `pi.embeddings.embed`, bound to this process. It exists only here: the MCP
 * server is a separate child process with no `pi` (ADR 0003), so a host model
 * is called from the main process and nowhere else.
 */
function hostEmbed() {
  // `embeddings.embed` is the whole surface behind `embeddings.run`; naming it
  // here is also how the permission audit sees it is used.
  const api = globalThis.pi?.embeddings;
  if (typeof api?.embed !== "function") return null;
  const embed = api.embed.bind(api);
  return (input) => embed(input);
}

/** Whether this Desktop version can run an embedding model for the plugin. */
function hostEmbeddingAvailable() {
  return typeof globalThis.pi?.embeddings?.embed === "function";
}

async function ensurePanelService() {
  if (!state) throw new Error("plugin state is not initialized");
  if (!state.service) {
    const { createKnowledgeService } = await import("./mcp/knowledge-core.mjs");
    state.service = await createKnowledgeService({
      pluginRoot,
      vaultPath: state.vaultPath,
      config: state.config,
      hostEmbed: hostEmbed(),
    });
  }
  return state.service;
}

/**
 * In `host` mode the vectors of the query have to be computed here, because the
 * MCP server cannot reach `pi`. This embeds whatever the shared index still
 * misses, in the background, with a bounded budget; the search itself keeps
 * working through the lexical channel until it is done.
 */
async function maintainHostVectors() {
  if (!state) return null;
  const { loadEmbeddingSettings } = await loadEmbeddingLib();
  const service = await ensurePanelService();
  const settings = await loadEmbeddingSettings(embeddingSettingsPath()).catch(() => null);
  if (!settings || settings.provider !== "host" || !settings.enabled) return null;
  if (!hostEmbeddingAvailable()) return null;
  const pending = await service.pendingVectorCount();
  if (pending === 0) return null;
  await service.ensureVectors({ budgetMs: 60_000 }).catch(() => {});
  return pending;
}

function indexRunState() {
  if (!indexRun) return { running: false, done: 0, total: 0, mode: null };
  return { running: true, done: indexRun.done, total: indexRun.total, mode: indexRun.mode };
}

async function startIndexRun(mode) {
  if (indexRun) return { started: false, reason: "RUNNING" };
  const service = await ensurePanelService();
  await service.index.refresh();
  if (!service.embedding) return { started: false, reason: "DISABLED" };
  const controller = new AbortController();
  indexRun = { controller, done: 0, total: service.pendingChunkCount, mode, error: null };
  const run = service
    .ensureVectors({
      budgetMs: Number.POSITIVE_INFINITY,
      force: mode === "full",
      onProgress: ({ done, total }) => {
        if (indexRun) {
          indexRun.done = done;
          indexRun.total = total;
        }
      },
      signal: controller.signal,
    })
    .catch((error) => {
      if (indexRun) indexRun.error = error?.message ?? String(error);
    })
    .finally(() => {
      lastIndexRun = {
        running: false,
        done: indexRun?.done ?? 0,
        total: indexRun?.total ?? 0,
        mode,
        error: indexRun?.error ?? null,
      };
      indexRun = null;
    });
  void run;
  return { started: true };
}

async function indexStatusPayload() {
  if (!state) {
    // The plugin was unloaded; report the last run without touching the vault.
    return {
      enabled: false,
      vectorReady: false,
      notes: 0,
      chunks: 0,
      stored: 0,
      pending: 0,
      model: null,
      dims: null,
      writtenAt: null,
      running: false,
      done: lastIndexRun?.done ?? 0,
      total: lastIndexRun?.total ?? 0,
      reason: lastIndexRun?.error ? "ABORTED" : null,
    };
  }
  const service = await ensurePanelService();
  await service.index.refresh();
  const { stat } = await import("node:fs/promises");
  let writtenAt = null;
  try {
    writtenAt = (await stat(path.join(service.indexDirectory, "meta.json"))).mtime.toISOString();
  } catch {
    writtenAt = null;
  }
  const meta = service.vectors?.meta ?? null;
  const run = indexRunState();
  return {
    enabled: Boolean(service.embedding),
    vectorReady: Boolean(service.vectors?.vectors),
    notes: service.index.paths().filter((p) => p.endsWith(".md")).length,
    chunks: meta?.count ?? 0,
    stored: service.vectors?.chunks?.length ?? 0,
    pending: service.pendingChunkCount ?? 0,
    model: service.embedding?.settings?.model ?? null,
    dims: meta?.dims ?? null,
    writtenAt,
    running: run.running,
    done: run.done,
    total: run.total,
    reason: service.vectorReason ?? null,
  };
}

async function configPayload() {
  const service = await ensurePanelService();
  await service.index.refresh();
  const notesCount = service.index.paths().filter((p) => p.endsWith(".md")).length;
  const { config } = await panelStoresFor();
  return config.get({ notesCount });
}

async function routingPayload() {
  const service = await ensurePanelService();
  await service.index.refresh();
  const { config } = await panelStoresFor();
  return config.routing({
    noteExists: (note) => Boolean(service.index.note(note)) || Boolean(service.index.resolveTarget(note)),
  });
}

/**
 * `kg.dashboard`: the two `.base` tables ("活跃项目", "待复核知识") derived
 * from the shared index (`lib/dashboard.mjs`). Read-only; nothing is written
 * into the vault.
 */
async function dashboardPayload() {
  const { buildDashboard } = await import("./lib/dashboard.mjs");
  const { index } = await ensureState();
  // A user asking for the dashboard wants the vault as it is now, not as it
  // was within the refresh throttle.
  await index.refresh({ force: true });
  return buildDashboard({ index });
}

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

// Read-only: env wins, otherwise the repo-map `readOnly` key, re-read on
// mtime change so the settings panel flips it without a restart.
const readOnlyState = createReadOnlyState({ env: process.env });
async function isReadOnlyMode() {
  return readOnlyState.isReadOnly();
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
  // Memory satellites arrived after the payload was laid out; re-apply so
  // they get positions just outside their galaxy's event ring (design §13).
  const { applyUniverseLayout } = await import("./lib/layout.mjs");
  applyUniverseLayout(result, {
    navigationNamePatterns: ontology.navigationNamePatterns,
    projectTitlePrefixes: ontology.projectTitlePrefixes,
  });
  state.memory = memory;
  return result;
}

async function note(payload) {
  const { index, ontology, redactSensitiveContent } = await ensureState();
  await index.refresh();
  const requested = String(payload?.path ?? "");
  const resolved = index.resolveTarget(requested);
  if (!resolved || !resolved.endsWith(".md")) {
    throw refusal(`unknown note: ${requested}`);
  }
  // Re-read this one file: `refresh()` is throttled to one scan per second, so
  // a note written moments ago would otherwise render from a stale cache.
  await index.invalidate(resolved);
  if (!index.note(resolved)) throw refusal(`unknown note: ${requested}`);
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
  // Resolution stays here: the renderer draws what this answers instead of
  // re-implementing `resolveTarget` (obsidian-independence §2).
  const links = bodyWikilinks(record.raw).map((raw) => ({
    raw,
    resolved: index.resolveTarget(raw),
  }));
  return {
    path: resolved,
    absolutePath: path.join(index.root, ...resolved.split("/")),
    title: record.title,
    metadata: record.metadata,
    outline: record.outline,
    sha256: record.sha256,
    redacted: safe !== record.raw,
    content: safe.slice(0, MAX_PREVIEW_CHARS),
    truncated: safe.length > MAX_PREVIEW_CHARS,
    issues,
    backlinks: index.backlinksOf(resolved),
    links,
  };
}

/**
 * Wikilink targets in first-appearance order, as written (`target#heading`
 * normalized by `normalizeLinkTarget`). The note's own `linkTargets` also
 * carries frontmatter links, which the drawer does not render.
 */
function bodyWikilinks(raw) {
  const targets = [];
  for (const match of String(raw ?? "").matchAll(/!?\[\[([^\][]+)\]\]/g)) {
    const target = match[1].split("|")[0].split("#")[0].trim();
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

/** `kg.copyPath`: the note's absolute path, for pasting into any editor. */
async function copyPath(payload) {
  const { index } = await ensureState();
  const requested = String(payload?.path ?? "");
  const resolved = index.resolveTarget(requested);
  if (!resolved || !index.note(resolved)) throw refusal(`unknown note: ${requested}`);
  const absolutePath = path.join(index.root, ...resolved.split("/"));
  if (typeof globalThis.pi?.clipboard?.writeText !== "function") {
    throw new Error("clipboard unavailable in this host");
  }
  await globalThis.pi.clipboard.writeText(absolutePath);
  return { copied: true, path: absolutePath };
}

/**
 * `kg.openExternal`: http(s) only. The renderer never puts a note's URL into
 * a live link itself; a refused scheme stays text.
 */
async function openExternal(payload) {
  const url = String(payload?.url ?? "").trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw refusal(`not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw refusal(`only http(s) links can be opened: ${parsed.protocol}`);
  }
  const api = globalThis.pi?.shell;
  if (typeof api?.openExternal !== "function") {
    throw new Error("this host does not expose pi.shell.openExternal");
  }
  await api.openExternal(url);
  return { opened: true, url };
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
  if (await isReadOnlyMode()) {
    throw new Error(`promotion is refused: ${readOnlyState.refusalReason()}.`);
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
  if (settings && settings.apiKeyEnv && settings.provider !== "host") {
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
  const isHost = settings.provider === "host";
  const key = isHost ? { status: "not-required", value: null } : await resolveApiKey(settings.apiKeyEnv, { home: os.homedir() });
  if (!isHost && settings.apiKeyEnv && key.status !== "found") {
    return { ok: false, reason: "EMBEDDING_KEY_MISSING", message: `environment variable ${settings.apiKeyEnv} has no value` };
  }
  const client = new EmbeddingClient({
    settings,
    apiKey: key.value,
    home: os.homedir(),
    hostEmbed: isHost ? hostEmbed() : null,
  });
  try {
    const [vector] = await client.embed(["personal-knowledge connection test"]);
    return { ok: true, dims: vector.length, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: error.code ?? "EMBED_FAILED", message: error.message };
  }
}

/**
 * Rename this computer for the archive (`kg.conversations.device`). The name is
 * stored locally and only affects notes written from now on: files already on
 * disk keep the name they were written under and stay this computer's.
 */
async function setDeviceName(deviceName) {
  const { devices } = await panelStoresFor();
  const stored = await devices.setDeviceName(deviceName);
  if (syncDevices) syncDevices.name = stored.deviceName;
  return { saved: true, deviceName: stored.deviceName };
}



/**
 * `kg.profile.set`: the only two editable profile-candidate fields. Anything
 * else is refused by name rather than ignored, so a typo cannot look saved.
 */
async function setProfileSettings(values) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw refusal("kg.profile.set accepts { values: { enabled?, modelKey? } }");
  }
  const unknown = Object.keys(values).filter((key) => !PROFILE_VALUES.has(key));
  if (unknown.length > 0) {
    throw refusal(`kg.profile.set accepts only enabled and modelKey; refused: ${unknown.join(", ")}`);
  }
  const { profileSettingsPath, readProfileSettings } = await import("./lib/profile-candidates.mjs");
  const filePath = profileSettingsPath();
  const current = await readProfileSettings(filePath);
  const next = { ...current };
  if ("enabled" in values) {
    if (typeof values.enabled !== "boolean") throw refusal("enabled must be a boolean");
    next.enabled = values.enabled;
  }
  if ("modelKey" in values) {
    if (values.modelKey !== null && typeof values.modelKey !== "string") {
      throw refusal("modelKey must be a string or null");
    }
    const key = String(values.modelKey ?? "").trim();
    if (key && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(key)) {
      throw refusal("modelKey must look like providerId/modelId");
    }
    next.modelKey = key || null;
  }
  await writeProfileSettingsFile(filePath, next);
  return { saved: true, values: { enabled: next.enabled === true, modelKey: next.modelKey ?? null } };
}

/** Write the settings file atomically with owner-only permissions. */
async function writeProfileSettingsFile(filePath, values) {
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Draft an L0 profile candidate into `00 Inbox/` (ADR 0002 §6, §8). The profile
 * note is never edited here; merging stays the user's action.
 *
 * `manual` marks a run the user asked for from the panel: it ignores the
 * one-per-week window but still needs the switch, a model, and a writable
 * vault. The automatic schedule passes `manual: false`.
 */
async function profileRun(payload, { manual = true } = {}) {
  const { runProfileCandidate } = await import("./lib/profile-candidates.mjs");
  await ensureState();
  const service = await ensurePanelService();
  if (await isReadOnlyMode()) {
    throw new Error(`profile candidates are refused: ${readOnlyState.refusalReason()}.`);
  }
  if (!service.pi) service.pi = globalThis.pi ?? null;
  const settings = payload?.settings ?? undefined;
  const result = await runProfileCandidate({ service, settings, manual });
  return { result, ...(await profileStatus()) };
}

async function onPanelInvoke(channel, payload) {
  if (!CHANNELS.has(channel)) throw refusal(`unknown channel: ${channel}`);
  if (channel === "kg.graph") return graph(payload);
  if (channel === "kg.note") return note(payload);
  if (channel === "kg.copyLink") return copyLink(payload);
  if (channel === "kg.copyPath") return copyPath(payload);
  if (channel === "kg.openExternal") return openExternal(payload);
  if (channel === "kg.dashboard") return dashboardPayload();
  if (channel === "kg.promote.preview") return promotePreview(payload);
  if (channel === "kg.promote.apply") return promoteApply(payload);
  if (channel === "kg.settings.get") return settingsGet();
  if (channel === "kg.settings.set") {
    const saved = await settingsSet(payload);
    // A provider change decides whether this process owns the retrieval tools,
    // and whether the model needs a reload to stop seeing two copies.
    const tools = await syncKnowledgeTools().catch(() => null);
    return {
      ...saved,
      tools: {
        ...tools,
        // The MCP server lists its tools from the configuration it read when
        // it started; no API restarts that connection.
        agentReloadRequired: Boolean(tools?.mcpListsRetrieval) !== (saved.settings?.provider !== "host"),
      },
    };
  }
  if (channel === "kg.settings.test") return settingsTest(payload);
  if (channel === "kg.config.get") return configPayload();
  if (channel === "kg.config.set") {
    const { config } = await panelStoresFor();
    const result = await config.set(payload?.values ?? {});
    return { saved: result.saved, reloadRequired: result.reloadRequired };
  }
  if (channel === "kg.routing.get") return routingPayload();
  if (channel === "kg.index.status") return indexStatusPayload();
  if (channel === "kg.index.rebuild") {
    const mode = payload?.mode === "full" ? "full" : payload?.mode === "incremental" ? "incremental" : null;
    if (!mode) throw refusal("kg.index.rebuild requires mode \"incremental\" or \"full\"");
    return startIndexRun(mode);
  }
  if (channel === "kg.memory.status") {
    if (typeof globalThis.pi?.memory?.list !== "function") return { readEnabled: false };
    const listed = await globalThis.pi.memory.list({ limit: 1 });
    return { readEnabled: listed.readEnabled !== false };
  }
  if (channel === "kg.conversations.status") {
    if (conversationSyncer) return conversationSyncer.status();
    // The syncer is off (no host API, or the vault failed to load): still
    // report the device and enablement so the panel can explain why.
    const { devices } = await panelStoresFor();
    const stored = await devices.get();
    return {
      state: globalThis.pi?.conversations?.changes ? "stopped" : "unsupported",
      device: stored.deviceName || defaultDeviceName(),
      storedDeviceName: stored.deviceName ?? null,
    };
  }
  if (channel === "kg.conversations.sync") {
    if (!conversationSyncer) return { state: "stopped" };
    return conversationSyncer.syncOnce({ reason: "manual" });
  }
  if (channel === "kg.conversations.device") {
    return setDeviceName(payload?.deviceName);
  }
  if (channel === "kg.profile.set") {
    return setProfileSettings(payload?.values ?? {});
  }
  if (channel === "kg.profile.status") return profileStatus();
  if (channel === "kg.models.listEmbedding") {
    const answer = { models: [], hostSupported: hostEmbeddingAvailable() };
    if (!hostEmbeddingAvailable() || typeof globalThis.pi?.models?.list !== "function") return answer;
    try {
      // `kind` is the Desktop 1.5.0 contract; an older host ignores it and
      // returns chat models, which are filtered out below.
      const listed = await globalThis.pi.models.list({ kind: "embedding" });
      answer.models = (Array.isArray(listed) ? listed : [])
        .filter((model) => model?.kind === "embedding" || model?.kind === undefined)
        .map((model) => ({
          key: String(model?.key ?? ""),
          label: String(model?.alias || model?.label || model?.modelId || model?.key || ""),
          providerName: String(model?.providerName ?? ""),
        }))
        .filter((model) => model.key);
    } catch {
      answer.models = [];
    }
    return answer;
  }
  if (channel === "kg.models.list") {
    // `models.list` is a read-only catalog of the user's configured models.
    if (typeof globalThis.pi?.models?.list !== "function") return { models: [] };
    const listed = await globalThis.pi.models.list();
    return {
      models: (Array.isArray(listed) ? listed : []).map((model) => ({
        key: String(model?.key ?? ""),
        label: String(model?.alias || model?.label || model?.modelId || model?.key || ""),
      })),
    };
  }
  if (channel === "kg.profile.run") {
    return profileRun(payload);
  }
  if (channel === "kg.prefs.get") return (await panelStoresFor()).prefs.get();
  if (channel === "kg.prefs.set") return (await panelStoresFor()).prefs.set(String(payload?.language ?? ""));
  if (channel === "kg.openSettings") {
    if (typeof globalThis.pi?.ui?.openPanel !== "function") {
      throw refusal("this host does not expose pi.ui.openPanel");
    }
    await globalThis.pi.ui.openPanel();
    return { opened: true };
  }
  throw refusal(`unknown channel: ${channel}`);
}

/**
 * Start the conversation archive syncer (ADR 0002 §1). It needs the read-only
 * `conversation.read` API and a vault that exists; anything missing leaves it
 * off without failing the plugin load.
 *
 * The API is injected into the syncer, which calls `changes`, `summary` and
 * `transcript` through it. This check is the one place in this file that names
 * the surface (an audit reads the entry file), so it stays fully qualified.
 */
async function startConversationSync() {
  if (conversationSyncer) return conversationSyncer;
  // `changes` is the feed this feature is built on; it is the one hard
  // requirement. `summary` and `transcript` are used by the syncer when the
  // host provides them, and it degrades on its own when it does not.
  const conversations = globalThis.pi?.conversations ?? null;
  if (conversations === null) return null;
  // Fully qualified on purpose: the entry file is what the permission audit
  // reads, so the surface this feature depends on is named, not aliased.
  if (typeof conversations.changes !== "function") return null;
  const { ConversationSyncer, archiveConfig } = await import("./lib/conversation-sync.mjs");
  const loaded = await ensureState().catch(() => null);
  if (!loaded) return null;
  const { redactSensitiveContent } = await import("./lib/redact.mjs");
  const device = await currentDeviceName();
  syncDevices = { name: device };
  conversationSyncer = new ConversationSyncer({
    pi: globalThis.pi,
    vaultRoot: loaded.index.root,
    config: archiveConfig(loaded.config ?? {}),
    redact: redactSensitiveContent,
    device,
    deviceProvider: () => syncDevices?.name ?? device,
  });
  conversationSyncer.start();
  return conversationSyncer;
}

async function profileStatus() {
  const { candidateDue, profileSettingsPath, readProfileSettings } = await import("./lib/profile-candidates.mjs");
  const state = await readProfileSettings(profileSettingsPath());
  const due = candidateDue(state);
  return {
    settings: { enabled: state.enabled === true, modelKey: state.modelKey ?? null },
    lastRunAt: state.lastRunAt ?? null,
    lastError: state.lastError ?? null,
    lastCandidate: state.lastCandidate ?? null,
    due,
  };
}

/**
 * Start the weekly profile-candidate check (ADR 0002 §8). It runs only while
 * the switch is on, never in read-only mode, and never faster than
 * `candidateDue` allows; the timer stops with the plugin.
 */
async function startProfileScheduler() {
  if (profileScheduler) return profileScheduler;
  const { ProfileCandidateScheduler } = await import("./lib/profile-candidates.mjs");
  profileScheduler = new ProfileCandidateScheduler({
    settings: async () => (await profileStatus()).settings,
    run: () => profileRun({}, { manual: false }),
    isReadOnly: isReadOnlyMode,
  });
  profileScheduler.start();
  return profileScheduler;
}

/**
 * The retrieval tools, registered in this process (ADR 0003 §2).
 *
 * `pi.embeddings.embed` exists only here, so in `host` mode a query can only be
 * turned into a vector here — the MCP server withholds `knowledge_search` and
 * `conversation_search` in that mode (it reads `embedding.json` at startup) and
 * this process serves them instead, over the same `KnowledgeService`, index,
 * and vector file.
 *
 * The two sets are named differently (`plugin_<id>_<tool>` here,
 * `plugin_<id>_<serverId>_<tool>` on the MCP side), and keeping the model from
 * seeing both depends on *when* each side changes:
 *
 *  - entering `host` mode registers here immediately, and the MCP server still
 *    lists its copies until it reconnects, so both briefly exist;
 *  - leaving `host` mode must NOT unregister here until the MCP server lists
 *    them again, or the agent would be left with no retrieval tool at all.
 *
 * The host reads `tools/list` once per MCP connection and ignores
 * `notifications/tools/list_changed`, and no plugin API restarts that
 * connection, so the MCP side only changes when the plugin or the app is
 * reloaded. Until then the safer of the two states is kept: a duplicate, never
 * a gap.
 */
let knowledgeTools = null; // [name, ...] registered by this process

/**
 * Whether the MCP server lists the retrieval tools for this install: it
 * decides at startup, so this mirrors what it saw when the plugin loaded.
 */
let mcpListsRetrievalTools = true;

/** Whether the query vector must be computed here (host model or host-vector index). */
async function needsHostQueryVectors() {
  if (!hostEmbeddingAvailable()) return false;
  try {
    const { loadEmbeddingSettings } = await loadEmbeddingLib();
    const settings = await loadEmbeddingSettings(embeddingSettingsPath());
    return settings.enabled && settings.provider === "host";
  } catch {
    return false;
  }
}

async function registerKnowledgeTools() {
  if (knowledgeTools) return knowledgeTools;
  const api = globalThis.pi?.agent;
  // `agent.registerTool` is the surface behind `agent.tool.register`.
  if (typeof api?.registerTool !== "function") return null;
  const { TOOL_SCHEMAS, renderMainProcessTool, MAIN_PROCESS_TOOLS } = await import("./mcp/tool-text.mjs");
  const registered = [];
  for (const name of MAIN_PROCESS_TOOLS) {
    const schema = TOOL_SCHEMAS[name];
    await api.registerTool({
      name,
      description: schema.description,
      risk: "low",
      schema: schema.inputSchema,
      execute: async (args) => runKnowledgeTool(name, args, renderMainProcessTool),
    });
    registered.push(name);
  }
  knowledgeTools = registered;
  return knowledgeTools;
}

async function unregisterKnowledgeTools() {
  const registered = knowledgeTools;
  knowledgeTools = null;
  if (!registered) return;
  const api = globalThis.pi?.agent;
  if (typeof api?.unregisterTool !== "function") return;
  for (const name of registered) {
    await api.unregisterTool(name).catch(() => {});
  }
}

/**
 * Run one of the two retrieval tools with the query vector computed here. The
 * text the model reads is the same as the MCP tool's, so the two paths cannot
 * answer differently.
 */
async function runKnowledgeTool(name, args, render) {
  const input = args ?? {};
  const service = await ensurePanelService();
  const embedQuery = async (text) => {
    const [vector] = await service.embedding.embed([text]);
    return vector;
  };
  if (name === "knowledge_search") {
    const value = await service.search(input, { embedQuery });
    return render(name, value);
  }
  const value = await service.conversationSearch(input);
  return render(name, value);
}

/**
 * Keep the registered tools in step with the current provider, within the
 * limit the MCP side imposes (see above): register as soon as host mode is
 * on, and unregister on leaving it only when the MCP server is known to list
 * the tools again — otherwise they stay until the plugin reloads.
 */
async function syncKnowledgeTools({ startup = false } = {}) {
  const wanted = await needsHostQueryVectors();
  if (startup) {
    // The MCP server read `embedding.json` a moment ago on its own start; the
    // file has not changed since unless the user edited it by hand.
    mcpListsRetrievalTools = !wanted;
  }
  if (wanted && !knowledgeTools) {
    await registerKnowledgeTools();
    return { registered: true, mcpListsRetrieval: mcpListsRetrievalTools };
  }
  if (!wanted && knowledgeTools) {
    if (mcpListsRetrievalTools) {
      await unregisterKnowledgeTools();
      return { registered: false, mcpListsRetrieval: true };
    }
    // The MCP server still withholds them: removing ours would leave the agent
    // with no retrieval tool, so they stay until the plugin is reloaded.
    return { registered: true, mcpListsRetrieval: false, deferred: true };
  }
  return { registered: Boolean(knowledgeTools), mcpListsRetrieval: mcpListsRetrievalTools, deferred: false };
}

async function onLoad() {
  // Warm the index so the first view render does not pay for the vault scan.
  await ensureState().catch(() => {});
  await startConversationSync().catch(() => null);
  await startProfileScheduler().catch(() => null);
  await syncKnowledgeTools({ startup: true }).catch(() => null);
}

async function onUnload() {
  await unregisterKnowledgeTools().catch(() => {});
  if (profileScheduler) {
    const scheduler = profileScheduler;
    profileScheduler = null;
    await scheduler.stop().catch(() => {});
  }
  if (conversationSyncer) {
    const syncer = conversationSyncer;
    conversationSyncer = null;
    await syncer.stop().catch(() => {});
  }
  indexRun?.controller?.abort();
  indexRun = null;
  panelStores = null;
  state = null;
}

module.exports = { name: manifest.id, version: manifest.version, onLoad, onUnload, onPanelInvoke };
