import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SEARCH_EXTENSIONS = new Set([".md", ".base"]);
const WRITE_EXTENSION = ".md";
const DEFAULT_MAX_READ_CHARS = 24_000;
const DEFAULT_MAX_CONTEXT_CHARS = 32_000;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeRelative(value, { extensions = SEARCH_EXTENSIONS } = {}) {
  const raw = requireString(value, "path").replaceAll("\\", "/");
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("path must be relative to the knowledge vault.");
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    normalized === "." ||
    parts.some((part) => part === "" || part === ".." || part.startsWith("."))
  ) {
    throw new Error("path contains an unsafe or hidden component.");
  }
  if (!extensions.has(path.posix.extname(normalized).toLowerCase())) {
    throw new Error(`path must end with one of: ${[...extensions].join(", ")}.`);
  }
  return normalized;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function stripQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return {};
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const data = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === "") {
      data[key] = "";
      continue;
    }
    if (rawValue === "true" || rawValue === "false") {
      data[key] = rawValue === "true";
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      data[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((part) => stripQuotes(part.trim()))
        .filter(Boolean);
      continue;
    }
    data[key] = stripQuotes(rawValue);
  }
  return data;
}

function safePlaceholder(value) {
  return /^(?:\[?redacted\]?|\*+|x+|<[^>]+>|\$\{[^}]+\}|env|environment|stored|managed|none|n\/a)$/i.test(
    value,
  );
}

export function findSensitiveContent(content) {
  const findings = [];
  const fixedPatterns = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["api-token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];
  for (const [kind, pattern] of fixedPatterns) {
    if (pattern.test(content)) findings.push({ kind });
  }

  const assignment = /\b(password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`]{8,})/gi;
  for (const match of content.matchAll(assignment)) {
    const value = match[2];
    if (!safePlaceholder(value)) {
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ kind: "credential-assignment", line, key: match[1] });
    }
  }
  return findings;
}

export function redactSensitiveContent(content) {
  let redacted = content
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED ACCESS KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]");
  redacted = redacted.replace(
    /(\b(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?)([^\s"'`]{8,})/gi,
    (full, prefix, value) => (safePlaceholder(value) ? full : `${prefix}[REDACTED]`),
  );
  return redacted;
}

function snippetFor(content, terms, maximum = 280) {
  const normalized = redactSensitiveContent(content).replace(/\s+/g, " ").trim();
  const lowered = normalized.toLowerCase();
  const positions = terms
    .map((term) => lowered.indexOf(term))
    .filter((position) => position >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - 80);
  const end = Math.min(normalized.length, start + maximum);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function titleFor(relativePath, metadata) {
  return typeof metadata.title === "string" && metadata.title.trim()
    ? metadata.title.trim()
    : path.posix.basename(relativePath, path.posix.extname(relativePath));
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeLinkTarget(value) {
  return value.trim().replaceAll("\\", "/").replace(/\.md$/i, "");
}

function outgoingLinks(content) {
  return unique(
    [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) =>
      normalizeLinkTarget(match[1]),
    ),
  );
}

async function walk(root, current, ignoredTopLevel, output) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const topLevel = relative.split("/")[0];
    if (ignoredTopLevel.has(topLevel)) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, ignoredTopLevel, output);
      continue;
    }
    if (entry.isFile() && SEARCH_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(relative);
    }
  }
}

function splitTerms(query) {
  return unique(
    requireString(query, "query")
      .toLowerCase()
      .split(/[\s|]+/)
      .map((term) => term.trim())
      .filter(Boolean),
  );
}

function dateAgeDays(value, today) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((today.getTime() - parsed.getTime()) / 86_400_000);
}

function lineChangeSummary(before, after) {
  const beforeLines = before === "" ? 0 : before.split(/\r?\n/).length;
  const afterLines = after === "" ? 0 : after.split(/\r?\n/).length;
  return { beforeLines, afterLines, deltaLines: afterLines - beforeLines };
}

export class KnowledgeService {
  constructor({ vaultPath, config = {}, now = () => new Date() }) {
    this.vaultPath = path.resolve(vaultPath);
    this.config = config;
    this.now = now;
    this.rootRealpath = null;
  }

  async initialize() {
    const info = await stat(this.vaultPath);
    if (!info.isDirectory()) throw new Error(`Knowledge vault is not a directory: ${this.vaultPath}`);
    this.rootRealpath = await realpath(this.vaultPath);
    return this;
  }

  async root() {
    if (!this.rootRealpath) await this.initialize();
    return this.rootRealpath;
  }

  async listFiles() {
    const root = await this.root();
    const output = [];
    const ignored = new Set(this.config.ignoreFolders ?? []);
    await walk(root, root, ignored, output);
    return output.sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  async resolveExisting(relativePath) {
    const normalized = normalizeRelative(relativePath);
    const root = await this.root();
    const lexical = path.resolve(root, ...normalized.split("/"));
    if (!isInside(root, lexical)) throw new Error("path escapes the knowledge vault.");
    const resolved = await realpath(lexical);
    if (!isInside(root, resolved)) throw new Error("path resolves outside the knowledge vault.");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("path must identify a regular file.");
    if (info.size > MAX_NOTE_BYTES) throw new Error("note is larger than the supported 2 MB limit.");
    return { absolute: resolved, relative: normalized, info };
  }

  async findNote(note) {
    const raw = requireString(note, "note").replaceAll("\\", "/");
    const exactCandidates = [];
    if (SEARCH_EXTENSIONS.has(path.posix.extname(raw).toLowerCase())) {
      exactCandidates.push(raw);
    } else {
      exactCandidates.push(`${raw}.md`, `${raw}.base`);
    }
    for (const candidate of exactCandidates) {
      try {
        return await this.resolveExisting(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          if (!String(error.message).includes("no such file")) throw error;
        }
      }
    }

    const normalizedNeedle = normalizeLinkTarget(raw).toLowerCase();
    const matches = [];
    for (const relative of await this.listFiles()) {
      const basename = normalizeLinkTarget(path.posix.basename(relative)).toLowerCase();
      const withoutExtension = normalizeLinkTarget(relative).toLowerCase();
      if (basename === normalizedNeedle || withoutExtension === normalizedNeedle) matches.push(relative);
    }
    if (matches.length === 0) throw new Error(`Knowledge note not found: ${raw}`);
    if (matches.length > 1) throw new Error(`Knowledge note is ambiguous: ${matches.join(", ")}`);
    return this.resolveExisting(matches[0]);
  }

  async read({ note, maxChars } = {}) {
    const limit = boundedInteger(maxChars, DEFAULT_MAX_READ_CHARS, 1_000, 100_000, "maxChars");
    const resolved = await this.findNote(note);
    const raw = await readFile(resolved.absolute, "utf8");
    const metadata = parseFrontmatter(raw);
    const safe = redactSensitiveContent(raw);
    return {
      path: resolved.relative,
      title: titleFor(resolved.relative, metadata),
      metadata,
      sha256: sha256(raw),
      truncated: safe.length > limit,
      content: safe.slice(0, limit),
    };
  }

  async search({ query, scope, mode = "all", limit } = {}) {
    const terms = splitTerms(query);
    if (!new Set(["all", "any"]).has(mode)) throw new Error('mode must be "all" or "any".');
    const resultLimit = boundedInteger(limit, 20, 1, 100, "limit");
    let normalizedScope = null;
    if (scope !== undefined) {
      const rawScope = requireString(scope, "scope").replaceAll("\\", "/");
      if (path.posix.isAbsolute(rawScope) || rawScope.split("/").some((part) => part === "..")) {
        throw new Error("scope must stay inside the knowledge vault.");
      }
      normalizedScope = path.posix.normalize(rawScope).replace(/^\.\//, "").replace(/\/$/, "");
    }

    const results = [];
    for (const relative of await this.listFiles()) {
      if (normalizedScope && relative !== normalizedScope && !relative.startsWith(`${normalizedScope}/`)) continue;
      const { absolute } = await this.resolveExisting(relative);
      const raw = await readFile(absolute, "utf8");
      const metadata = parseFrontmatter(raw);
      const title = titleFor(relative, metadata);
      const searchable = `${relative}\n${title}\n${raw}`.toLowerCase();
      const matches = terms.map((term) => searchable.includes(term));
      if (mode === "all" ? matches.some((matched) => !matched) : matches.every((matched) => !matched)) continue;
      const loweredPath = relative.toLowerCase();
      const loweredTitle = title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (loweredPath.includes(term)) score += 12;
        if (loweredTitle.includes(term)) score += 8;
        score += Math.min(5, searchable.split(term).length - 1);
      }
      results.push({
        path: relative,
        title,
        type: metadata.type ?? null,
        status: metadata.status ?? null,
        updated: metadata.updated ?? null,
        verified: metadata.verified ?? null,
        score,
        snippet: snippetFor(raw, terms),
      });
    }
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "zh-CN"));
    return { query, mode, count: Math.min(results.length, resultLimit), results: results.slice(0, resultLimit) };
  }

  async context({ cwd, topic = "", maxChars } = {}) {
    const totalLimit = boundedInteger(maxChars, DEFAULT_MAX_CONTEXT_CHARS, 4_000, 100_000, "maxChars");
    const workingPath = typeof cwd === "string" && cwd.trim() ? path.resolve(cwd.trim()) : "";
    const loweredTopic = String(topic ?? "").toLowerCase();
    const projects = (this.config.projects ?? []).filter((project) => {
      const pathMatch = workingPath && (project.repoPrefixes ?? []).some((prefix) => {
        const resolvedPrefix = path.resolve(prefix);
        return workingPath === resolvedPrefix || workingPath.startsWith(`${resolvedPrefix}${path.sep}`);
      });
      const aliasMatch = loweredTopic && (project.aliases ?? []).some((alias) => loweredTopic.includes(String(alias).toLowerCase()));
      return pathMatch || aliasMatch;
    });
    const routes = (this.config.topicRoutes ?? []).filter((route) =>
      loweredTopic && (route.aliases ?? []).some((alias) => loweredTopic.includes(String(alias).toLowerCase())),
    );
    const requestedNotes = unique([
      ...projects.flatMap((project) => project.notes ?? []),
      ...routes.flatMap((route) => route.notes ?? []),
      ...(this.config.defaultNotes ?? []),
    ]);
    const summaryLimit = boundedInteger(
      this.config.defaultNoteSummaryChars,
      4_000,
      1_000,
      12_000,
      "config.defaultNoteSummaryChars",
    );
    const isDefaultNote = (candidate) =>
      (this.config.defaultNotes ?? []).includes(candidate);
    const perNoteLimit = boundedInteger(
      this.config.contextPerNoteChars,
      24_000,
      4_000,
      60_000,
      "config.contextPerNoteChars",
    );

    const notes = [];
    const missing = [];
    let remaining = totalLimit;
    for (const requested of requestedNotes) {
      if (remaining <= 0) break;
      const limit = Math.min(
        isDefaultNote(requested) ? summaryLimit : perNoteLimit,
        remaining,
      );
      try {
        const note = await this.read({ note: requested, maxChars: limit });
        notes.push(note);
        remaining -= note.content.length;
      } catch (error) {
        missing.push({ path: requested, error: error.message });
      }
    }
    return {
      cwd: workingPath || null,
      topic: topic || null,
      matchedProjects: projects.map((project) => project.name),
      matchedRoutes: routes.map((route) => route.name),
      requestedNotes,
      notes,
      missing,
      truncated: remaining <= 0,
      noteOrder: "project/route notes first, then default notes (head-only)",
    };
  }

  async stale({ limit, includeUnverified = true } = {}) {
    const resultLimit = boundedInteger(limit, 100, 1, 500, "limit");
    const today = this.now();
    const due = [];
    for (const relative of await this.listFiles()) {
      if (!relative.endsWith(".md")) continue;
      const { absolute } = await this.resolveExisting(relative);
      const raw = await readFile(absolute, "utf8");
      const metadata = parseFrontmatter(raw);
      const interval = metadata.review_interval;
      if (!interval || interval === "none") continue;
      const ageDays = dateAgeDays(metadata.verified, today);
      let reason = null;
      let thresholdDays = null;
      if (ageDays === null) {
        if (includeUnverified) reason = "unverified";
      } else if (interval === "monthly") {
        thresholdDays = 30;
        if (ageDays > thresholdDays) reason = "past-review-window";
      } else if (interval === "quarterly") {
        thresholdDays = 90;
        if (ageDays > thresholdDays) reason = "past-review-window";
      } else if (interval !== "on-change") {
        reason = "unknown-review-interval";
      }
      if (!reason) continue;
      due.push({
        path: relative,
        title: titleFor(relative, metadata),
        type: metadata.type ?? null,
        stability: metadata.stability ?? null,
        reviewInterval: interval,
        verified: metadata.verified ?? null,
        ageDays,
        thresholdDays,
        reason,
      });
    }
    due.sort((a, b) => {
      if (a.reason === "unverified" && b.reason !== "unverified") return -1;
      if (b.reason === "unverified" && a.reason !== "unverified") return 1;
      return (b.ageDays ?? 0) - (a.ageDays ?? 0) || a.path.localeCompare(b.path, "zh-CN");
    });
    return { count: Math.min(due.length, resultLimit), due: due.slice(0, resultLimit) };
  }

  async links({ note } = {}) {
    const resolved = await this.findNote(note);
    const raw = await readFile(resolved.absolute, "utf8");
    const targetRelative = normalizeLinkTarget(resolved.relative);
    const targetBasename = normalizeLinkTarget(path.posix.basename(resolved.relative));
    const backlinks = [];
    for (const relative of await this.listFiles()) {
      if (!relative.endsWith(".md") || relative === resolved.relative) continue;
      const candidate = await this.resolveExisting(relative);
      const candidateContent = await readFile(candidate.absolute, "utf8");
      const links = outgoingLinks(candidateContent);
      if (links.some((link) => link === targetRelative || link === targetBasename)) backlinks.push(relative);
    }
    return {
      path: resolved.relative,
      outgoing: outgoingLinks(raw),
      backlinks: backlinks.sort((a, b) => a.localeCompare(b, "zh-CN")),
    };
  }

  async write({ path: notePath, content, expectedSha256, dryRun = true, create = false } = {}) {
    const relative = normalizeRelative(notePath, { extensions: new Set([WRITE_EXTENSION]) });
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("content must be a non-empty string.");
    }
    const normalizedContent = `${content.replace(/\s+$/, "")}\n`;
    if (Buffer.byteLength(normalizedContent, "utf8") > MAX_NOTE_BYTES) {
      throw new Error("content is larger than the supported 2 MB limit.");
    }
    const metadata = parseFrontmatter(normalizedContent);
    if (!metadata.title || !metadata.type) {
      throw new Error("content must include frontmatter with non-empty title and type properties.");
    }
    const sensitive = findSensitiveContent(normalizedContent);
    if (sensitive.length) {
      throw new Error(`content appears to contain sensitive credentials: ${sensitive.map((item) => item.kind).join(", ")}`);
    }

    const root = await this.root();
    const absolute = path.resolve(root, ...relative.split("/"));
    if (!isInside(root, absolute)) throw new Error("path escapes the knowledge vault.");
    const present = await exists(absolute);
    let before = "";
    let beforeHash = null;
    let mode = 0o600;
    if (present) {
      const resolved = await this.resolveExisting(relative);
      before = await readFile(resolved.absolute, "utf8");
      beforeHash = sha256(before);
      mode = resolved.info.mode & 0o777;
      if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
        throw new Error("expectedSha256 is required when updating an existing note.");
      }
      if (expectedSha256.toLowerCase() !== beforeHash) {
        throw new Error("note changed after it was read; read it again before writing.");
      }
    } else if (!create) {
      throw new Error("note does not exist; pass create: true to create it.");
    }

    const afterHash = sha256(normalizedContent);
    const action = present ? (beforeHash === afterHash ? "unchanged" : "update") : "create";
    const summary = {
      path: relative,
      action,
      dryRun: Boolean(dryRun),
      beforeSha256: beforeHash,
      afterSha256: afterHash,
      ...lineChangeSummary(before, normalizedContent),
      backupPath: null,
    };
    if (action === "unchanged" || dryRun) return summary;

    const parent = path.dirname(absolute);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    if (!isInside(root, realParent)) throw new Error("target parent resolves outside the knowledge vault.");

    if (present) {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      const backupRelative = path.posix.join(".personal-knowledge", "backups", stamp, relative);
      const backupAbsolute = path.resolve(root, ...backupRelative.split("/"));
      await mkdir(path.dirname(backupAbsolute), { recursive: true });
      await copyFile(absolute, backupAbsolute);
      summary.backupPath = backupRelative;
      await pruneBackups(root, this.config, this.now);
    }

    const temporary = path.join(parent, `.${path.basename(absolute)}.personal-knowledge-${process.pid}-${Date.now()}.tmp`);
    try {
      await writeFile(temporary, normalizedContent, { encoding: "utf8", mode });
      await rename(temporary, absolute);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {}
      throw error;
    }
    const persisted = await readFile(absolute, "utf8");
    summary.afterSha256 = sha256(persisted);
    return summary;
  }
}

export async function loadConfig(pluginRoot) {
  // Resolution order: explicit PERSONAL_KNOWLEDGE_CONFIG, then the per-user
  // convention file, then the bundled template. The bundled repo-map is a
  // template so an install can be shared without leaking paths or notes.
  const override = process.env.PERSONAL_KNOWLEDGE_CONFIG;
  const candidates = override
    ? [path.resolve(override)]
    : [
        path.join(os.homedir(), ".personal-knowledge", "repo-map.json"),
        path.join(pluginRoot, "config", "repo-map.json"),
      ];
  for (const configPath of candidates) {
    let raw;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      continue;
    }
    return JSON.parse(raw);
  }
  if (override) {
    throw new Error(`PERSONAL_KNOWLEDGE_CONFIG file not found: ${path.resolve(override)}`);
  }
  return {};
}

async function pruneBackups(root, config, now) {
  const retentionDays = Number.isInteger(config?.backupRetentionDays) && config.backupRetentionDays >= 0
    ? config.backupRetentionDays
    : 30;
  if (retentionDays === 0) return;
  const backupsRoot = path.resolve(root, ".personal-knowledge", "backups");
  let entries;
  try {
    entries = await readdir(backupsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const cutoff = now().getTime() - retentionDays * 86_400_000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stamp = /^(\d{4})-(\d{2})-(\d{2})T/.exec(entry.name);
    if (!stamp) continue;
    const created = Date.parse(`${stamp[0].slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(created) || created >= cutoff) continue;
    const target = path.join(backupsRoot, entry.name);
    await rm(target, { recursive: true, force: true });
  }
}

export async function createKnowledgeService({
  pluginRoot,
  vaultPath,
  config,
  now,
} = {}) {
  const resolvedConfig = config ?? (pluginRoot ? await loadConfig(pluginRoot) : {});
  // Vault resolution: explicit argument, then PERSONAL_KNOWLEDGE_VAULT, then
  // the config file's own "vaultPath" key, then the default location.
  const resolvedVault =
    vaultPath ??
    process.env.PERSONAL_KNOWLEDGE_VAULT ??
    resolvedConfig.vaultPath ??
    path.join(os.homedir(), "Documents", "Knowledge");
  return new KnowledgeService({ vaultPath: resolvedVault, config: resolvedConfig, now }).initialize();
}
