import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * L0 profile candidates (ADR 0002 §6).
 *
 * The profile note `08 Standards/个人画像.md` is always the user's own: this
 * module never edits it. Once a week at most it summarizes recent conversation
 * summaries and user-scoped learned memory into a candidate note under
 * `00 Inbox/`, and stops. Opt-in, off by default, and only through
 * `pi.agent.complete`.
 */

export const PROFILE_NOTE = "08 Standards/个人画像.md";
export const INBOX_PREFIX = "00 Inbox/";
export const CANDIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROFILE_SETTINGS_FILE = "profile-candidates.json";
const MAX_SESSIONS = 12;
const MAX_MEMORY_ENTRIES = 40;

export function profileSettingsPath({ home = os.homedir(), env = process.env } = {}) {
  return env.PERSONAL_KNOWLEDGE_PROFILE_SETTINGS ?? path.join(home, ".personal-knowledge", PROFILE_SETTINGS_FILE);
}

export async function readProfileSettings(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeProfileSettings(filePath, settings) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Whether a run is due. `enabled` defaults to false; a run needs the switch,
 * the model key, and at least a week since the last attempt (a failed attempt
 * counts, so a broken model cannot retry in a loop).
 */
export function candidateDue(settings, now = new Date()) {
  if (settings?.enabled !== true) return { due: false, reason: "DISABLED" };
  if (typeof settings.modelKey !== "string" || !settings.modelKey.trim()) {
    return { due: false, reason: "MODEL_REQUIRED" };
  }
  const last = Date.parse(String(settings.lastRunAt ?? ""));
  if (Number.isFinite(last) && now.getTime() - last < CANDIDATE_INTERVAL_MS) {
    return { due: false, reason: "TOO_SOON", nextEligibleAt: new Date(last + CANDIDATE_INTERVAL_MS).toISOString() };
  }
  return { due: true, reason: null };
}

function bullet(items) {
  const values = (items ?? []).map((item) => String(item ?? "").replace(/\r?\n/g, " ").trim()).filter(Boolean);
  return values.length > 0 ? values.map((item) => `- ${item}`).join("\n") : "- (none)";
}

/** The prompt: recent summaries plus user-scoped memory, nothing else. */
export function buildPrompt({ sessions, memoryEntries }) {
  const sessionBlocks = sessions.map((session) =>
    [
      `### ${session.title || session.sessionId} (${session.created || "unknown date"})`,
      `Project: ${session.project || "—"}`,
      session.goal ? `Goal: ${session.goal}` : "",
      session.decisions?.length ? `Decisions:\n${bullet(session.decisions)}` : "",
      session.outcomes?.length ? `Outcomes:\n${bullet(session.outcomes)}` : "",
      session.openItems?.length ? `Open items:\n${bullet(session.openItems)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const memory = (memoryEntries ?? []).map((entry) => `- [${entry.kind}] ${String(entry.content ?? "").replace(/\r?\n/g, " ")}`);
  return [
    "Recent archived conversations:",
    sessionBlocks.join("\n\n") || "(none)",
    "",
    "Learned memory (user scope):",
    memory.join("\n") || "(none)",
  ].join("\n");
}

export const PROFILE_SYSTEM_PROMPT = [
  "You maintain a candidate update for a personal profile note.",
  "Read only the material given; do not invent facts.",
  "Return a short Markdown list of proposed profile changes: preferences, working style, stack, boundaries, and recurring goals.",
  "For each item name the evidence (the session date or the memory line) and say whether it confirms, corrects, or extends the current profile.",
  "Keep it under 40 lines. Never include credentials, tokens, or personal data the material does not state.",
].join("\n");

/**
 * Produce one candidate note. Returns `{ written, path }` or
 * `{ written: false, reason }`; the profile note itself is never touched.
 */
export async function runProfileCandidate({
  service,
  pi = globalThis.pi,
  settings,
  /**
   * A run the user asked for right now (`kg.profile.run`). It ignores the
   * one-per-week limit — and only that: the switch must be on, a model must be
   * chosen, and the vault must not be read-only, exactly like an automatic run.
   * The attempt still records `lastRunAt`, so the schedule restarts from it.
   */
  manual = false,
  // Not `now = new Date()`: a default is evaluated once at module load, which
  // would freeze the clock for every later run.
  now = null,
  home = os.homedir(),
  env = process.env,
  log = null,
} = {}) {
  const at = now ?? new Date();
  const state = settings ?? (await readProfileSettings(profileSettingsPath({ home, env })));
  const due = candidateDue(state, at);
  // The weekly window is the only condition a manual run lifts; DISABLED and
  // MODEL_REQUIRED still stop it here, before anything is read or sent.
  if (!due.due && !(manual && due.reason === "TOO_SOON")) {
    return { written: false, reason: due.reason, nextEligibleAt: due.nextEligibleAt ?? null };
  }
  const complete = pi?.agent?.complete;
  if (typeof complete !== "function") return { written: false, reason: "AGENT_COMPLETE_UNAVAILABLE" };

  const sessions = (await recentSessions(service)).slice(0, MAX_SESSIONS);
  const memoryEntries = await collectUserMemory(pi);
  if (sessions.length === 0 && memoryEntries.length === 0) {
    return { written: false, reason: "NO_MATERIAL" };
  }

  const day = at.toISOString().slice(0, 10);
  const prompt = buildPrompt({ sessions, memoryEntries });
  let text;
  try {
    const result = await complete({
      modelKey: String(state.modelKey).trim(),
      system: PROFILE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      includeSessionContext: false,
    });
    text = String(result?.text ?? "").trim();
  } catch (error) {
    await writeProfileSettings(profileSettingsPath({ home, env }), {
      ...state,
      lastRunAt: at.toISOString(),
      lastError: String(error?.code ?? error?.message ?? "UNKNOWN"),
    });
    return { written: false, reason: "MODEL_FAILED" };
  }
  if (!text) {
    await writeProfileSettings(profileSettingsPath({ home, env }), { ...state, lastRunAt: at.toISOString(), lastError: "EMPTY" });
    return { written: false, reason: "EMPTY" };
  }

  const relative = `${INBOX_PREFIX}画像候选 ${day}.md`;
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(`画像候选 ${day}`)}`,
    "type: review",
    "status: active",
    `created: ${day}`,
    `updated: ${day}`,
    "review_interval: none",
    `source: "conversation-archive"`,
    "---",
  ].join("\n");
  const body = [
    "",
    `# 画像候选 ${day}`,
    "",
    "> 由 Personal Knowledge 插件根据最近的会话摘要和学习记忆生成，尚未合并。",
    `> 确认后再手动合并进 ${PROFILE_NOTE}；插件不会自动修改画像。`,
    "",
    text,
    "",
    "## 依据的会话",
    "",
    sessions.length > 0
      ? sessions.map((session) => `- ${session.created} · ${session.title} · session ${session.sessionId}`).join("\n")
      : "- 本次没有可用的会话摘要",
    "",
  ].join("\n");
  // `knowledge_write` defaults to a dry run; this note is a deliberate write.
  const summary = await service.write({ path: relative, content: `${frontmatter}${body}`, create: true, dryRun: false });
  if (summary.action !== "create") {
    throw new Error(`profile candidate was not written: ${summary.action}`);
  }
  await writeProfileSettings(profileSettingsPath({ home, env }), {
    ...state,
    lastRunAt: at.toISOString(),
    lastError: null,
    lastCandidate: relative,
  });
  if (typeof log === "function") log(`[profile] candidate written: ${summary.path}`);
  return { written: true, path: relative };
}

/** The newest archived summaries, as prompt material (content, not links). */
async function recentSessions(service) {
  try {
    const recent = await service.conversationsFor({ project: null, limit: MAX_SESSIONS });
    const rows = [];
    for (const item of recent.items ?? []) {
      const record = service.index.note(item.path);
      if (!record) continue;
      const sections = bodySections(record.raw);
      rows.push({
        sessionId: item.sessionId,
        title: item.title,
        created: item.created,
        project: item.project || "",
        goal: sections.Goal ?? sections.目标 ?? item.goal ?? "",
        decisions: facts("Decisions", record.raw, sections),
        outcomes: facts("Outcomes", record.raw, sections),
        openItems: facts("Open items", record.raw, sections),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/** `## Heading` → first non-empty line, for goals and other one-liners. */
function bodySections(raw) {
  const out = {};
  const lines = String(raw ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^## (.+)$/.exec(lines[index].trim());
    if (!match) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const value = lines[cursor].trim();
      if (!value) continue;
      if (value.startsWith("#")) break;
      out[match[1].trim()] = value.replace(/^- /, "");
      break;
    }
  }
  return out;
}

/** Bullet items under `## <heading>`, in both languages. */
function facts(heading, raw, sections, alternative = null) {
  const names = [heading, alternative].filter(Boolean);
  const lines = String(raw ?? "").split(/\r?\n/);
  for (const name of names) {
    const index = lines.findIndex((line) => line.trim() === `## ${name}`);
    if (index < 0) continue;
    const items = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const value = lines[cursor].trim();
      if (value.startsWith("## ")) break;
      if (value.startsWith("- ") && value !== "- None" && value !== "- （无）") items.push(value.slice(2));
    }
    return items;
  }
  void sections;
  return [];
}

/** User-scoped learned-memory entries, when the host allows reading them. */
async function collectUserMemory(pi) {
  const list = pi?.memory?.list;
  if (typeof list !== "function") return [];
  const entries = [];
  let offset = 0;
  for (let page = 0; page < 5; page += 1) {
    let result;
    try {
      result = await list({ scope: "user", limit: 100, offset });
    } catch {
      return entries;
    }
    if (result?.readEnabled === false) return entries;
    entries.push(...(result?.entries ?? []));
    if (result?.nextOffset === null || result?.nextOffset === undefined) break;
    offset = result.nextOffset;
  }
  return entries.slice(0, MAX_MEMORY_ENTRIES);
}

/**
 * The weekly automatic run (ADR 0002 §8).
 *
 * A plain checker on a six-hour timer: it starts nothing when the switch is
 * off, when no model is chosen, when the last attempt is younger than a week,
 * or when the plugin is read-only. `onLoad` starts it and `onUnload` stops it;
 * the timer never keeps the process alive and never overlaps itself.
 */
export const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class ProfileCandidateScheduler {
  constructor({
    run,
    settings = null,
    now = () => new Date(),
    intervalMs = SCHEDULE_INTERVAL_MS,
    isReadOnly = async () => false,
    log = null,
  } = {}) {
    this.run = run;
    this.settings = settings;
    this.now = now;
    this.intervalMs = intervalMs;
    this.isReadOnly = isReadOnly;
    this.log = log;
    this.timer = null;
    this.running = null;
    this.stopped = true;
    this.lastCheck = null;
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    void this.check({ reason: "startup" });
    this.timer = setInterval(() => {
      void this.check({ reason: "interval" });
    }, this.intervalMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return this;
  }

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
        // A failed run already recorded its reason in the settings file.
      }
    }
  }

  /** One check; a check already in flight is shared. */
  check({ reason = "manual" } = {}) {
    if (this.running) return this.running;
    this.running = this.#tick(reason)
      .catch((error) => ({ ran: false, reason: String(error?.code ?? error?.message ?? "UNKNOWN") }))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async #tick(reason) {
    // Every path obeys the lifecycle: after `onUnload` no check runs, whether a
    // timer fired late or a caller asked directly.
    if (this.stopped) return { ran: false, reason: "STOPPED" };
    const settings = this.settings ? await this.settings() : null;
    const due = candidateDue(settings ?? {}, this.now());
    this.lastCheck = { at: this.now().toISOString(), reason, due: due.reason, ran: false };
    if (!due.due) return { ran: false, reason: due.reason };
    if (await this.isReadOnly()) return { ran: false, reason: "READ_ONLY" };
    this.lastCheck.ran = true;
    const result = await this.run();
    if (typeof this.log === "function") this.log(`[profile] scheduled run (${reason}): ${result?.written ? "written" : result?.reason}`);
    return { ran: true, result };
  }
}
