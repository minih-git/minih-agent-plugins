import { CONVERSATIONS_FOLDER, RAW_FOLDER, localDate, shortId } from "./conversation-layout.mjs";

/**
 * Note bodies for the conversation archive (ADR 0002 §3).
 *
 * Pure string building: the syncer decides *whether* to write, this module
 * decides *what* the note says. Every line that reaches here already passed the
 * host's fragment redactor; the syncer runs `lib/redact.mjs` over the finished
 * text as a second layer before writing.
 */

export const SUMMARY_FOLDER = CONVERSATIONS_FOLDER;
export const TRANSCRIPT_FOLDER = `${CONVERSATIONS_FOLDER}/${RAW_FOLDER}`;

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

function isoDate(epochMs) {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? "1970-01-01" : date.toISOString().slice(0, 10);
}

function clock(epochMs, timezoneOffsetMinutes = null) {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "00:00";
  if (Number.isInteger(timezoneOffsetMinutes)) {
    const shifted = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
    return shifted.toISOString().slice(11, 16);
  }
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

/** Wikilink target for a vault path, without the `.md` extension. */
export function linkTarget(relative) {
  return String(relative ?? "").replace(/\.md$/i, "");
}

/** `[[target|label]]`, keeping the label free of unescaped pipes. */
export function wikilink(relative, label = null) {
  const target = linkTarget(relative);
  const safeLabel = label === null ? null : String(label).replace(/\|/g, "/").replace(/\]\]/g, "]");
  return safeLabel ? `[[${target}|${safeLabel}]]` : `[[${target}]]`;
}

/** A compact, single-line project label for frontmatter and search results. */
export function projectLabel(project) {
  if (!project) return "";
  const name = typeof project.name === "string" ? project.name.trim() : "";
  if (name) return name;
  const remote = typeof project.gitRemote === "string" ? project.gitRemote.trim() : "";
  if (remote) return remote;
  return typeof project.path === "string" ? project.path : "";
}

function bulletList(items, { language = "en" } = {}) {
  const values = (items ?? []).map((item) => String(item ?? "").trim()).filter(Boolean);
  if (values.length === 0) return language === "zh" ? "- （无）" : "- None";
  return values.map((item) => `- ${item.replace(/\r?\n/g, " ")}`).join("\n");
}

const SUMMARY_HEADINGS = {
  zh: {
    goal: "目标",
    decisions: "关键决策",
    outcomes: "结论与产出",
    files: "涉及文件",
    openItems: "未完成事项",
    tags: "标签",
  },
  en: {
    goal: "Goal",
    decisions: "Decisions",
    outcomes: "Outcomes",
    files: "Files",
    openItems: "Open items",
    tags: "Tags",
  },
};

/**
 * Frontmatter of one L2 note. `device` is the single-writer key: only the
 * computer whose name it holds may rewrite or delete the file.
 */
export function summaryFrontmatter({ change, device, transcriptLinks, summaryRevision, coveredSeq }) {
  const lines = [
    "---",
    `title: ${quote(change.title || `Conversation ${shortId(change.sessionId)}`)}`,
    "type: conversation",
    `session_id: ${quote(change.sessionId)}`,
    `session_short: ${quote(shortId(change.sessionId))}`,
    `project: ${quote(projectLabel(change.project))}`,
    `device: ${quote(device)}`,
    `created: ${isoDate(change.createdAt)}`,
    `updated: ${isoDate(change.updatedAt)}`,
    `covered_seq: ${Number.isInteger(coveredSeq) ? coveredSeq : 0}`,
    `summary_revision: ${Number.isInteger(summaryRevision) ? summaryRevision : "null"}`,
    "status: active",
    "review_interval: none",
  ];
  if (transcriptLinks.length === 1) {
    lines.push(`transcript: ${quote(linkTarget(transcriptLinks[0]))}`);
  } else if (transcriptLinks.length > 1) {
    lines.push("transcript:");
    for (const link of transcriptLinks) lines.push(`  - ${quote(linkTarget(link))}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** The L2 body: the fixed six-section structure of plan §3. */
export function summaryBody({ change, summary, transcriptLinks, language = "en" }) {
  const zh = language === "zh";
  const h = SUMMARY_HEADINGS[zh ? "zh" : "en"];
  const goal =
    summary && typeof summary.goal === "string" && summary.goal.trim()
      ? summary.goal.trim()
      : zh
        ? "尚未生成摘要；本次会话的原文已经归档。"
        : "No summary yet; the transcript is archived.";
  const parts = [
    `# ${change.title || `Conversation ${shortId(change.sessionId)}`}`,
    "",
    `## ${h.goal}`,
    "",
    goal,
    "",
    `## ${h.decisions}`,
    "",
    bulletList(summary?.decisions, { language }),
    "",
    `## ${h.outcomes}`,
    "",
    bulletList(summary?.outcomes, { language }),
    "",
    `## ${h.files}`,
    "",
    bulletList(summary?.files, { language }),
    "",
    `## ${h.openItems}`,
    "",
    bulletList(summary?.openItems, { language }),
    "",
    `## ${h.tags}`,
    "",
    bulletList(summary?.tags, { language }),
    "",
  ];
  if (transcriptLinks.length > 0) {
    const links = transcriptLinks.map((link, index) =>
      transcriptLinks.length === 1
        ? wikilink(link, zh ? "原文" : "Transcript")
        : wikilink(link, `Part ${index + 1}`),
    );
    parts.push(`Source: ${links.join(" · ")}`, "");
  }
  return parts.join("\n");
}

function codeSpan(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

/** One tool-call line: `- Bash `git status --short``, with `✗` when it failed. */
export function toolLine(tool) {
  const name = String(tool?.name ?? "tool").trim() || "tool";
  const detail = String(tool?.line ?? "").replace(/\r?\n/g, " ").trim();
  const body = detail.startsWith(name) ? detail.slice(name.length).trim() : detail;
  const rendered = body ? `- ${name} ${codeSpan(body)}` : `- ${name}`;
  return tool?.isError ? `${rendered} ✗` : rendered;
}

/**
 * The turns of one L3 part. The caller slices the turns and assembles the file
 * around this text, so part boundaries never split a turn that carries its
 * heading.
 */
export function rawTurns({ turns, timezoneOffsetMinutes = null, language = "en" }) {
  const zh = language === "zh";
  const lines = [];
  for (const turn of turns) {
    lines.push(
      `## T${`${turn.index}`.padStart(3, "0")} · ${isoDate(turn.startedAt)} ${clock(turn.startedAt, timezoneOffsetMinutes)}`,
      "",
    );
    if (turn.compaction) {
      lines.push(zh ? `> 压缩检查点：${turn.compaction}` : `> Compaction checkpoint: ${turn.compaction}`, "");
    }
    lines.push(
      zh ? "**用户**" : "**User**",
      "",
      String(turn.user ?? "").trim() || (zh ? "（空）" : "(empty)"),
      "",
      zh ? "**Agent**" : "**Assistant**",
      "",
      String(turn.assistant ?? "").trim() || (zh ? "（空）" : "(empty)"),
      "",
    );
    const tools = Array.isArray(turn.tools) ? turn.tools : [];
    if (tools.length > 0) lines.push(...tools.map(toolLine), "");
  }
  return lines.join("\n");
}

export function rawFrontmatter({ change, device, part, partCount }) {
  const title = `${change.title || `Conversation ${shortId(change.sessionId)}`} · ${shortId(change.sessionId)}`;
  return [
    "---",
    `title: ${quote(partCount > 1 ? `${title} (part ${part})` : title)}`,
    "type: conversation-transcript",
    `session_id: ${quote(change.sessionId)}`,
    `device: ${quote(device)}`,
    `created: ${isoDate(change.createdAt)}`,
    `updated: ${isoDate(change.updatedAt)}`,
    `part: ${part}`,
    `parts: ${partCount}`,
    "status: active",
    "review_interval: none",
    "---",
  ].join("\n");
}

/** One row of a daily roll-up page: time, project, title link, goal. */
export function dailyRow({ change, summaryPath }) {
  const time = clock(change.createdAt);
  const project = projectLabel(change.project) || "—";
  const goal = String(change.goal ?? "").replace(/\r?\n/g, " ").trim();
  const label = change.title || `Conversation ${shortId(change.sessionId)}`;
  return `- ${time} · ${project} · ${wikilink(summaryPath, label)}${goal ? ` — ${goal}` : ""}`;
}

/** A whole daily page (rewritten, not appended, on every sync pass). */
export function dailyNote({ day, device, rows, language = "en" }) {
  const zh = language === "zh";
  const sorted = [...rows].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  const frontmatter = [
    "---",
    `title: ${quote(zh ? `${day} 会话记录` : `${day} conversations`)}`,
    "type: conversation-daily",
    `device: ${quote(device)}`,
    "project: \"\"",
    `created: ${day}`,
    `updated: ${day}`,
    "status: active",
    "review_interval: none",
    "---",
  ].join("\n");
  const body = [
    "",
    `# ${zh ? `${day} 会话记录` : `${day} conversations`}`,
    "",
    zh
      ? `> 本页由「${device}」自动生成，只列出这台电脑当天的会话。`
      : `> Generated by ${device}; it lists only that computer's conversations from this day.`,
    "",
    sorted.length > 0 ? sorted.join("\n") : zh ? "- （无）" : "- (none)",
    "",
  ].join("\n");
  return `${frontmatter}${body}`;
}

/** `09 Conversations/<project>/<YYYY-MM>` for a change, used for cleanup. */
export function conversationFolderFor(relative, day = null) {
  const parts = String(relative ?? "").split("/");
  if (parts.length < 3) return null;
  void day;
  return parts.slice(0, 3).join("/");
}

export { isoDate, clock };
