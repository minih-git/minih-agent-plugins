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

import { composeNote, parseFrontmatter, patchFrontmatterSource } from "../lib/frontmatter.mjs";
import { findSensitiveContent, redactSensitiveContent, redactionViolation } from "../lib/redact.mjs";
import { appendToSectionSpan, locateSection, replaceSectionSpan } from "../lib/sections.mjs";
import { VaultIndex } from "../lib/vault-index.mjs";

const SEARCH_EXTENSIONS = new Set([".md", ".base"]);
const WRITE_EXTENSION = ".md";
const DEFAULT_MAX_READ_CHARS = 24_000;
const DEFAULT_MAX_CONTEXT_CHARS = 32_000;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

// Kept as re-exports so existing imports of this facade keep working.
export { findSensitiveContent, parseFrontmatter, redactSensitiveContent };

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

function normalizeRelative(value, { extensions = new Set([".md", ".base"]) } = {}) {
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
  return createHash("sha256").update(content, "utf8").digest("hex");
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

function unique(values) {
  return [...new Set(values)];
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
    this.index = null;
  }

  async initialize() {
    const info = await stat(this.vaultPath);
    if (!info.isDirectory()) throw new Error(`Knowledge vault is not a directory: ${this.vaultPath}`);
    this.rootRealpath = await realpath(this.vaultPath);
    this.index = new VaultIndex({ root: this.rootRealpath, config: this.config, now: this.now });
    await this.index.refresh({ force: true });
    return this;
  }

  async root() {
    if (!this.rootRealpath) await this.initialize();
    return this.rootRealpath;
  }

  async listFiles() {
    await this.index.refresh();
    return this.index.paths();
  }

  /** Resolve a note reference (path, basename, or unique name) via the index. */
  async findNote(note) {
    await this.index.refresh();
    const raw = requireString(note, "note").replaceAll("\\", "/");
    const directCandidates = SEARCH_EXTENSIONS.has(path.posix.extname(raw).toLowerCase())
      ? [raw]
      : [`${raw}.md`, `${raw}.base`];
    for (const candidate of directCandidates) {
      if (this.index.note(candidate)) return this.resolveExisting(candidate);
    }
    const matches = this.index.basenames.get(raw) ?? this.index.basenames.get(`${raw}.md`) ?? [];
    if (matches.length === 0) throw new Error(`Knowledge note not found: ${raw}`);
    if (matches.length > 1) throw new Error(`Knowledge note is ambiguous: ${matches.join(", ")}`);
    return this.resolveExisting(matches[0]);
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

  async read({ note, maxChars, section, outline } = {}) {
    const limit = boundedInteger(maxChars, DEFAULT_MAX_READ_CHARS, 1_000, 100_000, "maxChars");
    const resolved = await this.findNote(note);
    const record = this.index.note(resolved.relative);
    const raw = record?.raw ?? (await readFile(resolved.absolute, "utf8"));
    const metadata = record?.metadata ?? parseFrontmatter(raw).data;
    const safe = redactSensitiveContent(raw);

    const result = {
      path: resolved.relative,
      title: record?.title ?? resolved.relative,
      metadata,
      sha256: record?.sha256 ?? sha256(raw),
      truncated: safe.length > limit,
      content: safe.slice(0, limit),
      redacted: safe !== raw,
    };

    if (outline === true) {
      result.outline = (record?.outline ?? []).map((entry) => ({
        level: entry.level,
        text: entry.text,
        line: entry.line,
      }));
    }

    if (section !== undefined && section !== null) {
      const lookup = locateSection(raw, section);
      if (!lookup.ok) {
        const error = new Error(
          `${lookup.code}: ${JSON.stringify(section)}` +
            (lookup.candidates?.length
              ? ` Candidates: ${lookup.candidates.map((c) => c.text).join("; ")}.`
              : ""),
        );
        error.code = lookup.code;
        error.candidates = lookup.candidates;
        throw error;
      }
      const lines = raw.split(/(?<=\n)/);
      const sectionText = lines.slice(lookup.startLine, lookup.endLine).join("");
      result.section = {
        spec: String(section),
        heading: lookup.startLine,
        startLine: lookup.startLine,
        endLine: lookup.endLine,
      };
      result.sectionSha256 = sha256(sectionText);
      result.content = redactSensitiveContent(sectionText).slice(0, limit);
      result.truncated = result.content.length < sectionText.length && sectionText.length > limit;
    }
    return result;
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

    await this.index.refresh();
    const results = [];
    for (const relative of this.index.paths()) {
      if (normalizedScope && relative !== normalizedScope && !relative.startsWith(`${normalizedScope}/`)) continue;
      const record = this.index.note(relative);
      if (!record) continue;
      const raw = record.raw;
      const metadata = record.metadata;
      const title = record.title;
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

  /**
   * Context routing (ADR 0001 §7): mapping-file projects first, then notes of
   * the project class whose `repo` is a path prefix of the working directory
   * (worktrees under `<repo>/.worktree/` match their repository), then alias
   * matches against the topic.
   */
  async context({ cwd, topic = "", maxChars } = {}) {
    const totalLimit = boundedInteger(maxChars, DEFAULT_MAX_CONTEXT_CHARS, 4_000, 100_000, "maxChars");
    // Worktree-aware matching compares the cwd's real path so macOS `/var`
    // style symlinks and per-worktree checkouts resolve to their repository.
    // A cwd that does not exist (dry callers, tests) keeps its literal path.
    let workingPath = "";
    if (typeof cwd === "string" && cwd.trim()) {
      const literal = path.resolve(cwd.trim());
      try {
        workingPath = await realpath(literal);
      } catch (error) {
        if (error?.code === "ENOENT") workingPath = literal;
        else throw error;
      }
    }
    const loweredTopic = String(topic ?? "").toLowerCase();

    await this.index.refresh();

    // 1. Mapping-file entries (unchanged behavior).
    const mappingProjects = (this.config.projects ?? []).filter((project) => {
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

    // 2. Project-class notes whose `repo` covers the working directory.
    const routedNotes = new Set([
      ...mappingProjects.flatMap((project) => project.notes ?? []),
      ...routes.flatMap((route) => route.notes ?? []),
    ]);
    const metadataProjects = [];
    for (const relative of this.index.paths()) {
      const record = this.index.note(relative);
      if (!record || (record.metadata.type ?? "") !== "project") continue;
      const repoPath = typeof record.metadata.repo === "string" ? record.metadata.repo.trim() : "";
      if (!repoPath || !workingPath) continue;
      const resolvedRepo = path.resolve(repoPath);
      const matches =
        workingPath === resolvedRepo || workingPath.startsWith(`${resolvedRepo}${path.sep}`);
      const aliasMatch =
        loweredTopic &&
        (record.aliases ?? []).some((alias) => loweredTopic.includes(String(alias).toLowerCase()));
      const topicFallback = loweredTopic && loweredTopic.includes(record.title.toLowerCase());
      if (matches || aliasMatch || topicFallback) {
        metadataProjects.push(record);
        routedNotes.add(relative);
      }
    }

    const requestedNotes = unique([
      ...mappingProjects.flatMap((project) => project.notes ?? []),
      ...routes.flatMap((route) => route.notes ?? []),
      ...[...routedNotes].filter((note) => this.index.note(note)),
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
      matchedProjects: unique([
        ...mappingProjects.map((project) => project.name),
        ...metadataProjects.map((record) => record.title),
      ]),
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
    await this.index.refresh();
    const due = [];
    for (const relative of this.index.paths()) {
      if (!relative.endsWith(".md")) continue;
      const record = this.index.note(relative);
      if (!record) continue;
      const metadata = record.metadata;
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
        title: record.title,
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
    await this.index.refresh();
    const record = this.index.note(resolved.relative);
    return {
      path: resolved.relative,
      outgoing: record.linkTargets,
      backlinks: this.index.backlinksOf(resolved.relative),
      ghosts: this.index.ghostsOf(resolved.relative),
    };
  }

  async write({
    path: notePath,
    content,
    expectedSha256,
    dryRun = true,
    create = false,
    operation = "replace",
    section,
    frontmatter,
  } = {}) {
    const relative = normalizeRelative(notePath, { extensions: new Set([WRITE_EXTENSION]) });
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

    const normalizedContent = await this.#composeContent({
      relative,
      operation,
      section,
      frontmatter,
      content,
      before,
      present,
    });

    if (Buffer.byteLength(normalizedContent, "utf8") > MAX_NOTE_BYTES) {
      throw new Error("content is larger than the supported 2 MB limit.");
    }
    const metadata = parseFrontmatter(normalizedContent);
    if (!metadata.data.title || !metadata.data.type) {
      throw new Error("content must include frontmatter with non-empty title and type properties.");
    }
    const sensitive = findSensitiveContent(normalizedContent);
    if (sensitive.length) {
      throw new Error(`content appears to contain sensitive credentials: ${sensitive.map((item) => item.kind).join(", ")}`);
    }
    if (present && redactionViolation(before, normalizedContent)) {
      throw new Error("REDACTED_PLACEHOLDER: the result introduces [REDACTED markers the stored note does not contain.");
    }

    const afterHash = sha256(normalizedContent);
    const action = present ? (beforeHash === afterHash ? "unchanged" : "update") : "create";
    const summary = {
      path: relative,
      operation,
      action,
      dryRun: Boolean(dryRun),
      beforeSha256: beforeHash,
      afterSha256: afterHash,
      ...lineChangeSummary(before, normalizedContent),
      warnings: [],
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
    await this.index.invalidate(relative);
    return summary;
  }

  /** Build the resulting note text for any write operation (ADR 0001 §7-§8). */
  async #composeContent({ relative, operation, section, frontmatter, content, before, present }) {
    if (operation === "replace") {
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("content must be a non-empty string.");
      }
      return `${content.replace(/\s+$/, "")}\n`;
    }
    if (!present) {
      throw new Error(`${operation} requires an existing note.`);
    }

    if (operation === "patchFrontmatter") {
      if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
        throw new Error("frontmatter must be an object mapping keys to new values (null removes a key).");
      }
      const parsed = parseFrontmatter(before);
      const nextSource = patchFrontmatterSource(parsed, frontmatter);
      if (nextSource === null) return before;
      return composeNote(nextSource, parsed.body);
    }

    if (operation === "replaceSection" || operation === "appendToSection") {
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("content must be a non-empty string.");
      }
      if (typeof section !== "string" || !section.trim()) {
        throw new Error(`section is required for ${operation}.`);
      }
      const lookup = locateSection(before, section);
      if (!lookup.ok) {
        const detail = lookup.candidates?.length
          ? ` Candidates: ${lookup.candidates.map((entry) => entry.text).join("; ")}.`
          : "";
        const error = new Error(`${lookup.code}: no unique heading for ${JSON.stringify(section)}.${detail}`);
        error.code = lookup.code;
        error.candidates = lookup.candidates;
        throw error;
      }
      if (operation === "replaceSection") {
        return replaceSectionSpan(before, lookup.startLine, lookup.endLine, content);
      }
      return appendToSectionSpan(before, lookup.startLine, lookup.endLine, content);
    }

    throw new Error('operation must be one of: replace, replaceSection, appendToSection, patchFrontmatter.');
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
