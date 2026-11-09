import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Vault layout for archived conversations (ADR 0002 §2).
 *
 * Everything here is a pure function of the change row: no I/O, no clock
 * beyond the caller's own timezone. The same session on two computers
 * therefore resolves to the same paths, which is what makes the repo-map →
 * git remote → directory-name order safe to apply on every machine.
 *
 *   L2  `09 Conversations/<project>/<YYYY-MM>/<YYYY-MM-DD> <title> <id8>.md`
 *   L3  `09 Conversations/_raw/<project>/<YYYY-MM>/<id8>[.pN].md`
 *   day `09 Conversations/_daily/<YYYY-MM-DD> <device>.md`
 *
 * The shared `VaultIndex` skips a top-level folder only when it is indented
 * literally under the vault root, so the two folders that must stay
 * private — `_raw` and `_daily` — are separate top-level folders next to the
 * projects, exactly as the plan puts them. Both names are added to
 * `ignoreFolders` and to Obsidian's `userIgnoreFilters` (ADR 0002 §4); the
 * in-memory index filters them by the leading underscore as well, so a user
 * who edits the config cannot accidentally index a transcript.
 */

export const CONVERSATIONS_FOLDER = "09 Conversations";
export const RAW_FOLDER = "_raw";
export const DAILY_FOLDER = "_daily";
export const NO_PROJECT = "_无项目";

/** Hard ceiling for one L3 part: the plan's 512 KiB, counted in UTF-8 bytes. */
export const RAW_PART_BYTES = 512 * 1024;

const MAX_PROJECT_SLUG = 40;
const MAX_TITLE_CHARS = 60;

const FALLBACK_TITLES = {
  en: "Untitled conversation",
  zh: "未命名会话",
};

/** Session-id prefix used in file names and as the retrieval key. */
export function shortId(sessionId) {
  const value = String(sessionId ?? "").trim();
  const clean = value.replace(/[^A-Za-z0-9_-]/g, "");
  return clean.slice(0, 8) || "unknown";
}

/** Strip characters Obsidian, Windows, and iCloud share problems with. */
export function cleanSegment(value, maxLength = 60) {
  const collapsed = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|#^[\]{}]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!collapsed) return "";
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength).trim();
}

/** `owner-repo` from a normalized `host/owner/repo` git remote. */
export function remoteSlugFor(gitRemote) {
  const value = String(gitRemote ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!value) return "";
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return cleanSegment(parts.slice(-2).join("-"), MAX_PROJECT_SLUG);
}

/**
 * Project folder for one change, in the plan's order: a repo-map project whose
 * `repoPrefixes` covers the session's project path, then the git remote's
 * `owner-repo`, then the directory name, then `_无项目`.
 */
export function projectFolderFor(project, config = {}) {
  if (!project) return NO_PROJECT;
  const projectPath = typeof project.path === "string" ? project.path : "";
  const lowered = projectPath.toLowerCase();
  for (const entry of config.projects ?? []) {
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) continue;
    const matched = (entry.repoPrefixes ?? []).some((prefix) => {
      const normalized = String(prefix ?? "").trim().replace(/\/+$/, "").toLowerCase();
      if (!normalized) return false;
      return lowered === normalized || lowered.startsWith(`${normalized}/`);
    });
    if (matched) return cleanSegment(entry.name, MAX_PROJECT_SLUG) || NO_PROJECT;
  }
  const remote = remoteSlugFor(project.gitRemote);
  if (remote) return remote;
  if (projectPath) {
    const base = path.basename(projectPath.replace(/\/+$/, ""));
    if (base) return cleanSegment(base, MAX_PROJECT_SLUG) || NO_PROJECT;
  }
  const named = typeof project.name === "string" ? project.name.trim() : "";
  if (named) return cleanSegment(named, MAX_PROJECT_SLUG) || NO_PROJECT;
  return NO_PROJECT;
}

/** Local calendar date of an epoch-ms value, as `YYYY-MM-DD`. */
export function localDate(epochMs, timezoneOffsetMinutes = null) {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "1970-01-01";
  if (Number.isInteger(timezoneOffsetMinutes)) {
    return new Date(date.getTime() - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function monthOfDate(day) {
  return String(day ?? "").slice(0, 7) || "1970-01";
}

function titleSegment(title, locale) {
  return cleanSegment(title, MAX_TITLE_CHARS) || (locale === "zh" ? FALLBACK_TITLES.zh : FALLBACK_TITLES.en);
}

export function summaryPathFor(change, { config = {}, timezoneOffsetMinutes = null, locale = "en" } = {}) {
  const day = localDate(change.createdAt, timezoneOffsetMinutes);
  return path.posix.join(
    CONVERSATIONS_FOLDER,
    projectFolderFor(change.project, config),
    monthOfDate(day),
    `${day} ${titleSegment(change.title, locale)} ${shortId(change.sessionId)}.md`,
  );
}

/** First L3 part; later parts get `.p2`, `.p3`, … before `.md`. */
export function rawPathFor(change, { config = {}, part = 1 } = {}) {
  const day = localDate(change.createdAt);
  const suffix = part > 1 ? `.p${part}` : "";
  return path.posix.join(
    CONVERSATIONS_FOLDER,
    RAW_FOLDER,
    projectFolderFor(change.project, config),
    monthOfDate(day),
    `${shortId(change.sessionId)}${suffix}.md`,
  );
}

/** Daily roll-up page for one computer and one local date. */
export function dailyPathFor(day, device) {
  return path.posix.join(CONVERSATIONS_FOLDER, DAILY_FOLDER, `${day} ${cleanSegment(device, 40) || "unknown"}.md`);
}

/** Folder name the index skips: everything the archive keeps private starts with `_`. */
export function isPrivateConversationFolder(name) {
  return String(name ?? "").startsWith("_");
}

/** Whether the note lives in `_raw` or `_daily` rather than a project folder. */
export function isPrivateConversationPath(relative) {
  const parts = String(relative ?? "").split("/");
  return relative === CONVERSATIONS_FOLDER ? false : parts.length >= 2 && parts[0] === CONVERSATIONS_FOLDER && isPrivateConversationFolder(parts[1]);
}

export function isConversationPath(relative) {
  return String(relative ?? "").startsWith(`${CONVERSATIONS_FOLDER}/`);
}

/** L3: never indexed, never searched, excluded from Obsidian. */
export function isRawPath(relative) {
  return isPrivateConversationPath(relative);
}

/** L2: a summary or a daily roll-up, both indexed. */
export function isSearchableConversationPath(relative) {
  return isConversationPath(relative) && !isRawPath(relative);
}

/**
 * iCloud conflict copies are named `name 2.md`, `name 3.md`, … Because session
 * prefixes are also numeric, only a trailing ` 2`…` 9` after a file extension
 * counts: `2026-11-08 Title 11111111.md` is a canonical file, not a copy of
 * `2026-11-08 Title.md`. Obsidian's own `name (1).md` form is deliberately not
 * recognized — Obsidian still links to it, so moving it would break links.
 */
export function conflictCopyOf(relative) {
  const value = String(relative ?? "");
  const copy = /^(.+?)\s[2-9](\.md|\.base)$/.exec(value);
  return copy ? `${copy[1]}${copy[2]}` : null;
}

/** Deterministic per-path identity, used for rename bookkeeping. */
export function pathDigest(relative) {
  return createHash("sha1").update(String(relative ?? ""), "utf8").digest("hex").slice(0, 16);
}

/**
 * Split L3 content so each part stays under the byte ceiling, preferring turn
 * boundaries. A single chunk larger than the ceiling is hard-split.
 */
export function splitParts(chunks, { maxBytes = RAW_PART_BYTES } = {}) {
  const parts = [];
  let current = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const size = Buffer.byteLength(chunk, "utf8");
    if (size > maxBytes) {
      if (current.length > 0) {
        parts.push(current.join(""));
        current = [];
        bytes = 0;
      }
      parts.push(...hardSplit(chunk, maxBytes));
      continue;
    }
    if (bytes + size > maxBytes && current.length > 0) {
      parts.push(current.join(""));
      current = [];
      bytes = 0;
    }
    current.push(chunk);
    bytes += size;
  }
  if (current.length > 0) parts.push(current.join(""));
  return parts.length > 0 ? parts : [""];
}

function hardSplit(text, maxBytes) {
  const pieces = [];
  let buffer = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes && buffer) {
      pieces.push(buffer);
      buffer = "";
      bytes = 0;
    }
    buffer += char;
    bytes += size;
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}
