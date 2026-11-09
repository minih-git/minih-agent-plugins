import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { conflictCopyOf } from "./conversation-layout.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

/**
 * File operations for the conversation archive (ADR 0002 §4).
 *
 * Only the conversation subtree is touched, always with atomic temp-file
 * renames, and never with a backup copy: a vault backup of `09 Conversations`
 * would double a folder that every computer syncs. Writes are skipped when the
 * bytes are unchanged, so an idempotent sync pass does not wake iCloud.
 */

const TEMP_SUFFIX = ".personal-knowledge-tmp";
const CONVERSATIONS_FOLDER = "09 Conversations";

export function isConversationPath(relative) {
  return String(relative ?? "").startsWith(`${CONVERSATIONS_FOLDER}/`);
}

function absoluteIn(root, relative) {
  const normalized = String(relative ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`unsafe conversation path: ${relative}`);
  }
  return path.join(root, ...normalized.split("/"));
}

/** Read one conversation file, or `null` when it does not exist. */
export async function readConversationFile(root, relative) {
  const absolute = absoluteIn(root, relative);
  try {
    const raw = await readFile(absolute, "utf8");
    const info = await stat(absolute);
    return { path: relative, raw, metadata: parseFrontmatter(raw).data, mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The device names this computer writes under. A rename in the panel adds a
 * name, so files written before it stay ours; the comparison is therefore a
 * set, and an unset `device` means "accept any".
 */
function ownsDevice(device, owner) {
  if (device === null || device === undefined) return true;
  const names = Array.isArray(device) ? device : [device];
  const value = String(owner ?? "");
  return value === "" || names.includes(value);
}

/**
 * Atomic write inside the conversation subtree. Returns
 * `{ written, reason }`; nothing is written when the file already holds
 * exactly these bytes, or when another computer owns the file.
 */
export async function writeConversationFile(root, relative, content, { device = null } = {}) {
  if (!isConversationPath(relative)) {
    throw new Error(`refusing to write outside ${CONVERSATIONS_FOLDER}: ${relative}`);
  }
  const absolute = absoluteIn(root, relative);
  const text = `${String(content).replace(/\s+$/, "")}\n`;
  const existing = await readConversationFile(root, relative);
  if (existing) {
    if (!ownsDevice(device, existing.metadata?.device)) return { written: false, reason: "OTHER_DEVICE" };
    if (existing.raw === text) return { written: false, reason: "UNCHANGED" };
  }
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(absolute)}${TEMP_SUFFIX}-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, absolute);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temp file is already gone or was never created.
    }
    throw error;
  }
  return { written: true, reason: "WRITTEN" };
}

/**
 * Idempotent delete: a missing file is a success, and so is a file another
 * computer owns (the single-writer rule). The caller may advance its cursor
 * only after this resolves without throwing.
 */
export async function deleteConversationFile(root, relative, { device = null } = {}) {
  const target = String(relative ?? "");
  if (!isConversationPath(target) || !target.endsWith(".md")) {
    throw new Error(`refusing to delete a non-note outside ${CONVERSATIONS_FOLDER}: ${relative}`);
  }
  const absolute = absoluteIn(root, target);
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return { deleted: false, reason: "MISSING" };
    throw error;
  }
  if (!info.isFile()) throw new Error(`refusing to delete a non-file: ${relative}`);
  if (!ownsDevice(device, parseFrontmatter(await readFile(absolute, "utf8")).data?.device)) {
    return { deleted: false, reason: "OTHER_DEVICE" };
  }
  try {
    await unlink(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return { deleted: false, reason: "MISSING" };
    throw error;
  }
  return { deleted: true, reason: "DELETED" };
}

/** Delete a directory when it is empty; a non-empty or missing one is fine. */
export async function removeEmptyDirectory(root, relative) {
  if (!isConversationPath(relative)) return false;
  const absolute = absoluteIn(root, relative);
  try {
    await rmdir(absolute);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EISDIR"].includes(error?.code)) return false;
    throw error;
  }
}

/**
 * Every conversation Markdown file, vault-relative. Used for rename
 * bookkeeping and for finding iCloud conflict copies; a missing folder means
 * "none yet".
 */
export async function listConversationFiles(root, relativeFolder = CONVERSATIONS_FOLDER) {
  const found = [];
  async function walk(relative) {
    const absolute = absoluteIn(root, relative);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(child);
    }
  }
  await walk(relativeFolder);
  return found.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/**
 * Resolve iCloud conflict copies inside the conversation subtree.
 *
 * A copy is only touched when it and the file it duplicates carry *this*
 * computer's `device`; anything else stays untouched, per the single-writer
 * rule. The newer `updated` wins; ties keep the canonical file.
 */
export async function resolveConflictCopies(root, { device, files = null }) {
  const all = files ?? (await listConversationFiles(root));
  const decisions = [];
  for (const relative of all) {
    const canonicalPath = conflictCopyOf(relative);
    if (!canonicalPath || !isConversationPath(canonicalPath)) continue;
    const copy = await readConversationFile(root, relative);
    if (!copy) continue;
    const canonical = await readConversationFile(root, canonicalPath);
    const copyDevice = String(copy.metadata?.device ?? "");
    const canonicalDevice = canonical ? String(canonical.metadata?.device ?? "") : "";
    // A file with no `device` is not ours to move either: skip it rather than
    // read "unset" as "this computer". A rename keeps both names valid.
    if (!copyDevice || !ownsDevice(device, copyDevice) || (canonical && canonicalDevice && !ownsDevice(device, canonicalDevice))) {
      decisions.push({ path: relative, keep: canonicalPath, action: "skipped", reason: "OTHER_DEVICE" });
      continue;
    }
    const copyUpdated = String(copy.metadata?.updated ?? "");
    const canonicalUpdated = canonical ? String(canonical.metadata?.updated ?? "") : "";
    if (!canonical || copyUpdated > canonicalUpdated) {
      if (canonical) await unlink(absoluteIn(root, canonicalPath));
      await rename(absoluteIn(root, relative), absoluteIn(root, canonicalPath));
      decisions.push({ path: relative, keep: canonicalPath, action: "promoted", reason: "NEWER" });
    } else {
      await unlink(absoluteIn(root, relative));
      decisions.push({ path: relative, keep: canonicalPath, action: "removed", reason: "OLDER" });
    }
  }
  return decisions;
}
