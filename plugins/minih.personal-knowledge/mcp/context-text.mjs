/**
 * Block formats for the `navigate` context pack (ADR 0004 §5).
 *
 * Apart from `tool-text.mjs` so `context()` can measure one block exactly
 * (`renderContextNote`, `renderContextSection`) before deciding the budget
 * still holds it, while the renderer stays the one place that composes the
 * text the model reads. Nothing here imports the retrieval code.
 */

/**
 * What the pack keeps free for the parts that are not notes or sections: the
 * matched-project lines, the mode line (whose token count is only known after
 * rendering), the conversations block, the section headings, and the footer.
 */
export const CONTEXT_PACK_ALLOWANCE = 1_200;

/** Free space kept for a default note's `Head (first N characters):` line. */
export const CONTEXT_HEAD_LABEL_CHARS = 60;

export const CONTEXT_NEXT_STEP =
  "Next: knowledge_read {note, section} reads any other heading; knowledge_search {scope} searches beyond these notes.";

/** One note: title, provenance, L0 abstract, L1 outline, default head excerpt. */
export function renderContextNote(note) {
  const lines = [
    `### ${note.title}`,
    `Path: ${note.path} · Type: ${note.type ?? "unknown"} · Status: ${note.status ?? "none"} · Updated: ${note.updated ?? "—"} · Verified: ${note.verified ?? "unverified"}${
      note.reviewInterval ? ` (${note.reviewInterval})` : ""
    }`,
    `SHA-256: ${note.sha256}`,
    `Abstract (${note.abstractSource}): ${note.abstract || "—"}`,
  ];
  if (note.outline.length > 0) {
    lines.push("Outline:");
    for (const entry of note.outline) {
      const indent = "  ".repeat(Math.max(0, entry.level - 2));
      const date = entry.date ? `, ${entry.date}` : "";
      lines.push(`${indent}- ${"#".repeat(entry.level)} ${entry.text} (${entry.chars} chars${date})`);
    }
    if (note.outlineTruncated) lines.push(`[outline truncated at ${note.outline.length} headings]`);
  }
  if (note.head) {
    lines.push(
      `Head (first ${note.head.chars} characters${note.head.truncated ? ", truncated" : ""}):`,
      note.head.content,
    );
  }
  return lines.join("\n");
}

/** One L2 section: heading path, provenance, and the redacted excerpt. */
export function renderContextSection(section) {
  const headingPath = section.headingPath.join(" > ") || "(preamble)";
  return [
    `### ${section.title} › ${headingPath}   score=${section.score.toFixed(4)} · ${section.matchedBy.join(", ")}`,
    `Path: ${section.path} · Lines ${section.startLine}–${section.endLine} · Section SHA-256: ${section.sectionSha256}`,
    section.content,
  ].join("\n");
}
/** `Vector:` field of the mode line (ADR 0004 §5). */
export function vectorLabel(retrieval) {
  if (!retrieval) return "unknown";
  // A pack with no topic, or no routed note, never asks the channel anything.
  if (retrieval.attempted === false) return "not attempted";
  if (retrieval.vector === "disabled") return "disabled";
  if (retrieval.vector === "partial") return `partial (${retrieval.pendingChunks ?? 0} pending)`;
  if (retrieval.vector === "unavailable") return `unavailable (${retrieval.reason ?? "unknown"})`;
  return "ready";
}