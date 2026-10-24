import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Shared test isolation (ADR 0001 §12 hygiene).
 *
 * Every test process must keep its hands off the real `~/.personal-knowledge`:
 * no index directories, no reading the real repo-map, no reading the real
 * embedding settings. Call `isolatedHome()` once at the top of a test file,
 * before any fixture builds a service. It points `HOME` at a fresh temporary
 * directory — `os.homedir()` follows `HOME` on macOS and Linux — and pins the
 * three `PERSONAL_KNOWLEDGE_*` env paths into it, so both the service layer
 * and any spawned child processes land in the sandbox. Individual fixtures may
 * still override the env paths with their own temp directories afterwards.
 */
export async function isolatedHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "pk-test-home-"));
  await mkdir(path.join(home, ".personal-knowledge"), { recursive: true });
  process.env.HOME = home;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = path.join(home, ".personal-knowledge", "index");
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = path.join(home, ".personal-knowledge", "embedding.json");
  process.env.PERSONAL_KNOWLEDGE_CONFIG = path.join(home, ".personal-knowledge", "repo-map.json");
  return home;
}

/** The real home directory, captured before any test overrides `HOME`. */
export const REAL_HOME = os.homedir();
