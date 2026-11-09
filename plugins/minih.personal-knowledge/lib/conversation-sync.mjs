import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATIONS_FOLDER,
  DAILY_FOLDER,
  RAW_FOLDER,
  RAW_PART_BYTES,
  dailyPathFor,
  localDate,
  rawPathFor,
  splitParts,
  summaryPathFor,
} from "./conversation-layout.mjs";
import { dailyNote, dailyRow, rawFrontmatter, rawTurns, summaryBody, summaryFrontmatter } from "./conversation-notes.mjs";
import {
  deleteConversationFile,
  isConversationPath,
  listConversationFiles,
  readConversationFile,
  removeEmptyDirectory,
  resolveConflictCopies,
  writeConversationFile,
} from "./conversation-files.mjs";
import { ensureObsidianIgnoreFilters } from "./obsidian-config.mjs";
import { redactSensitiveContent } from "./redact.mjs";

/**
 * Conversation archive syncer (ADR 0002 §1–§4).
 *
 * Pulls `pi.conversations.changes` once at start and every five minutes, and
 * turns each row into L2 (summary) plus L3 (transcript), with a per-computer
 * daily roll-up. Three guarantees drive the shape of this module:
 *
 *  1. **Removals arrive at least once.** A page may repeat `removed: true` for
 *     the same cursor. Deletion is therefore idempotent (a missing file is a
 *     success) and the cursor advances only after every notice in the page was
 *     handled — a failed delete throws, keeps the cursor, and is retried.
 *  2. **No summary is not nothing to write.** `summaryRevision: null` means
 *     "write L3 now, leave L2 for later", because the transcript never depends
 *     on a model.
 *  3. **One writer per file.** Every note records the computer that produced
 *     the conversation; a file owned by another device is read-only here.
 *
 * Nothing here calls a model or reads `pi.sqlite`. The only place it writes is
 * `09 Conversations/` inside the vault.
 */

export const SYNC_INTERVAL_MS = 5 * 60_000;
export const SYNC_STATE_FILE = "conversation-sync.json";
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_PASS = 50;
const TRANSCRIPT_PAGE_TURNS = 200;
const MAX_TURN_PAGES = 100;
const MAX_TRACKED_SESSIONS = 5000;

/** Stable, filesystem-safe device name (`os.hostname()` unless overridden). */
export function defaultDeviceName(hostname = os.hostname()) {
  const clean = String(hostname ?? "")
    .replace(/\.local$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "unknown-device";
}

function errorCode(error) {
  return String(error?.code ?? error?.message ?? "UNKNOWN");
}

/** Path of the local sync state (per computer, never inside the vault). */
export function syncStatePath({ home = os.homedir(), env = process.env } = {}) {
  return env.PERSONAL_KNOWLEDGE_CONVERSATION_STATE ?? path.join(home, ".personal-knowledge", SYNC_STATE_FILE);
}

export async function readSyncState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeSyncState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Vault config with the two private conversation folders ignored. L2 summaries
 * stay indexed; the transcript (`_raw`) and the daily roll-up (`_daily`) never
 * are (plan §6.2). `ignoreFolders` holds top-level folder names, which is also
 * how Obsidian's own ignore filter is keyed, so one entry serves both.
 */
export function archiveConfig(config = {}) {
  const ignore = new Set(config.ignoreFolders ?? []);
  ignore.add(`${CONVERSATIONS_FOLDER}/${RAW_FOLDER}`);
  ignore.add(`${CONVERSATIONS_FOLDER}/${DAILY_FOLDER}`);
  return { ...config, ignoreFolders: [...ignore] };
}

/** Keep the state file bounded: the newest sessions by `updatedAt`. */
export function pruneSummaries(summaries, limit = MAX_TRACKED_SESSIONS) {
  const entries = Object.entries(summaries ?? {}).filter(([, value]) => value && typeof value === "object");
  if (entries.length <= limit) return Object.fromEntries(entries);
  entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  return Object.fromEntries(entries.slice(0, limit));
}

export class ConversationSyncer {
  constructor({
    pi,
    vaultRoot,
    config = {},
    redact = redactSensitiveContent,
    statePath = syncStatePath(),
    device = defaultDeviceName(),
    deviceProvider = null,
    now = () => new Date(),
    intervalMs = SYNC_INTERVAL_MS,
    timezoneOffsetMinutes = null,
    locale = "en",
    log = null,
  } = {}) {
    this.pi = pi;
    this.vaultRoot = vaultRoot;
    this.config = config;
    this.redact = redact;
    this.statePath = statePath;
    this.device = device;
    this.deviceProvider = deviceProvider;
    this.previousDevices = [];
    this.now = now;
    this.intervalMs = intervalMs;
    this.timezoneOffsetMinutes = timezoneOffsetMinutes;
    this.locale = locale;
    this.log = log;
    this.timer = null;
    this.running = null;
    this.stopped = true;
    this.lastStatus = { state: "idle", cursor: null, written: 0, removed: 0, error: null, finishedAt: null };
  }

  /** Startup pass plus the five-minute timer. Calling twice is a no-op. */
  /** `device` is resolved lazily, so a name changed in the panel applies. */
  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    void this.syncOnce({ reason: "startup" });
    this.timer = setInterval(() => {
      void this.syncOnce({ reason: "interval" });
    }, this.intervalMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return this;
  }

  /** Clear the timer and drain an in-flight pass. Never throws. */
  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running) {
      try {
        await this.running;
      } catch {
        // The failure is already recorded in lastStatus.
      }
    }
  }

  status() {
    return { ...this.lastStatus, device: this.currentDevice(), running: Boolean(this.running) };
  }

  /** The device name this pass writes under; a provider keeps it current. */
  currentDevice() {
    const provided = typeof this.deviceProvider === "function" ? this.deviceProvider() : null;
    if (typeof provided === "string" && provided.trim() && provided.trim() !== this.device) {
      // The panel allows renaming the device. Files already written keep the
      // old name, so the old name stays an owned device (deletions still work).
      this.previousDevices = [...new Set([...(this.previousDevices ?? []), this.device])];
      this.device = provided.trim();
    }
    return this.device;
  }

  /** Names this computer has written under; only these are ours to change. */
  ownedDevices() {
    const current = this.currentDevice();
    return [current, ...(this.previousDevices ?? [])];
  }

  /** Whether a file's `device` belongs to this computer. */
  owns(device) {
    const value = String(device ?? "");
    return value === "" || this.ownedDevices().includes(value);
  }

  /** One serialized pass; concurrent callers share the in-flight run. */
  syncOnce({ reason = "manual" } = {}) {
    if (this.running) return this.running;
    this.running = this.#pass(reason)
      .catch((error) => {
        this.lastStatus = {
          ...this.lastStatus,
          state: "error",
          error: errorCode(error),
          finishedAt: this.now().toISOString(),
        };
        this.#note(`sync failed: ${errorCode(error)}`);
        return this.lastStatus;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async #pass(reason) {
    // One device name for the whole pass.
    this.currentDevice();
    const state = await readSyncState(this.statePath);
    const summaries = new Map(Object.entries(pruneSummaries(state.summaries)));
    let cursor = typeof state.cursor === "string" ? state.cursor : null;

    let page = await this.#fetchPage(cursor);
    if (!page) {
      // The archive switch is off: stay idle, delete nothing, keep the cursor.
      this.lastStatus = {
        state: "disabled",
        reason,
        device: this.device,
        cursor,
        written: 0,
        removed: 0,
        skipped: 0,
        daily: [],
        conflicts: [],
        error: null,
        finishedAt: this.now().toISOString(),
      };
      return this.lastStatus;
    }

    const result = { written: 0, removed: 0, skipped: 0, renamed: 0, daily: [], conflicts: [] };
    const touchedDays = new Set();
    let pages = 0;
    while (page && pages < MAX_PAGES_PER_PASS) {
      pages += 1;
      for (const change of page.items ?? []) {
        const sessionId = String(change?.sessionId ?? "");
        if (!sessionId) continue;
        const previous = summaries.get(sessionId) ?? null;
        if (change.removed === true) {
          const day = await this.#deleteConversation(sessionId, previous);
          summaries.delete(sessionId);
          result.removed += 1;
          if (day) touchedDays.add(day);
          continue;
        }
        const outcome = await this.#writeConversation(change, previous);
        summaries.set(sessionId, outcome.state);
        if (outcome.status === "written") result.written += 1;
        else if (outcome.status === "renamed") result.renamed += 1;
        else result.skipped += 1;
        touchedDays.add(outcome.day);
        if (previous?.day && previous.day !== outcome.day) touchedDays.add(previous.day);
      }
      cursor = page.nextCursor ?? cursor;
      page = page.nextCursor ? await this.#fetchPage(page.nextCursor) : null;
    }

    result.daily = await this.#writeDailyPages(touchedDays, summaries);
    result.conflicts = await this.#resolveConflicts();
    result.obsidianFilter = await this.#ensureObsidianFilter();

    await writeSyncState(this.statePath, {
      version: 1,
      device: this.device,
      cursor,
      updatedAt: this.now().toISOString(),
      summaries: pruneSummaries(Object.fromEntries(summaries)),
    });

    this.lastStatus = {
      ...result,
      state: "ok",
      reason,
      device: this.device,
      cursor,
      error: null,
      finishedAt: this.now().toISOString(),
    };
    this.#note(`sync ok (${reason}): ${result.written} written, ${result.removed} removed`);
    return this.lastStatus;
  }

  /** One page of the change feed, or `null` when the switch is off. */
  async #fetchPage(cursor) {
    const api = this.pi?.conversations;
    if (!api || typeof api.changes !== "function") throw new Error("CONVERSATION_API_UNAVAILABLE");
    const page = await api.changes(cursor ? { cursor, limit: PAGE_LIMIT } : { limit: PAGE_LIMIT });
    if (!page || page.enabled === false) return null;
    return page;
  }

  /**
   * Write L2 and L3 for one change. L3 is rewritten only when `lastSeq`
   * changed; L2 only when the revision changed, the title changed (rename), or
   * a summary appeared for the first time.
   */
  async #writeConversation(change, previous) {
    const sessionId = String(change.sessionId);
    const summaryPath = summaryPathFor(change, {
      config: this.config,
      timezoneOffsetMinutes: this.timezoneOffsetMinutes,
      locale: this.locale,
    });
    const day = localDate(change.createdAt, this.timezoneOffsetMinutes);
    let lastSeq = Number.isInteger(change.lastSeq) ? change.lastSeq : 0;

    const needsTranscript = !previous || previous.lastSeq !== lastSeq;
    const transcript = needsTranscript ? await this.#readTranscript(sessionId) : null;
    if (transcript && transcript.lastSeq > lastSeq) lastSeq = transcript.lastSeq;

    const revision = Number.isInteger(change.summaryRevision) ? change.summaryRevision : null;
    const revisionChanged = !previous || (previous.summaryRevision ?? null) !== revision;
    const renameDue = Boolean(previous?.summaryPath) && previous.summaryPath !== summaryPath;
    const transcriptMissing = !previous || (previous.rawPaths ?? []).length === 0;

    let summary = null;
    let coveredSeq = Number.isInteger(previous?.coveredSeq) ? previous.coveredSeq : null;
    if (revision !== null) {
      const api = this.pi?.conversations;
      if (api && typeof api.summary === "function") {
        const stored = await api.summary({ sessionId });
        summary = stored?.summary ?? null;
        if (Number.isInteger(stored?.coveredSeq)) coveredSeq = stored.coveredSeq;
      }
    }

    const rawPaths = transcript ? await this.#writeRaw(change, transcript.turns ?? []) : previous?.rawPaths ?? [];
    const rawChanged = Boolean(transcript) && rawPaths.join("|") !== (previous?.rawPaths ?? []).join("|");

    let wrote = false;
    if (!previous || revisionChanged || renameDue || transcriptMissing || rawChanged) {
      const frontmatter = summaryFrontmatter({
        change,
        device: this.currentDevice(),
        transcriptLinks: rawPaths,
        summaryRevision: revision,
        coveredSeq,
      });
      const body = summaryBody({ change, summary, transcriptLinks: rawPaths, language: this.locale });
      const written = await writeConversationFile(
        this.vaultRoot,
        summaryPath,
        `${frontmatter}\n${this.redact(body)}`,
        { device: this.ownedDevices() },
      );
      if (written.reason === "OTHER_DEVICE") {
        return { status: "skipped", day, summaryPath, state: previous ?? emptyState(change, summaryPath, day) };
      }
      wrote = written.written;
      if (renameDue && previous?.summaryPath) {
        // The conversation was renamed: the old note is this computer's, so it
        // moves with the new one.
        await deleteConversationFile(this.vaultRoot, previous.summaryPath, { device: this.ownedDevices() });
      }
    }

    return {
      status: !previous ? "written" : renameDue ? "renamed" : wrote || rawChanged ? "written" : "unchanged",
      day,
      summaryPath,
      state: {
        summaryPath,
        summaryRevision: revision,
        coveredSeq,
        lastSeq,
        rawPaths,
        day,
        title: change.title ?? "",
        project: change.project ?? null,
        createdAt: change.createdAt,
        updatedAt: change.updatedAt,
        goal: summary?.goal ?? previous?.goal ?? "",
      },
    };
  }

  /** Every transcript page of one session, already ordered by turn. */
  async #readTranscript(sessionId) {
    const api = this.pi?.conversations;
    if (!api || typeof api.transcript !== "function") return { turns: [], lastSeq: 0 };
    const turns = [];
    let fromTurn = 0;
    let lastSeq = 0;
    for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
      const result = await api.transcript({ sessionId, fromTurn, limit: TRANSCRIPT_PAGE_TURNS });
      if (Number.isInteger(result?.lastSeq)) lastSeq = result.lastSeq;
      turns.push(...(result?.turns ?? []));
      if (result?.nextTurn === null || result?.nextTurn === undefined) break;
      fromTurn = result.nextTurn;
    }
    return { turns, lastSeq };
  }

  /** L3: one file, or several parts once a session passes 512 KiB. */
  async #writeRaw(change, turns) {
    const header = (part, partCount) =>
      `${rawFrontmatter({ change, device: this.currentDevice(), part, partCount })}\n`;
    const title = `# ${change.title || "Conversation"}\n\n`;
    const chunks =
      turns.length === 0
        ? [
            this.locale === "zh"
              ? "（这次会话还没有可归档的轮次。）\n"
              : "(This conversation has no archived turns yet.)\n",
          ]
        : turns.map(
            (turn) =>
              `${rawTurns({ turns: [turn], timezoneOffsetMinutes: this.timezoneOffsetMinutes, language: this.locale })}\n`,
          );
    const headReserve = Buffer.byteLength(header(1, 1), "utf8") + Buffer.byteLength(title, "utf8") + 128;
    const pieces = splitParts(chunks, { maxBytes: RAW_PART_BYTES - headReserve });
    const paths = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const part = index + 1;
      const relative = rawPathFor(change, { config: this.config, part });
      paths.push(relative);
      const content = `${header(part, pieces.length)}${title}${this.redact(pieces[index])}`;
      const written = await writeConversationFile(this.vaultRoot, relative, content, { device: this.ownedDevices() });
      if (written.reason === "OTHER_DEVICE") throw new Error(`REFUSED_OTHER_DEVICE: ${relative}`);
    }
    // Parts that a shorter transcript no longer needs (a regenerate that
    // replaced turns) are this computer's leftovers.
    if (paths.length > 0) {
      for (let part = paths.length + 1; part <= 9; part += 1) {
        const stale = rawPathFor(change, { config: this.config, part });
        const result = await deleteConversationFile(this.vaultRoot, stale, { device: this.ownedDevices() });
        if (result.reason === "MISSING") break;
      }
    }
    return paths;
  }

  /** Delete this computer's L2 and L3 for a session. Idempotent. */
  async #deleteConversation(sessionId, previous) {
    const candidates = new Set();
    if (previous?.summaryPath) candidates.add(previous.summaryPath);
    for (const relative of previous?.rawPaths ?? []) candidates.add(relative);
    if (candidates.size === 0) {
      // No bookkeeping (first sight of the notice): find the files by their
      // `session_id`, which only this computer writes.
      for (const relative of await listConversationFiles(this.vaultRoot)) {
        if (!isConversationPath(relative)) continue;
        const record = await readConversationFile(this.vaultRoot, relative);
        if (String(record?.metadata?.session_id ?? "") === sessionId) candidates.add(relative);
      }
    }
    const folders = new Set();
    for (const relative of candidates) {
      await deleteConversationFile(this.vaultRoot, relative, { device: this.ownedDevices() });
      folders.add(path.posix.dirname(relative));
    }
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
      let current = folder;
      while (current.startsWith(`${CONVERSATIONS_FOLDER}/`)) {
        const removed = await removeEmptyDirectory(this.vaultRoot, current);
        if (!removed) break;
        current = path.posix.dirname(current);
      }
    }
    return previous?.day ?? localDate(previous?.createdAt ?? this.now().getTime(), this.timezoneOffsetMinutes);
  }

  /** Rewrite the touched daily pages from the state; no model involved. */
  async #writeDailyPages(days, summaries) {
    const written = [];
    for (const day of days) {
      if (!day) continue;
      const rows = [];
      for (const [sessionId, entry] of summaries) {
        if (!entry || entry.day !== day || !entry.summaryPath) continue;
        rows.push(
          dailyRow({
            change: {
              sessionId,
              title: entry.title,
              project: entry.project,
              createdAt: entry.createdAt ?? this.now().getTime(),
              goal: entry.goal,
            },
            summaryPath: entry.summaryPath,
          }),
        );
      }
      const relative = dailyPathFor(day, this.currentDevice());
      const content = dailyNote({ day, device: this.currentDevice(), rows, language: this.locale });
      const result = await writeConversationFile(this.vaultRoot, relative, this.redact(content), { device: this.ownedDevices() });
      if (result.written) written.push(relative);
    }
    return written;
  }

  /** Append the transcript folder to Obsidian's ignore filter, once. */
  async #ensureObsidianFilter() {
    if (this.obsidianFilterDone) return null;
    try {
      const result = await ensureObsidianIgnoreFilters(this.vaultRoot);
      if (result.changed || result.reason === "NO_OBSIDIAN_CONFIG") this.obsidianFilterDone = true;
      return result.changed ? { added: result.added } : null;
    } catch (error) {
      this.#note(`obsidian filter failed: ${errorCode(error)}`);
      return null;
    }
  }

  async #resolveConflicts() {
    try {
      const files = await listConversationFiles(this.vaultRoot);
      return await resolveConflictCopies(this.vaultRoot, { device: this.device, files });
    } catch (error) {
      this.#note(`conflict scan failed: ${errorCode(error)}: ${error?.message}`);
      return [];
    }
  }

  #note(message) {
    if (typeof this.log === "function") this.log(`[conversation-sync] ${message}`);
  }
}

function emptyState(change, summaryPath, day) {
  return {
    summaryPath,
    summaryRevision: null,
    coveredSeq: null,
    lastSeq: Number.isInteger(change.lastSeq) ? change.lastSeq : 0,
    rawPaths: [],
    day,
    title: change.title ?? "",
    project: change.project ?? null,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    goal: "",
  };
}
