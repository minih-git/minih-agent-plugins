"use strict";

/**
 * Page library helpers for the Answer me with HTML plugin.
 *
 * The pages are written by the bundled `am` CLI, which the Agent runs over
 * Bash. This module reads the directories that CLI writes to, so the plugin and
 * the CLI agree on where pages live instead of the plugin inventing a second
 * answer:
 *
 *   home  <AM_HOME or ~/.answer-me-with-html>/pages/<topic>-<yyyymmdd-hhmmss>.html
 *   temp  <tmpdir>/answer-me-with-html-<uid>/pages/<...>.html
 *
 * The temp folder is the CLI's fallback when the data directory is not
 * writable (`am.mjs` `savePage`): it writes the page there and says so on a `!`
 * line. `am clean` and `am serve` both cover the two folders, so a panel that
 * listed only `home` would show fewer pages than the CLI itself reports.
 *
 * A page the Agent wrote somewhere else on purpose — `am render -o <file>`, for
 * the workspace — is not part of either folder and is therefore not listed here:
 * it belongs to that other place, and the reply links it directly.
 *
 * Everything in this file is free of Electron and `pi.*` calls, so the rules can
 * be unit-tested with `node --test` outside the app.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PAGES_DIR = "pages";
const PAGE_EXT = ".html";
/** The panel shows the newest pages; an unbounded list is not worth the IPC. */
const MAX_PAGES = 200;
/** Enough bytes to cover `<head>`; a page keeps its <title> at the top. */
const TITLE_SNIFF_BYTES = 8192;

/**
 * The CLI resolves its data directory as `AM_HOME || ~/.answer-me-with-html`
 * (am.mjs `amHome`). Mirror exactly that, so the panel never shows a directory
 * the CLI does not write to.
 */
function amHome(env = process.env, homedir = os.homedir()) {
  const override = String(env?.AM_HOME ?? "").trim();
  return override ? path.resolve(override) : path.join(homedir, ".answer-me-with-html");
}

/**
 * The CLI's fallback directory (am.mjs `tempHome`), including its uid suffix:
 * two users sharing a machine must not read each other's pages.
 */
function tempHome(tmpdir = os.tmpdir(), uid = typeof process.getuid === "function" ? process.getuid() : null) {
  return path.join(tmpdir, uid === null ? "answer-me-with-html" : `answer-me-with-html-${uid}`);
}

function pagesDir(dir) {
  return path.join(dir, PAGES_DIR);
}

/**
 * The CLI only writes to the fallback folder when it is a private folder of this
 * user (`checkedTempHome`): a directory owned by someone else, or one group or
 * other users can enter, is refused there. Apply the same test before this
 * plugin reads or deletes anything inside it.
 */
function privateTempHome(dir, uid = typeof process.getuid === "function" ? process.getuid() : null) {
  let info;
  try {
    info = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (uid === null) return true;
  return info.uid === uid && (info.mode & 0o077) === 0;
}

/**
 * The directories a page can live in, in the order the panel shows them. `home`
 * is always present; `temp` only counts while the CLI's fallback folder exists
 * and is private, which is exactly when the CLI could have written there.
 */
function dataRoots(home, { tmpdir = os.tmpdir(), uid } = {}) {
  const roots = [{ id: "home", label: "pages", dir: home, pagesDir: pagesDir(home) }];
  const spare = tempHome(tmpdir, uid);
  if (privateTempHome(spare, uid)) {
    roots.push({ id: "temp", label: "temporary folder", dir: spare, pagesDir: pagesDir(spare) });
  }
  return roots;
}

function rootById(home, id, options) {
  const wanted = String(id ?? "home").trim() || "home";
  return dataRoots(home, options).find((root) => root.id === wanted) ?? null;
}

/**
 * A page name is one file name directly inside a `pages/` folder. Reject
 * separators, `..`, absolute paths and any other extension: the name arrives
 * from the panel, and the delete channel is the one place a bad name matters.
 */
function isPageName(name) {
  const value = String(name ?? "");
  if (!value || value === "." || value === "..") return false;
  if (value !== path.basename(value)) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.toLowerCase().endsWith(PAGE_EXT);
}

/** Absolute path of one page inside one root, or null when it is not valid. */
function pagePath(dir, name) {
  if (!isPageName(name)) return null;
  const full = path.join(pagesDir(dir), name);
  if (path.dirname(full) !== pagesDir(dir)) return null;
  return full;
}

/** The `<title>` of a rendered page, falling back to the file name. */
function titleOf(html, fallback) {
  const match = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return fallback;
  const text = match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function readTitle(full, fallback) {
  let handle;
  try {
    handle = fs.openSync(full, "r");
    const buffer = Buffer.alloc(TITLE_SNIFF_BYTES);
    const read = fs.readSync(handle, buffer, 0, TITLE_SNIFF_BYTES, 0);
    return titleOf(buffer.subarray(0, read).toString("utf8"), fallback);
  } catch {
    return fallback;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        /* the handle is already gone */
      }
    }
  }
}

/** Byte size of every file below one directory, and how many there are. */
function dirUsage(dir) {
  const out = { count: 0, bytes: 0 };
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        out.count += 1;
        out.bytes += stat.size;
      } catch {
        /* a file that vanished mid-walk is simply not counted */
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * What `am clean` reports: pages and videos from every root, plus the voice-over
 * cache, which only lives in the data directory.
 */
function usage(home, options) {
  const roots = dataRoots(home, options);
  const sum = (pick) =>
    roots.reduce(
      (total, root) => {
        const part = pick(root);
        return { count: total.count + part.count, bytes: total.bytes + part.bytes };
      },
      { count: 0, bytes: 0 },
    );
  const parts = {
    pages: sum((root) => dirUsage(pagesDir(root.dir))),
    videos: sum((root) => dirUsage(path.join(root.dir, "videos"))),
    cache: dirUsage(path.join(home, "cache")),
  };
  const total = parts.pages.bytes + parts.videos.bytes + parts.cache.bytes;
  return { ...parts, total };
}

/** Pages of one root, newest first. A missing folder is empty, not an error. */
function listRoot(root) {
  let entries;
  try {
    entries = fs.readdirSync(root.pagesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { root, pages: [] };
    throw error;
  }
  const pages = [];
  for (const entry of entries) {
    if (!isPageName(entry.name)) continue;
    const full = path.join(root.pagesDir, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    pages.push({
      root: root.id,
      name: entry.name,
      title: readTitle(full, entry.name),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return { root, pages };
}

/**
 * The newest pages of every root, ready for the panel. Only regular files
 * directly inside a `pages/` folder are listed; a symlink is never one.
 */
function listPages(home, { limit = MAX_PAGES, ...options } = {}) {
  const roots = dataRoots(home, options);
  const collected = roots.map(listRoot);
  const pages = collected.flatMap((entry) => entry.pages);
  pages.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.name.localeCompare(right.name));
  const total = pages.length;
  const bytes = pages.reduce((sum, page) => sum + page.bytes, 0);
  return {
    roots: collected.map(({ root, pages: own }) => ({
      id: root.id,
      label: root.label,
      pagesDir: root.pagesDir,
      count: own.length,
      bytes: own.reduce((sum, page) => sum + page.bytes, 0),
    })),
    pages: pages.slice(0, limit),
    total,
    bytes,
    truncated: total > limit,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

module.exports = {
  MAX_PAGES,
  amHome,
  dataRoots,
  dirUsage,
  formatBytes,
  isPageName,
  listPages,
  pagePath,
  pagesDir,
  privateTempHome,
  readTitle,
  rootById,
  tempHome,
  titleOf,
  usage,
};
