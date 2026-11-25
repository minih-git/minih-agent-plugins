"use strict";

/**
 * Which mailbox is the trash, and which one is the archive.
 *
 * Delete and archive need a destination, and no two mail servers name it the
 * same way: `\Trash` and `\Archive` are the RFC 6154 special-use flags, but only
 * a server that supports SPECIAL-USE reports them, and many report nothing at
 * all. So this file does what a mail client has to do — prefer the declared flag,
 * then fall back to the names this part of the world actually uses, in English
 * and in Chinese, including the mailbox each provider's web interface shows.
 *
 * Two rules keep the fallback from guessing dangerously:
 *
 * - a `\Noselect` mailbox is never a destination: it cannot hold a message, so a
 *   move into it fails;
 * - a name is matched as a whole leaf, never as a substring, so `Trash/2024` and
 *   `Saved` do not become "the trash".
 *
 * The result is cached per account in `createFolderCache`, because probing costs
 * a `LIST` and the answer only changes when the account's connection does.
 */

/** The one mailbox each provider is expected to have, as a leaf name. */
const TRASH_NAMES = [
  "trash",
  "deleted",
  "deleted messages",
  "deleted items",
  "deleted-mail",
  "deletedmail",
  "bin",
  "recycle bin",
  "wastebasket",
  "已删除",
  "已删除邮件",
  "刪除郵件",
  "废纸篓",
  "垃圾箱",
  "垃圾桶",
  "ゴミ箱",
];

/** The same for the archive: Gmail's "All Mail" behaves as one over IMAP. */
const ARCHIVE_NAMES = ["archive", "archives", "all mail", "allmail", "归档", "存档", "歸檔", "所有邮件", "所有郵件"];

function hasFlag(entry, flag) {
  const wanted = String(flag).toUpperCase();
  return entry.flags.some((value) => String(value).toUpperCase() === wanted);
}

/** The leaf of a mailbox path: `[Gmail]/All Mail` -> `All Mail`. */
function leafName(entry) {
  const name = String(entry.name ?? "");
  const delimiter = entry.delimiter || "/";
  const index = name.lastIndexOf(delimiter);
  return (index >= 0 ? name.slice(index + delimiter.length) : name).trim();
}

/** A mailbox a message can be moved into and read back from. */
function selectable(entry) {
  return Boolean(entry.name) && !hasFlag(entry, "\\Noselect") && !hasFlag(entry, "\\NonExistent");
}

function pick(entries, flag, names) {
  const usable = entries.filter(selectable);
  for (const entry of usable) {
    if (hasFlag(entry, flag)) return entry;
  }
  const wanted = new Set(names);
  // A top-level name matches before a nested one: `Trash` is the trash, while
  // `Archive/Trash` is somebody's folder that happens to be called that.
  const sorted = [...usable].sort((a, b) => a.name.split(a.delimiter || "/").length - b.name.split(b.delimiter || "/").length);
  for (const entry of sorted) {
    if (wanted.has(leafName(entry).toLowerCase())) return entry;
  }
  return null;
}

/**
 * The two destinations this account offers.
 *
 * @returns `{ trash: string|null, archive: string|null }` — the mailbox names as
 *   the server spells them, or `null` when the account has nothing to offer.
 */
function resolveFolders(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === "object") : [];
  const trash = pick(list, "\\Trash", TRASH_NAMES);
  const archive = pick(list, "\\Archive", ARCHIVE_NAMES);
  return {
    trash: trash ? trash.name : null,
    archive: archive ? archive.name : null,
    specialUse: list.some((entry) => hasFlag(entry, "\\Trash") || hasFlag(entry, "\\Archive")),
  };
}

/**
 * One cache entry per account, tied to the connection it was learned from.
 *
 * A different server, protocol or port is a different mailbox list, so the key
 * is the account's connection key: the caller drops the entry when that changes
 * and every probe after that is a fresh one.
 */
function createFolderCache() {
  const entries = new Map();
  return {
    get(instanceId, connectionKey) {
      const cached = entries.get(instanceId);
      if (!cached || cached.key !== connectionKey) return null;
      return cached.folders;
    },
    set(instanceId, connectionKey, folders) {
      entries.set(instanceId, { key: connectionKey, folders });
      return folders;
    },
    /** Whether this account still needs a probe. */
    needs(instanceId, connectionKey) {
      const cached = entries.get(instanceId);
      return !cached || cached.key !== connectionKey;
    },
    forget(instanceId) {
      entries.delete(instanceId);
    },
    clear() {
      entries.clear();
    },
  };
}

module.exports = {
  ARCHIVE_NAMES,
  TRASH_NAMES,
  createFolderCache,
  leafName,
  resolveFolders,
};