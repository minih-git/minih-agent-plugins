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
  "deleted items",
  "deleted messages",
  "deleted emails",
  "deleted-mail",
  "deletedmail",
  "recycle bin",
  "wastebasket",
  "已删除",
  "已删除邮件",
  "刪除郵件",
  "废纸篓",
  "ゴミ箱",
];

/** The same for the archive: Gmail's "All Mail" behaves as one over IMAP. */
const ARCHIVE_NAMES = [
  "archive",
  "archives",
  "archived",
  "all mail",
  "allmail",
  "归档",
  "存档",
  "歸檔",
  "所有邮件",
  "所有郵件",
];

/**
 * Where a copy of a sent message goes.
 *
 * `\Sent` is the RFC 6154 flag; the names are what the providers this plugin
 * ships actually call the mailbox, in the order a client should prefer them
 * (`Sent` before `Sent Messages`, because the list is a priority list). Gmail
 * needs no entry: it files what it sends, so its accounts skip the copy entirely
 * (see `lib/runtime.js`).
 */
const SENT_NAMES = [
  "sent",
  "sent items",
  "sent messages",
  "sent mail",
  "sent-mail",
  "sentmail",
  "已发送",
  "已发送邮件",
  "寄件備份",
  "寄件备份",
  "送信済み",
];

/**
 * The flags that make a mailbox the wrong destination whatever its name.
 *
 * `\Junk` is the important one: 垃圾箱 and 垃圾桶 in the Chinese providers are the
 * spam folder, not the trash, and a message moved there can even teach the
 * provider's filter. Such a mailbox is never a delete or archive target, even
 * when the server also flags it `\Trash` by mistake.
 */
const NEVER_DESTINATIONS = ["\\Noselect", "\\NonExistent", "\\Junk", "\\Spam"];

function hasFlag(entry, flag) {
  const wanted = String(flag).toUpperCase();
  return entry.flags.some((value) => String(value).toUpperCase() === wanted);
}

/**
 * The leaf of a mailbox path: `[Gmail]/All Mail` -> `All Mail`.
 *
 * The *label* is used, not the raw name: a server spells `已删除` as modified
 * UTF-7 (`&XfJSIJZk-`), and comparing that against a name table would never match.
 */
function leafName(entry) {
  const name = String(entry.label ?? entry.name ?? "");
  const delimiter = entry.delimiter || "/";
  const index = name.lastIndexOf(delimiter);
  return (index >= 0 ? name.slice(index + delimiter.length) : name).trim();
}

/** A mailbox a message can be moved into and read back from. */
function selectable(entry) {
  return Boolean(entry.name) && !NEVER_DESTINATIONS.some((flag) => hasFlag(entry, flag));
}

/** How deeply a mailbox is nested, so the shallowest match can win. */
function depthOf(entry) {
  const delimiter = entry.delimiter || "/";
  return String(entry.name ?? "").split(delimiter).length;
}

/**
 * The mailbox a flag or a name points at.
 *
 * Three rules, in this order: a declared special-use flag wins; otherwise the
 * name table decides, **in its own order** — `Trash` before `Deleted Messages`,
 * because the list is a priority list and the server's `LIST` order means
 * nothing; and among equal names the shallowest mailbox wins, so `Trash` beats
 * `Archive/Trash`.
 */
function pick(entries, flag, names) {
  const usable = entries.filter(selectable);
  const declared = usable.find((entry) => hasFlag(entry, flag));
  if (declared) return declared;
  for (const wanted of names) {
    const matches = usable.filter((entry) => leafName(entry).toLowerCase() === wanted);
    if (!matches.length) continue;
    matches.sort((a, b) => depthOf(a) - depthOf(b));
    return matches[0];
  }
  return null;
}

/**
 * The destinations this account offers.
 *
 * @returns `{ trash, archive, sent, specialUse }` — the mailbox names as the
 *   server spells them, each `null` when the account has nothing to offer.
 */
function resolveFolders(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === "object") : [];
  const trash = pick(list, "\\Trash", TRASH_NAMES);
  const archive = pick(list, "\\Archive", ARCHIVE_NAMES);
  const sent = pick(list, "\\Sent", SENT_NAMES);
  return {
    trash: trash ? trash.name : null,
    archive: archive ? archive.name : null,
    // Where a copy of a sent message is filed; `null` means this mailbox has no
    // such folder and the copy is skipped rather than guessed into another one.
    sent: sent ? sent.name : null,
    specialUse: list.some(
      (entry) => hasFlag(entry, "\\Trash") || hasFlag(entry, "\\Archive") || hasFlag(entry, "\\Sent"),
    ),
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
  SENT_NAMES,
  TRASH_NAMES,
  createFolderCache,
  leafName,
  resolveFolders,
};