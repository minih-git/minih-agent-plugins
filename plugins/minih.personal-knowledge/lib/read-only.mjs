import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The read-only switch (ADR 0001 §3, settings panel §3).
 *
 * `PERSONAL_KNOWLEDGE_READ_ONLY` wins over everything. Otherwise the optional
 * `readOnly` key in repo-map.json decides, and because the panel can flip that
 * key at any time, every real write re-checks it: the file's mtime is compared
 * on each call and the file is re-read when it changed, at most once per
 * second. A process that started before the key existed picks the toggle up
 * without a restart.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function readOnlyFromEnv(env = process.env) {
  return TRUTHY.has(String(env.PERSONAL_KNOWLEDGE_READ_ONLY ?? "").trim().toLowerCase());
}

/** The repo-map path, resolved the same way the plugin resolves it. */
export function repoMapConfigPath({ env = process.env, home = os.homedir() } = {}) {
  return env.PERSONAL_KNOWLEDGE_CONFIG
    ? path.resolve(env.PERSONAL_KNOWLEDGE_CONFIG)
    : path.join(home, ".personal-knowledge", "repo-map.json");
}

export function createReadOnlyState({ env = process.env, home = os.homedir() } = {}) {
  const configPath = repoMapConfigPath({ env, home });
  let cachedMtimeMs = null;
  let cachedValue = false;
  let cachedAtMs = 0;
  return {
    configPath,
    /** True when real writes must be refused. Re-reads the config on mtime change, at most once per second. */
    async isReadOnly(nowMs = Date.now()) {
      if (readOnlyFromEnv(env)) return true;
      let mtimeMs = null;
      try {
        mtimeMs = (await stat(configPath)).mtimeMs;
      } catch {
        cachedMtimeMs = null;
        cachedValue = false;
        return false;
      }
      const stale = mtimeMs !== cachedMtimeMs || nowMs - cachedAtMs >= 1000;
      if (stale) {
        try {
          const parsed = JSON.parse(await readFile(configPath, "utf8"));
          cachedValue = parsed?.readOnly === true;
        } catch {
          cachedValue = false;
        }
        cachedMtimeMs = mtimeMs;
        cachedAtMs = nowMs;
      }
      return cachedValue;
    },
  };
}
