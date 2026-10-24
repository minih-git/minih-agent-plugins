import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.mjs";
import { bodyLinkTargets, frontmatterLinkTargets } from "./links.mjs";
import { chunkNote, headingOutline } from "./sections.mjs";

/**
 * The shared in-memory vault index (ADR 0001 §2).
 *
 * One scan feeds the MCP tools, the lint script, and the view. Every file is
 * `stat`ed and only re-read when `mtimeMs` or `size` changed; a re-scan runs at
 * most once per second per process. Derived data (frontmatter, links, outline,
 * chunks, tokens) is rebuildable and never persisted for its own sake.
 */

const SCAN_THROTTLE_MS = 1000;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unique(values) {
  return [...new Set(values)];
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

function titleFor(relativePath, metadata) {
  return typeof metadata.title === "string" && metadata.title.trim()
    ? metadata.title.trim()
    : path.posix.basename(relativePath, path.posix.extname(relativePath));
}

export class VaultIndex {
  constructor({ root, config = {}, now = () => new Date() }) {
    this.root = root;
    this.config = config;
    this.now = now;
    this.ignored = new Set(config.ignoreFolders ?? []);
    this.notes = new Map();
    this.basenames = new Map();
    this.backlinks = new Map();
    this.resolvedLinks = new Map();
    this.lastScanAt = 0;
    this.scanPromise = null;
  }

  /** Throttled scan; concurrent callers share one pass. */
  async refresh({ force = false } = {}) {
    const moment = this.now().getTime();
    if (!force && this.scanPromise === null && moment - this.lastScanAt < SCAN_THROTTLE_MS) return;
    if (this.scanPromise) return this.scanPromise;
    this.lastScanAt = moment;
    this.scanPromise = this.#scan().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  /** Drop one note from the cache and rebuild it from disk immediately. */
  async invalidate(relativePath) {
    await this.#readOne(relativePath);
    this.#derive();
  }

  paths() {
    return [...this.notes.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  note(relativePath) {
    return this.notes.get(relativePath) ?? null;
  }

  /** Obsidian-style link resolution: exact path, unique basename, shortest
   * path among duplicate basenames; `null` for ghosts. */
  resolveTarget(target) {
    const normalized = String(target ?? "").trim().replaceAll("\\", "/").replace(/\.md$/i, "");
    if (!normalized) return null;
    for (const candidate of [normalized, `${normalized}.md`, `${normalized}.base`]) {
      if (this.notes.has(candidate)) return candidate;
    }
    const base = path.posix.basename(normalized);
    const matches = this.basenames.get(base) ?? this.basenames.get(`${base}.md`) ?? [];
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return [...matches].sort(
      (a, b) => a.length - b.length || a.localeCompare(b, "zh-CN"),
    )[0];
  }

  backlinksOf(relativePath) {
    return [...(this.backlinks.get(relativePath) ?? [])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  ghostsOf(relativePath) {
    const note = this.notes.get(relativePath);
    if (!note) return [];
    return note.linkTargets.filter((target) => !this.resolvedLinks.get(`${relativePath}→${target}`));
  }

  async #scan() {
    const files = [];
    await this.#walk(this.root, files);
    const seen = new Set(files);
    for (const relative of files) {
      const absolute = path.join(this.root, ...relative.split("/"));
      const info = await stat(absolute);
      const existing = this.notes.get(relative);
      if (existing && existing.mtimeMs === info.mtimeMs && existing.size === info.size) continue;
      await this.#readOne(relative, info);
    }
    for (const relative of [...this.notes.keys()]) {
      if (!seen.has(relative)) this.notes.delete(relative);
    }
    this.#derive();
  }

  /** Monotonic counter; consumers (BM25 cache) key their own caches on it. */
  get version() {
    return this.versionCounter ?? 0;
  }

  async #readOne(relative, preloadedInfo = null) {
    const absolute = path.join(this.root, ...relative.split("/"));
    let info = preloadedInfo;
    try {
      info = info ?? (await stat(absolute));
      const raw = await readFile(absolute, "utf8");
      this.notes.set(relative, this.#build(relative, raw, info));
    } catch (error) {
      if (error?.code === "ENOENT") this.notes.delete(relative);
      else throw error;
    }
  }

  #build(relativePath, raw, info) {
    const parsed = parseFrontmatter(raw);
    const metadata = parsed.data;
    const chunks = chunkNote(raw);
    const linkTargets = unique([
      ...bodyLinkTargets(raw),
      ...frontmatterLinkTargets(metadata),
    ]);
    return {
      path: relativePath,
      raw,
      sha256: sha256(raw),
      mtimeMs: info.mtimeMs,
      size: info.size,
      metadata,
      frontmatter: parsed,
      title: titleFor(relativePath, metadata),
      aliases: listAliases(metadata),
      chars: raw.length,
      outline: headingOutline(parsed.body),
      chunks,
      chunkTexts: chunks.map((chunk) => raw.slice(chunk.start, chunk.end)),
      linkTargets,
    };
  }

  #derive() {
    this.versionCounter = (this.versionCounter ?? 0) + 1;
    this.basenames = new Map();
    for (const relative of this.notes.keys()) {
      const base = path.posix.basename(relative);
      const withoutExtension = base.replace(/\.(md|base)$/i, "");
      for (const key of new Set([base, withoutExtension])) {
        const bucket = this.basenames.get(key) ?? [];
        bucket.push(relative);
        this.basenames.set(key, bucket);
      }
    }
    this.resolvedLinks = new Map();
    this.backlinks = new Map();
    for (const [relative, note] of this.notes) {
      for (const target of note.linkTargets) {
        const resolved = this.resolveTarget(target);
        this.resolvedLinks.set(`${relative}→${target}`, resolved);
        if (resolved && resolved !== relative) {
          const bucket = this.backlinks.get(resolved) ?? [];
          if (!bucket.includes(relative)) bucket.push(relative);
          this.backlinks.set(resolved, bucket);
        }
      }
    }
  }

  async #walk(current, output) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(this.root, absolute).split(path.sep).join("/");
      const topLevel = relative.split("/")[0];
      if (this.ignored.has(topLevel)) continue;
      if (entry.isDirectory()) {
        await this.#walk(absolute, output);
        continue;
      }
      if (entry.isFile() && /\.(md|base)$/i.test(entry.name)) output.push(relative);
    }
  }
}

function listAliases(metadata) {
  const raw = metadata.aliases;
  if (typeof raw === "string") return [stripQuotes(raw)];
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  return [];
}
