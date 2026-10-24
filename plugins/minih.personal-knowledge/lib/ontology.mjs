import path from "node:path";

import { readFile } from "node:fs/promises";

import { parseFrontmatter } from "./frontmatter.mjs";
import { parse as parseYaml } from "./vendor/yaml.mjs";

/**
 * The lightweight ontology (ADR 0001 §3).
 *
 * Vocabulary is plain data: `config/ontology.default.yaml` ships the default,
 * and a vault note (mapping key `ontologyNote`, default
 * `08 Standards/知识本体.md`) may override it with a YAML code block. Reads are
 * tolerant — legacy types resolve through the alias table — while writes are
 * validated (`warn` first, `enforce` after the migration).
 */

export const ISSUE_CODES = [
  "UNKNOWN_TYPE",
  "LEGACY_TYPE",
  "UNKNOWN_STATUS",
  "UNKNOWN_STABILITY",
  "UNKNOWN_PREDICATE_TARGET",
  "DOMAIN_VIOLATION",
  "RANGE_VIOLATION",
  "CARDINALITY_VIOLATION",
  "FRONTMATTER_INVALID",
  "OVERSIZE",
  "ORPHAN",
  "STALE",
];

function mergeOntology(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) merged[key] = value;
    else if (typeof value === "object") merged[key] = { ...(base[key] ?? {}), ...value };
    else merged[key] = value;
  }
  return merged;
}

/** The first ```yaml code block of a note body, or `null`. */
export function extractYamlBlock(body) {
  const match = /```yaml[^\n]*\n([\s\S]*?)```/.exec(body ?? "");
  if (!match) return null;
  return match[1];
}

export class Ontology {
  constructor(data, { source = "default" } = {}) {
    this.data = data;
    this.source = source;
    this.classes = data.classes ?? {};
    this.typeAliases = data.typeAliases ?? {};
    this.predicates = data.predicates ?? {};
    this.attributes = new Set(data.attributes ?? ["repo", "source"]);
    this.stabilities = new Set(data.stabilities ?? ["stable", "mixed", "volatile", "historical"]);
    this.enforcement = data.enforcement === "enforce" ? "enforce" : "warn";
    this.oversizeChars = Number.isInteger(data.oversizeChars) ? data.oversizeChars : 24_000;
    this.ontologyNote = typeof data.ontologyNote === "string" ? data.ontologyNote : "08 Standards/知识本体.md";
    // Knowledge Universe v2 (design doc §3): name-based nav detection and the
    // project-title prefix used by the folder rule. Invalid patterns are
    // skipped so a vault override cannot break the view.
    this.navigationNamePatterns = toArray(data.navigationNamePatterns, ["(总览|索引)$", "^Home$"])
      .map((pattern) => toRegExp(pattern))
      .filter(Boolean);
    this.projectTitlePrefixes = toArray(data.projectTitlePrefixes, ["项目 - "]).map(String);
  }

  /** Resolve a `type` value to its class name, or `null` when unknown. */
  resolveClass(type) {
    if (typeof type !== "string" || !type.trim()) return null;
    if (this.classes[type]) return type;
    return this.typeAliases[type] ?? null;
  }

  isAlias(type) {
    return typeof type === "string" && !this.classes[type] && Boolean(this.typeAliases[type]);
  }

  classOf(note) {
    return this.resolveClass(note.metadata?.type);
  }

  statusVocabulary(cls) {
    return this.classes[cls]?.status ?? null;
  }

  defaultStatus(cls) {
    const status = this.statusVocabulary(cls);
    return status?.[0] ?? null;
  }

  defaultStability(cls) {
    return this.classes[cls]?.defaultStability ?? null;
  }

  family(cls) {
    return this.classes[cls]?.family ?? null;
  }

  ignoreList(metadata) {
    const raw = metadata?.lint_ignore;
    if (Array.isArray(raw)) return new Set(raw.map(String));
    if (typeof raw === "string" && raw.trim()) return new Set(raw.split(/[,\s]+/).filter(Boolean));
    return new Set();
  }

  /**
   * Validate one indexed note. `context` carries what the note alone cannot
   * know: `{ resolveTarget, backlinkCount, now }`. Returns issue objects
   * `{ code, detail }` — never throws for content problems.
   */
  validate(note, context = {}) {
    const issues = [];
    const metadata = note.metadata ?? {};
    if (note.frontmatter?.invalid) {
      issues.push({ code: "FRONTMATTER_INVALID", detail: note.frontmatter.error ?? "frontmatter failed to parse" });
    }
    const ignored = this.ignoreList(metadata);

    const rawType = metadata.type;
    const cls = this.classOf(note);
    if (rawType === undefined || rawType === null || String(rawType).trim() === "") {
      issues.push({ code: "UNKNOWN_TYPE", detail: "type is missing" });
    } else if (!cls) {
      issues.push({ code: "UNKNOWN_TYPE", detail: `type "${rawType}" is not a class or alias` });
    } else if (this.isAlias(rawType)) {
      issues.push({ code: "LEGACY_TYPE", detail: `type "${rawType}" maps to "${cls}"` });
    }

    if (cls) {
      const vocabulary = this.statusVocabulary(cls);
      if (vocabulary && metadata.status !== undefined && metadata.status !== "") {
        if (!vocabulary.includes(String(metadata.status))) {
          issues.push({ code: "UNKNOWN_STATUS", detail: `status "${metadata.status}" is not in [${vocabulary.join(", ")}]` });
        }
      }
    }

    if (metadata.stability !== undefined && metadata.stability !== "" && !this.stabilities.has(String(metadata.stability))) {
      issues.push({ code: "UNKNOWN_STABILITY", detail: `stability "${metadata.stability}" is not in [${[...this.stabilities].join(", ")}]` });
    }

    // Predicates: wikilink values checked for target, domain, range, cardinality.
    const noteClass = cls ?? "unknown";
    for (const [predicate, rule] of Object.entries(this.predicates)) {
      const value = metadata[predicate];
      if (value === undefined || value === null || value === "") continue;
      const targets = Array.isArray(value) ? value : [value];
      const links = targets.map((item) => wikilinkTarget(item)).filter(Boolean);
      if (links.length === 0) continue; // plain strings are attributes, not links
      if (rule.cardinality === "one" && links.length > 1) {
        issues.push({ code: "CARDINALITY_VIOLATION", detail: `${predicate} allows one link, found ${links.length}` });
      }
      const domainAllows = rule.domain.includes("any") || rule.domain.includes(noteClass);
      if (!domainAllows) {
        issues.push({ code: "DOMAIN_VIOLATION", detail: `${predicate} does not apply to class "${noteClass}"` });
      }
      for (const link of links) {
        const resolved = context.resolveTarget?.(link) ?? null;
        if (!resolved) {
          issues.push({ code: "UNKNOWN_PREDICATE_TARGET", detail: `${predicate}: [[${link}]] does not resolve` });
          continue;
        }
        const targetClass = context.classOf?.(resolved) ?? null;
        const rangeAllows = rule.range.includes("any") || (targetClass !== null && rule.range.includes(targetClass));
        if (!rangeAllows) {
          issues.push({ code: "RANGE_VIOLATION", detail: `${predicate}: [[${link}]] is class "${targetClass ?? "unknown"}", expected [${rule.range.join(", ")}]` });
        }
      }
    }

    if (note.chars > this.oversizeChars) {
      issues.push({ code: "OVERSIZE", detail: `${note.chars} characters exceed ${this.oversizeChars}` });
    }

    if (context.backlinkCount === 0 && note.path?.endsWith(".md")) {
      const family = cls ? this.family(cls) : null;
      if (family !== "navigation") {
        issues.push({ code: "ORPHAN", detail: "no backlinks point at this note" });
      }
    }

    const stale = staleness(metadata, context.now ?? new Date());
    if (stale) issues.push({ code: "STALE", detail: stale });

    return issues.filter((issue) => !ignored.has(issue.code));
  }

  /** Issues a write introduces relative to the stored note (ADR §3 enforcement). */
  newIssues(beforeIssues, afterIssues) {
    const before = new Set(beforeIssues.map((issue) => `${issue.code}:${issue.detail}`));
    return afterIssues.filter((issue) => !before.has(`${issue.code}:${issue.detail}`));
  }
}

function wikilinkTarget(value) {
  if (typeof value !== "string") return null;
  const match = /\[\[([^\][#|]+)(?:#[^][|]*)?(?:\|[^][]*)?\]\]/.exec(value);
  if (match) return match[1].trim();
  return null;
}

function toArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string" && item.trim()).map(String);
}

function toRegExp(source) {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function staleness(metadata, now) {
  const interval = metadata.review_interval;
  if (!interval || interval === "none") return null;
  const verified = metadata.verified;
  if (typeof verified !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(verified)) return "no verified date";
  const ageDays = Math.floor((now.getTime() - Date.parse(`${verified}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(ageDays)) return "verified date is invalid";
  const threshold = interval === "monthly" ? 30 : interval === "quarterly" ? 90 : null;
  if (threshold === null) return null;
  if (ageDays > threshold) return `verified ${ageDays} days ago, review window is ${threshold}`;
  return null;
}

/** Load the ontology: bundled default, overridden by the vault's note. */
export async function loadOntology({ pluginRoot, index }) {
  const defaultPath = path.join(pluginRoot, "config", "ontology.default.yaml");
  let data = parseYaml(await readFile(defaultPath, "utf8"));
  let source = "default";
  if (index) {
    await index.refresh();
    const notePath = index.resolveTarget(data.ontologyNote ?? "08 Standards/知识本体.md");
    if (notePath && notePath.endsWith(".md")) {
      const raw = index.note(notePath)?.raw ?? "";
      const parsed = parseFrontmatter(raw);
      const block = extractYamlBlock(parsed.body);
      if (block) {
        try {
          data = mergeOntology(data, parseYaml(block));
          source = notePath;
        } catch {
          // An unparsable override keeps the default vocabulary (tolerant read).
        }
      }
    }
  }
  return new Ontology(data, { source });
}
