import { createHash } from "node:crypto";

/**
 * Heading sections and chunks (ADR 0001 §2 and §8).
 *
 * Sections run by H1–H3 headings: a section starts at its heading line and ends
 * at the line before the next heading of the same or a higher level. Chunks are
 * sections split at paragraph boundaries into pieces of at most 2,000
 * characters; they record offsets and a text SHA-256 but never persist text.
 */

const HEADING = /^(#{1,3})\s+(.*?)\s*$/;

/** Split text into lines, keeping each line's terminator on it. */
export function splitLinesKeepingEnds(text) {
  const lines = [];
  let index = 0;
  while (index < text.length) {
    const newline = text.indexOf("\n", index);
    if (newline === -1) {
      lines.push(text.slice(index));
      break;
    }
    lines.push(text.slice(index, newline + 1));
    index = newline + 1;
  }
  return lines;
}

function headingText(line) {
  const match = HEADING.exec(line.replace(/\r?\n$/, ""));
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

/** Flat heading outline: `{ level, text, line }` with 0-based line numbers. */
export function headingOutline(content) {
  const outline = [];
  const lines = splitLinesKeepingEnds(content);
  for (let i = 0; i < lines.length; i += 1) {
    const heading = headingText(lines[i]);
    if (heading) outline.push({ level: heading.level, text: heading.text, line: i });
  }
  return outline;
}

function headingPathAt(outline, line) {
  const trail = [];
  for (const entry of outline) {
    if (entry.line >= line) break;
    while (trail.length > 0 && trail[trail.length - 1].level >= entry.level) trail.pop();
    trail.push(entry);
  }
  return trail.map((entry) => entry.text);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Split one span of text at paragraph boundaries into ≤ maxChars pieces. */
function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const pieces = [];
  let current = "";
  const pushCurrent = () => {
    if (current !== "") pieces.push(current);
    current = "";
  };
  for (const paragraph of paragraphs) {
    const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    // A single paragraph above the cap is hard-split at the boundary.
    for (let i = 0; i < paragraph.length; i += maxChars) {
      pieces.push(paragraph.slice(i, i + maxChars));
    }
  }
  pushCurrent();
  return pieces;
}

/**
 * Chunk a note body by H1–H3 headings. The preamble before the first heading
 * becomes a chunk with an empty heading path. Returns
 * `{ headingPath, level, start, end, sha }` with character offsets into the
 * whole content.
 */
export function chunkNote(content, maxChars = 2000) {
  const outline = headingOutline(content);
  const lines = splitLinesKeepingEnds(content);
  const boundaries = [];
  if (outline.length === 0 || outline[0].line > 0) {
    boundaries.push({ level: 0, text: "", line: 0 });
  }
  for (const entry of outline) boundaries.push(entry);

  const chunks = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const boundary = boundaries[i];
    const startLine = boundary.line;
    const endLine = i + 1 < boundaries.length ? boundaries[i + 1].line : lines.length;
    const sectionText = lines.slice(startLine, endLine).join("");
    const headingPath = boundary.level === 0 ? [] : headingPathAt(outline, startLine).concat(boundary.text);
    const offset = lines.slice(0, startLine).reduce((sum, line) => sum + line.length, 0);
    const pieces = splitLongText(sectionText, maxChars);
    let cursor = offset;
    for (const piece of pieces) {
      if (piece.trim() === "") {
        cursor += piece.length;
        continue;
      }
      chunks.push({
        headingPath,
        level: boundary.level,
        start: cursor,
        end: cursor + piece.length,
        sha: sha256(piece),
      });
      cursor += piece.length;
    }
  }
  return chunks;
}

/**
 * Locate a section by heading text or by an `H2 > H3` heading path.
 * Returns `{ ok: true, startLine, endLine }` where the heading line is
 * `startLine` and `endLine` is the line before the next heading of the same or
 * a higher level (content ends included). Failures carry `code` and
 * `candidates` for SECTION_NOT_FOUND / SECTION_AMBIGUOUS errors.
 */
export function locateSection(content, spec) {
  const wanted = String(spec ?? "").trim();
  if (!wanted) return { ok: false, code: "SECTION_NOT_FOUND", candidates: [] };
  const outline = headingOutline(content);
  const pathParts = wanted.includes(">")
    ? wanted.split(">").map((part) => part.trim()).filter(Boolean)
    : null;

  let matches = [];
  if (pathParts && pathParts.length > 0) {
    let anchors = outline.filter((entry) => entry.text === pathParts[0]);
    for (let depth = 1; depth < pathParts.length; depth += 1) {
      const next = [];
      for (const anchor of anchors) {
        for (const entry of outline) {
          if (entry.line <= anchor.line) continue;
          if (entry.level <= anchor.level) break;
          if (entry.level > anchor.level + 1) continue;
          if (entry.text === pathParts[depth]) next.push(entry);
        }
      }
      anchors = next;
    }
    matches = anchors;
  } else {
    matches = outline.filter((entry) => entry.text === wanted);
  }

  if (matches.length === 0) {
    return {
      ok: false,
      code: "SECTION_NOT_FOUND",
      candidates: outline.map((entry) => ({ level: entry.level, text: entry.text })),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "SECTION_AMBIGUOUS",
      candidates: matches.map((entry) => ({
        level: entry.level,
        text: headingPathAt(outline, entry.line).concat(entry.text).join(" > "),
      })),
    };
  }

  const match = matches[0];
  const lines = splitLinesKeepingEnds(content);
  let endLine = lines.length;
  for (const entry of outline) {
    if (entry.line <= match.line) continue;
    if (entry.level <= match.level) {
      endLine = entry.line;
      break;
    }
  }
  return { ok: true, startLine: match.line, endLine };
}

/** Replace the span `[startLine, endLine)` with `replacement` (heading included). */
export function replaceSectionSpan(content, startLine, endLine, replacement) {
  const lines = splitLinesKeepingEnds(content);
  const normalized = replacement.endsWith("\n") ? replacement : `${replacement}\n`;
  return lines.slice(0, startLine).concat(normalized, lines.slice(endLine)).join("");
}

/** Append `extra` at the end of the span, separated by one blank line when the
 * section already has body content. */
export function appendToSectionSpan(content, startLine, endLine, extra) {
  const lines = splitLinesKeepingEnds(content);
  const addition = extra.endsWith("\n") ? extra : `${extra}\n`;
  let insertAt = endLine;
  // Walk back over the section's trailing blank lines; body text ends there.
  let bodyEnd = endLine;
  while (bodyEnd - 1 > startLine && lines[bodyEnd - 1].trim() === "") bodyEnd -= 1;
  const hasBody = bodyEnd - 1 > startLine;
  const separator = hasBody && addition.trim() !== "" ? "\n" : "";
  const head = lines.slice(0, bodyEnd);
  const tail = lines.slice(bodyEnd, insertAt);
  return head.concat([separator, addition], tail).join("");
}
