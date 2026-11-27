"use strict";

/**
 * The messages the user has opened, kept on this computer so that opening one a
 * second time costs no download.
 *
 * Three decisions live here and nowhere else:
 *
 * - **The key is a hash.** A message key is either a Message-ID (`<q@example.com>`)
 *   or `uid:<uidValidity>:<uid>`, and neither is a file name: `:`, `<` and `..`
 *   mean something to a filesystem. Every body is stored as
 *   `sha256(accountId NUL key).eml`, so a key can only ever name a file inside this
 *   directory; the key itself is kept in the index, where it costs nothing.
 * - **The index is the truth about size.** One small JSON document lists every
 *   entry with the bytes it occupies and when it was last opened. The panel's
 *   "how much is this using" answer is a sum over this map, not a directory walk;
 *   the budget and the 30-day limit are decided from it as well.
 * - **Every write is a rename.** A body is written to a temporary file beside its
 *   target and renamed over it, and the index is written the same way, so a crash
 *   leaves the previous state instead of half a file. Two opens of the same message
 *   at once are serialized on one queue, so the last whole answer wins.
 *
 * What this module deliberately does not do: it never parses a message (the caller
 * does, from the bytes it hands back), it never fetches anything, and it never
 * throws at its callers. A cache is an optimization: a missing, half-written,
 * expired or unwritable entry is a miss, and the caller downloads the body as it
 * always did.
 */

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

/** The directory this cache owns inside the plugin's data folder. */
const DIR_NAME = "body-cache";
/** The one file that describes the rest. */
const INDEX_NAME = "index.json";
/** The index shape, so a later version can migrate instead of guess. */
const INDEX_VERSION = 1;
/**
 * How much of every mailbox's opened mail may be kept.
 *
 * 200 MiB is roughly 200 full-size (1 MiB) bodies or a few thousand ordinary
 * ones — more than a person re-opens in a month, and small enough that it stays a
 * cache rather than a mailbox copy.
 */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** How long a body nobody opened again is kept. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The identity of one entry: two parts, joined by a character neither may hold. */
function identityOf(accountId, key) {
  return `${String(accountId ?? "")}\u0000${String(key ?? "")}`;
}

/** A file name for one entry: a hash, and nothing the key could smuggle in. */
function fileOf(accountId, key) {
  return `${crypto.createHash("sha256").update(identityOf(accountId, key)).digest("hex")}.eml`;
}

/** Only a name this module could have written is trusted out of the index. */
const STORED_FILE = /^[0-9a-f]{64}\.eml$/;

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

/**
 * One cache over one directory.
 *
 * `now` is injected so the age limit and the eviction order can be tested against
 * a clock a test moves instead of a month of waiting, and `maxBytes`/`maxAgeMs` so
 * those two rules can be exercised without writing two hundred megabytes.
 */
function createBodyCache(options = {}) {
  const dir = String(options.dir ?? "");
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => {};
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxAgeMs = Number.isInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : MAX_AGE_MS;
  const indexFile = path.join(dir, INDEX_NAME);
  /** Every entry, by `identityOf(accountId, key)`. */
  const entries = new Map();
  /** One writer at a time: an index is a whole document, not a series of edits. */
  let queue = Promise.resolve();
  let loading = null;
  let tempSeq = 0;
  /** Whether a deferred "this body was opened" write is already queued. */
  let touchQueued = false;

  function enqueue(run) {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Run one step of the queue, and never let its failure reach a caller. */
  async function guarded(run) {
    try {
      return await run();
    } catch (error) {
      log("warn", `body cache: ${error?.message ?? error}`);
      return undefined;
    }
  }

  function totalBytes() {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    return total;
  }

  function expired(entry) {
    return now() - entry.openedAt > maxAgeMs;
  }

  /** Write the index beside itself and rename it over, so a reader sees one whole document. */
  async function persistIndex() {
    const document = {
      version: INDEX_VERSION,
      entries: [...entries.values()].map((entry) => ({
        accountId: entry.accountId,
        key: entry.key,
        file: entry.file,
        bytes: entry.bytes,
        size: entry.size,
        truncated: entry.truncated,
        openedAt: entry.openedAt,
      })),
    };
    await fs.mkdir(dir, { recursive: true });
    const temporary = `${indexFile}.${process.pid}.${(tempSeq += 1)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
      await fs.rename(temporary, indexFile);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Forget one entry: its bytes and its line in the index. Caller holds the queue. */
  async function dropLocked(entry) {
    entries.delete(identityOf(entry.accountId, entry.key));
    await fs.rm(path.join(dir, entry.file), { force: true }).catch(() => undefined);
  }

  /**
   * Enforce the two limits: age first, then the budget, oldest open first.
   *
   * Age is not a second opinion about the budget — a body opened once a month ago
   * is gone whether or not there is room for it, because the promise to the user is
   * "nothing older than 30 days stays on this computer".
   */
  async function sweepLocked() {
    let changed = false;
    for (const entry of [...entries.values()]) {
      if (!expired(entry)) continue;
      await dropLocked(entry);
      changed = true;
    }
    let total = totalBytes();
    if (total <= maxBytes) return changed;
    const oldestFirst = [...entries.values()].sort((left, right) => left.openedAt - right.openedAt);
    for (const entry of oldestFirst) {
      if (total <= maxBytes) break;
      total -= entry.bytes;
      await dropLocked(entry);
      changed = true;
    }
    return changed;
  }

  /** Remove anything in the directory the index does not name: orphans and half a write. */
  async function tidy() {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const keep = new Set([...entries.values()].map((entry) => entry.file));
    keep.add(INDEX_NAME);
    for (const name of names) {
      if (keep.has(name)) continue;
      await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
    }
  }

  /** Read the index, keeping only entries that could have been written here. */
  function adopt(raw) {
    entries.clear();
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const item of list) {
      if (!item || typeof item.accountId !== "string" || typeof item.key !== "string") continue;
      if (typeof item.file !== "string" || !STORED_FILE.test(item.file)) continue;
      const bytes = Number(item.bytes);
      if (!Number.isInteger(bytes) || bytes <= 0) continue;
      const openedAt = Number(item.openedAt);
      entries.set(identityOf(item.accountId, item.key), {
        accountId: item.accountId,
        key: item.key,
        file: item.file,
        bytes,
        size: Number.isInteger(item.size) ? item.size : bytes,
        truncated: item.truncated === true,
        openedAt: Number.isFinite(openedAt) ? openedAt : now(),
      });
    }
  }

  /**
   * Read the index once, then trust memory.
   *
   * A damaged index is an empty cache, not an error: the bodies it described are
   * unreachable, so `tidy` deletes them and the next open fills the cache again.
   */
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      await fs.mkdir(dir, { recursive: true }).catch((error) => {
        // A directory this plugin cannot create is a cache that stores nothing;
        // opening mail must keep working, so this is a warning and no more.
        log("warn", `body cache is unavailable: ${error?.message ?? error}`);
      });
      const raw = await fs.readFile(indexFile, "utf8").catch(() => null);
      if (raw !== null) {
        try {
          adopt(raw);
        } catch (error) {
          log("warn", `body cache index is unreadable: ${error?.message ?? error}`);
          entries.clear();
        }
      }
      const swept = await guarded(() => sweepLocked());
      await guarded(() => tidy());
      if (swept) await guarded(() => persistIndex());
      return { bytes: totalBytes(), entries: entries.size };
    })();
    return loading;
  }

  /**
   * One message body, or `null` when this cache cannot answer for it.
   *
   * The stored length is compared with the file's own length: a short file is a
   * half-written one, and handing half a message to the reading pane would be worse
   * than downloading it again.
   */
  async function read(accountId, key) {
    await load();
    const id = identityOf(accountId, key);
    const entry = entries.get(id);
    if (!entry) return null;
    if (expired(entry)) {
      await enqueue(async () => {
        const current = entries.get(id);
        if (!current) return;
        await dropLocked(current);
        await guarded(() => persistIndex());
      });
      return null;
    }
    let body;
    try {
      body = await fs.readFile(path.join(dir, entry.file));
    } catch {
      body = null;
    }
    if (!body || body.length !== entry.bytes) {
      await enqueue(async () => {
        const current = entries.get(id);
        if (!current) return;
        await dropLocked(current);
        await guarded(() => persistIndex());
      });
      return null;
    }
    // When it was last opened is what the eviction order is: a hit moves this entry
    // to the newest end. One write covers a burst of opens — the record is saved
    // without making the caller wait, because a failed write here only costs the
    // entry its place in the queue, and the next open persists again.
    entry.openedAt = now();
    if (!touchQueued) {
      touchQueued = true;
      enqueue(async () => {
        touchQueued = false;
        await guarded(() => persistIndex());
      });
    }
    return { body, size: entry.size, truncated: entry.truncated === true };
  }

  /** Keep one body. `false` means nothing was stored, never that anything failed. */
  async function write(accountId, key, value, metadata = {}) {
    await load();
    const body = toBytes(value);
    if (!body.length) return false;
    // A single body larger than the whole budget would evict everything else and
    // still not fit; the caller's 1 MiB cap makes this a guard, not a path.
    if (body.length > maxBytes) return false;
    const id = identityOf(accountId, key);
    const stored = await enqueue(async () => {
      const file = fileOf(accountId, key);
      const target = path.join(dir, file);
      const temporary = `${target}.${process.pid}.${(tempSeq += 1)}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(temporary, body);
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        log("warn", `body cache could not keep a message: ${error?.message ?? error}`);
        return false;
      }
      entries.set(id, {
        accountId: String(accountId ?? ""),
        key: String(key ?? ""),
        file,
        bytes: body.length,
        size: Number.isInteger(metadata.size) ? metadata.size : body.length,
        truncated: metadata.truncated === true,
        openedAt: now(),
      });
      await guarded(() => sweepLocked());
      await guarded(() => persistIndex());
      return true;
    });
    return stored === true;
  }

  /** Drop one entry, because the message it belongs to is gone. */
  async function remove(accountId, key) {
    await load();
    const id = identityOf(accountId, key);
    if (!entries.has(id)) return false;
    return enqueue(async () => {
      const current = entries.get(id);
      if (!current) return false;
      await dropLocked(current);
      await guarded(() => persistIndex());
      return true;
    });
  }

  /** Drop one mailbox's bodies, because the mailbox is no longer watched here. */
  async function clearAccount(accountId) {
    await load();
    const wanted = String(accountId ?? "");
    return enqueue(async () => {
      let dropped = 0;
      for (const entry of [...entries.values()]) {
        if (entry.accountId !== wanted) continue;
        await dropLocked(entry);
        dropped += 1;
      }
      if (dropped) await guarded(() => persistIndex());
      return dropped;
    });
  }

  /** Drop everything, because the user pressed the button. */
  async function clear() {
    await load();
    return enqueue(async () => {
      const count = entries.size;
      entries.clear();
      await fs.rm(dir, { recursive: true, force: true }).catch((error) => {
        log("warn", `body cache could not be emptied: ${error?.message ?? error}`);
      });
      await guarded(() => persistIndex());
      return count;
    });
  }

  /** What the panel shows: how much space these bodies take, and how many there are. */
  function stats() {
    return { bytes: totalBytes(), entries: entries.size };
  }

  return { clear, clearAccount, load, read, remove, stats, write };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DIR_NAME,
  INDEX_NAME,
  INDEX_VERSION,
  MAX_AGE_MS,
  createBodyCache,
};
