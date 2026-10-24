/**
 * Wikilink extraction shared by the index, `knowledge_links`, and the graph.
 * Body links (`[[target]]`, `[[target#heading]]`, `[[target|alias]]`, embeds)
 * and frontmatter wikilinks all normalize to the same target form.
 */

/** Normalize a link target the way Obsidian compares them: trimmed, forward
 * slashes, `.md` extension stripped. Heading and alias parts are dropped by
 * the extraction regexes; path normalization never sees them. */
export function normalizeLinkTarget(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/\.md$/i, "");
}

const WIKILINK = /!?\[\[([^\][#|]+)(?:#[^\][|]*)?(?:\|[^\][]*)?\]\]/g;

/** Unique body wikilink targets of one note, in first-appearance order. */
export function bodyLinkTargets(content) {
  const targets = [];
  for (const match of String(content ?? "").matchAll(WIKILINK)) {
    const target = normalizeLinkTarget(match[1]);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

/** Walk frontmatter values and collect every `[[...]]` target they carry. */
export function frontmatterLinkTargets(metadata, seen = new Set(), collected = []) {
  if (metadata === null || metadata === undefined) return collected;
  if (typeof metadata === "string") {
    for (const match of metadata.matchAll(WIKILINK)) {
      const target = normalizeLinkTarget(match[1]);
      if (target && !seen.has(target)) {
        seen.add(target);
        collected.push(target);
      }
    }
    return collected;
  }
  if (Array.isArray(metadata)) {
    for (const item of metadata) frontmatterLinkTargets(item, seen, collected);
    return collected;
  }
  if (typeof metadata === "object") {
    for (const value of Object.values(metadata)) frontmatterLinkTargets(value, seen, collected);
  }
  return collected;
}
