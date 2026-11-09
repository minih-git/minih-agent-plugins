import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Obsidian's own exclude filter for the conversation transcript (ADR 0002 §4).
 *
 * Obsidian applies `userIgnoreFilters` from `.obsidian/app.json` to search,
 * graph, and quick switcher. The plugin appends `09 Conversations/_raw` — and
 * only that — then leaves every other key byte-for-byte as it was. An existing
 * `.obsidian` folder is a prerequisite: when the vault is not an Obsidian vault
 * yet, nothing is created, because a partial config would fight the app's own.
 */

export const OBSIDIAN_IGNORE_FILTERS = ["09 Conversations/_raw"];

export function obsidianConfigPath(vaultRoot) {
  return path.join(vaultRoot, ".obsidian", "app.json");
}

/**
 * Return `{ changed, added, filters }`. The file is only rewritten when a
 * filter is actually missing, and the write is atomic.
 */
export async function ensureObsidianIgnoreFilters(vaultRoot, ignoreFilters = OBSIDIAN_IGNORE_FILTERS) {
  const configPath = obsidianConfigPath(vaultRoot);
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { changed: false, added: [], filters: null, reason: "NO_OBSIDIAN_CONFIG" };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { changed: false, added: [], filters: null, reason: "INVALID_CONFIG" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { changed: false, added: [], filters: null, reason: "INVALID_CONFIG" };
  }
  const current = Array.isArray(parsed.userIgnoreFilters)
    ? parsed.userIgnoreFilters.map((entry) => String(entry))
    : null;
  const filters = current ?? [];
  const added = ignoreFilters.filter((entry) => !filters.includes(entry));
  if (added.length === 0 && current !== null) {
    return { changed: false, added: [], filters };
  }
  const next = { ...parsed, userIgnoreFilters: [...filters, ...added] };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === raw) return { changed: false, added: [], filters };
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8" });
  await rename(temporary, configPath);
  return { changed: true, added, filters: next.userIgnoreFilters };
}
