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
  now = new Date(),
  home = os.homedir(),
  env = process.env,
  log = null,
} = {}) {
  const state = settings ?? (await readProfileSettings(profileSettingsPath({ home, env })));
  const due = candidateDue(state, now);
  if (!due.due) return { written: false, reason: due.reason, nextEligibleAt: due.nextEligibleAt ?? null };
  const complete = pi?.agent?.complete;
  if (typeof complete !== "function") return { written: false, reason: "AGENT_COMPLETE_UNAVAILABLE" };

  const sessions = (await recentSessions(service)).slice(0, MAX_SESSIONS);
  const memoryEntries = await collectUserMemory(pi);
  if (sessions.length === 0 && memoryEntries.length === 0) {
    return { written: false, reason: "NO_MATERIAL" };
  }

  const day = now.toISOString().slice(0, 10);
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
    await writeProfileSettings(profileSettingsPath({ home, env }), { ...state, lastRunAt: now.toISOString(), lastError: String(error?.code ?? error?.message ?? "UNKNOWN") });
    return { written: false, reason: "MODEL_FAILED" };
  }
  if (!text) {
    await writeProfileSettings(profileSettingsPath({ home, env }), { ...state, lastRunAt: now.toISOString(), lastError: "EMPTY" });
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
    lastRunAt: now.toISOString(),
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
