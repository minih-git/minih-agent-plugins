/**
 * Knowledge dashboard derivation (obsidian-independence design §3).
 *
 * The two tables the user already defines in
 * `08 Standards/知识库仪表盘.base` ("活跃项目", "待复核知识") are derived here
 * with the same rules, so the plugin can show them without Obsidian and
 * without writing any file into the vault.
 *
 * The `.base` formulas are the definition; this module mirrors them:
 *
 *   filters: file.ext == "md", not in Templates/, not in 04 Archive/
 *   review_state: if(!verified, "未验证",
 *                    if(stability == "volatile" && verified < today() - "30d",
 *                       "需复核",
 *                       if(stability == "mixed" && verified < today() - "90d",
 *                          "需复核",
 *                          "有效")))
 *
 * `now` is injectable so the day arithmetic is testable; day boundaries are
 * local dates, like Obsidian's `today()`.
 */

/** The two `.base` table names, used by the panel section titles. */
export const DASHBOARD_VIEWS = { activeProjects: "活跃项目", reviewDue: "待复核知识" };


/** Folders the `.base` filter excludes, by name at any depth. */
const EXCLUDED_FOLDERS = new Set(["Templates", "04 Archive"]);

/** The review windows the formula states, in days. */
const REVIEW_WINDOWS = { volatile: 30, mixed: 90 };

export const REVIEW_MISSING = "未验证";
export const REVIEW_DUE = "需复核";
export const REVIEW_VALID = "有效";

function text(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object") return "";
  return String(value).trim();
}

/** `file.ext == "md"`, checked on the vault path rather than on frontmatter. */
function isMarkdown(relativePath) {
  return /\.md$/i.test(relativePath);
}

function inExcludedFolder(relativePath) {
  const folders = relativePath.split("/").slice(0, -1);
  return folders.some((folder) => EXCLUDED_FOLDERS.has(folder));
}

/** A YAML date (`2026-10-01`) or timestamp as a local day, or `null`. */
function localDay(value) {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function nowDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Whole days from `day` to `today`; negative when the date is in the future. */
function daysBetween(day, today) {
  return Math.round((today.getTime() - day.getTime()) / 86_400_000);
}

/**
 * The `.base` `review_state` formula. Missing `verified` wins over everything
 * else; a stability the formula does not mention never counts as due.
 */
export function reviewStateOf(metadata, { now = new Date() } = {}) {
  const verified = localDay(metadata?.verified);
  if (!verified) return REVIEW_MISSING;
  const stability = text(metadata?.stability);
  const window = REVIEW_WINDOWS[stability];
  if (window === undefined) return REVIEW_VALID;
  return daysBetween(verified, nowDay(now)) > window ? REVIEW_DUE : REVIEW_VALID;
}

function titleOf(record) {
  const title = text(record?.metadata?.title);
  if (title) return title;
  const base = String(record?.path ?? "").split("/").pop() ?? "";
  return base.replace(/\.md$/i, "");
}

function byTitle(a, b) {
  return String(a.title).localeCompare(String(b.title), "zh-CN") || String(a.path).localeCompare(String(b.path), "zh-CN");
}

/** 活跃项目: project notes with `status: active`, sorted by title. */
function activeProjects(records) {
  return records
    .filter((record) => text(record.metadata.type) === "project" && text(record.metadata.status) === "active")
    .map((record) => ({
      path: record.path,
      title: titleOf(record),
      status: text(record.metadata.status),
      stability: text(record.metadata.stability) || null,
      verified: text(record.metadata.verified) || null,
    }))
    .sort(byTitle);
}

/** 待复核知识: active, non-template, non-archive notes whose state is not 有效. */
function reviewDue(records, { now }) {
  return records
    .filter((record) => text(record.metadata.status) === "active")
    .map((record) => ({
      path: record.path,
      title: titleOf(record),
      type: text(record.metadata.type) || null,
      project: text(record.metadata.project) || null,
      stability: text(record.metadata.stability) || null,
      verificationScope: text(record.metadata.verification_scope) || null,
      verified: text(record.metadata.verified) || null,
      reviewState: reviewStateOf(record.metadata, { now }),
    }))
    .filter((row) => row.reviewState !== REVIEW_VALID)
    .sort(
      (a, b) =>
        // 需复核 before 未验证, then by title.
        (a.reviewState === REVIEW_DUE ? 0 : 1) - (b.reviewState === REVIEW_DUE ? 0 : 1) || byTitle(a, b),
    );
}

/**
 * Build both tables.
 *
 * @param {{ index: { paths: () => string[], note: (path: string) => object|null } }} input
 * @param {{ now?: Date }} [options]
 * @returns {{ activeProjects: object[], reviewDue: object[] }}
 */
export function buildDashboard({ index }, { now = new Date() } = {}) {
  const records = index
    .paths()
    .filter((relative) => isMarkdown(relative) && !inExcludedFolder(relative))
    .map((relative) => index.note(relative))
    .filter(Boolean);
  return {
    activeProjects: activeProjects(records),
    reviewDue: reviewDue(records, { now }),
  };
}
