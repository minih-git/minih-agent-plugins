"use strict";

/**
 * The translation request: text in, one `agent.complete` payload out.
 *
 * Pure on purpose — no host API, no I/O — so the request shape, the length
 * ceiling and the "nothing to translate" cases are unit tested without a
 * desktop app.
 */

/**
 * Longest text one request carries. The host accepts far more (200k
 * characters), but a selecting reader wants a paragraph or a code block, and a
 * very long paste would hold one interactive translation open for a minute.
 * The renderer stops the selection at the same ceiling, so both ends agree.
 */
const MAX_TEXT_CHARS = 8000;

const SYSTEM_PROMPT = `You are a professional translator. The user's message contains
one text between the markers <<<TEXT and TEXT>>>, and your only job is to
translate that text into Simplified Chinese (简体中文).

Rules:
- Output the translation only. No explanation, no preamble, no quotes around
  it, and never the markers themselves.
- Keep the original Markdown structure: headings, lists, tables, blockquotes,
  emphasis, code fences and inline code stay as they are, in place.
- Never translate code, commands, file paths, URLs, identifiers, environment
  variable names, version numbers, or product and model names. Translate the
  prose around them.
- If the text is already Chinese, return it unchanged.
- Keep line breaks and list nesting exactly as the original has them.
- Use current industry wording for technical terms (prompt → 提示词,
  tool call → 工具调用, and so on).`;

/**
 * Normalize what the renderer sent: CRLF to LF, trimmed, and capped.
 * Returns `{ text }`, or `{ text: "", reason }` when there is nothing to
 * translate, so the caller can answer the renderer instead of calling a model
 * with an empty prompt.
 */
function normalizeText(value) {
  const raw = typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
  const text = raw.trim();
  if (!text) return { text: "", reason: "empty" };
  if (text.length > MAX_TEXT_CHARS) {
    return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
  }
  return { text };
}

/**
 * The `agent.complete` payload for one text. `messages` is a single user turn:
 * the markers let the system prompt name the exact span to translate, so text
 * that happens to look like an instruction is translated rather than obeyed.
 */
function buildTranslateRequest(text) {
  const content = `<<<TEXT\n${text}\nTEXT>>>`;
  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  };
}

module.exports = { MAX_TEXT_CHARS, SYSTEM_PROMPT, buildTranslateRequest, normalizeText };