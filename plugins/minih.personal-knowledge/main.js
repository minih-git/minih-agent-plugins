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

const path = require("node:path");

const pluginRoot = __dirname;
const manifest = require("./manifest.json");

/** Channels the page may call. Anything else is refused, not forwarded. */
const CHANNELS = new Set(["kg.graph", "kg.note", "kg.copyLink"]);

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
  state = { index, ontology, redactSensitiveContent, locateSection, vaultPath };
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

async function onPanelInvoke(channel, payload) {
  if (!CHANNELS.has(channel)) throw refusal(`unknown channel: ${channel}`);
  if (channel === "kg.graph") return graph(payload);
  if (channel === "kg.note") return note(payload);
  if (channel === "kg.copyLink") return copyLink(payload);
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
