import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Storage behind the settings panel (settings-panel.md §2–§4).
 *
 * The panel only edits the files other clients already read: repo-map.json
 * (or the file PERSONAL_KNOWLEDGE_CONFIG names) for knowledge settings and
 * view-prefs.json in the plugin data path for the interface language.
 * Environment variables win over repo-map values; the panel locks those
 * fields instead of letting an edit silently fail to apply.
 */

const EDITABLE_KEYS = ["vaultPath", "ignoreFolders", "backupRetentionDays", "readOnly"];
const LANGUAGES = new Set(["auto", "zh-CN", "en"]);

export function lockedConfigKeys(env = process.env) {
  const locked = {};
  if (String(env.PERSONAL_KNOWLEDGE_VAULT ?? "").trim()) {
    locked.vaultPath = "PERSONAL_KNOWLEDGE_VAULT";
  }
  if (String(env.PERSONAL_KNOWLEDGE_READ_ONLY ?? "").trim()) {
    locked.readOnly = "PERSONAL_KNOWLEDGE_READ_ONLY";
  }
  return locked;
}

function configError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function createConfigStore({ env = process.env, home = os.homedir(), pluginRoot } = {}) {
  const configPath = env.PERSONAL_KNOWLEDGE_CONFIG
    ? path.resolve(env.PERSONAL_KNOWLEDGE_CONFIG)
    : path.join(home, ".personal-knowledge", "repo-map.json");
  const templatePath = path.join(pluginRoot, "config", "repo-map.json");
  const backupsDir = path.join(home, ".personal-knowledge", "backups");

  async function readJson(file) {
    return JSON.parse(await readFile(file, "utf8"));
  }

  /** The user file when it exists, otherwise the bundled template. */
  async function current() {
    try {
      return { source: "user", raw: await readJson(configPath) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { source: "template", raw: await readJson(templatePath) };
    }
  }

  async function validate(values) {
    if (values.vaultPath !== undefined && values.vaultPath !== null) {
      if (!path.isAbsolute(values.vaultPath)) {
        throw configError("CONFIG_INVALID", "vaultPath must be an absolute path");
      }
      // settings-panel.md §4: the vault must already be a directory on disk,
      // so a typo cannot point the whole plugin at nothing.
      let vaultStat;
      try {
        vaultStat = await stat(values.vaultPath);
      } catch {
        throw configError("CONFIG_INVALID", `vaultPath does not exist: ${values.vaultPath}`);
      }
      if (!vaultStat.isDirectory()) {
        throw configError("CONFIG_INVALID", `vaultPath is not a directory: ${values.vaultPath}`);
      }
    }
    if (values.backupRetentionDays !== undefined && values.backupRetentionDays !== null) {
      const days = values.backupRetentionDays;
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw configError("CONFIG_INVALID", "backupRetentionDays must be an integer from 1 to 3650");
      }
    }
    if (values.ignoreFolders !== undefined && values.ignoreFolders !== null) {
      if (!Array.isArray(values.ignoreFolders)) {
        throw configError("CONFIG_INVALID", "ignoreFolders must be an array of folder names");
      }
      for (const folder of values.ignoreFolders) {
        if (typeof folder !== "string" || !folder.trim() || path.isAbsolute(folder) || folder.split(/[\\/]/).includes("..")) {
          throw configError("CONFIG_INVALID", `ignoreFolders entries must be relative folder names: ${String(folder)}`);
        }
      }
    }
    if (values.readOnly !== undefined && typeof values.readOnly !== "boolean") {
      throw configError("CONFIG_INVALID", "readOnly must be a boolean");
    }
  }

  return {
    configPath,
    async get({ notesCount = null } = {}) {
      const { source, raw } = await current();
      const values = {
        vaultPath: raw.vaultPath ?? null,
        ignoreFolders: Array.isArray(raw.ignoreFolders) ? raw.ignoreFolders : [],
        backupRetentionDays: raw.backupRetentionDays ?? null,
        readOnly: raw.readOnly === true,
      };
      let vault = { exists: false, notes: null };
      if (values.vaultPath) {
        try {
          const info = await stat(values.vaultPath);
          vault = { exists: info.isDirectory(), notes: info.isDirectory() && notesCount !== null ? notesCount : null };
        } catch {
          vault = { exists: false, notes: null };
        }
      }
      return {
        path: configPath,
        source,
        values,
        locked: lockedConfigKeys(env),
        vault,
        reloadRequired: ["vaultPath", "ignoreFolders"],
      };
    },
    async set(values) {
      const locked = lockedConfigKeys(env);
      for (const key of EDITABLE_KEYS) {
        if (locked[key] && values[key] !== undefined && values[key] !== null && values[key] !== rawLockedValue(env, key)) {
          throw configError("CONFIG_LOCKED", `${key} is locked by the environment variable ${locked[key]}`);
        }
      }
      await validate(values);
      let existing = null;
      try {
        existing = await readJson(configPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      // The user file is the base as-is: keys the user dropped must not come
      // back on the next save. The bundled template only seeds the very first
      // save, without its $comment annotation (settings-panel.md §4).
      let merged;
      if (existing) {
        merged = { ...existing };
      } else {
        merged = { ...(await current()).raw };
        delete merged.$comment;
      }
      for (const key of EDITABLE_KEYS) {
        const value = values[key];
        if (value === undefined) continue;
        if (value === null || value === false || (Array.isArray(value) && value.length === 0)) {
          if (key === "readOnly") {
            merged.readOnly = false;
            continue;
          }
          delete merged[key];
          continue;
        }
        merged[key] = value;
      }
      if (existing) {
        await mkdir(backupsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await copyFile(configPath, path.join(backupsDir, `repo-map-${stamp}.json`));
      }
      await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      const temporary = `${configPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`);
      await rename(temporary, configPath);
      return { saved: true, reloadRequired: ["vaultPath", "ignoreFolders"] };
    },
    /** Routing sections for the panel, read-only (settings-panel.md §2). */
    async routing({ noteExists }) {
      const { raw } = await current();
      const noteEntries = (notes) =>
        (Array.isArray(notes) ? notes : []).map((note) => ({ path: String(note), exists: Boolean(noteExists?.(String(note))) }));
      return {
        projects: (Array.isArray(raw.projects) ? raw.projects : []).map((project) => ({
          name: project.name ?? null,
          repoPrefixes: Array.isArray(project.repoPrefixes) ? project.repoPrefixes : [],
          aliases: Array.isArray(project.aliases) ? project.aliases : [],
          notes: noteEntries(project.notes),
        })),
        topicRoutes: (Array.isArray(raw.topicRoutes) ? raw.topicRoutes : []).map((route) => ({
          name: route.name ?? null,
          aliases: Array.isArray(route.aliases) ? route.aliases : [],
          notes: noteEntries(route.notes),
        })),
        defaultNotes: noteEntries(raw.defaultNotes),
      };
    },
  };
}

function rawLockedValue(env, key) {
  if (key === "vaultPath") return String(env.PERSONAL_KNOWLEDGE_VAULT ?? "").trim();
  if (key === "readOnly") return ["1", "true", "yes", "on"].includes(String(env.PERSONAL_KNOWLEDGE_READ_ONLY ?? "").trim().toLowerCase());
  return undefined;
}

export function createPrefsStore({ dataPath } = {}) {
  // The host hands the data path over as a promise; a caller that forgets to
  // await it must not reach `path.join`. Anything that is not a non-empty
  // string means "no data path in this host", and the store reports itself
  // unavailable instead of throwing on every panel open.
  const usable = typeof dataPath === "string" && dataPath.trim() !== "";
  const file = usable ? path.join(dataPath, "view-prefs.json") : null;
  return {
    async get() {
      if (!file) return { language: "auto", available: false };
      try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        const language = LANGUAGES.has(parsed?.language) ? parsed.language : "auto";
        return { language, available: true };
      } catch {
        return { language: "auto", available: true };
      }
    },
    async set(language) {
      if (!LANGUAGES.has(language)) {
        throw configError("CONFIG_INVALID", 'language must be "auto", "zh-CN", or "en"');
      }
      if (!file) throw configError("CONFIG_INVALID", "the plugin data path is unavailable in this host");
      await mkdir(dataPath, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ language }, null, 2)}\n`);
      await rename(temporary, file);
      return { saved: true, language };
    },
  };
}

/**
 * Settings of the two archived-conversation features (settings-panel.md §2,
 * ADR 0002 §8). They live next to the sync state in `~/.personal-knowledge/`,
 * never in the vault: which computer archives and under what name is per
 * computer, and the profile candidate switch is the user's opt-in on this one.
 *
 *   conversation-settings.json  { deviceName }
 *   profile-candidates.json     { enabled, modelKey, lastRunAt, lastError, lastCandidate }
 */
export function createConversationSettingsStore({ home = os.homedir(), env = process.env } = {}) {
  const file = env.PERSONAL_KNOWLEDGE_CONVERSATION_SETTINGS
    ? path.resolve(env.PERSONAL_KNOWLEDGE_CONVERSATION_SETTINGS)
    : path.join(home, ".personal-knowledge", "conversation-settings.json");

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async function write(values) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }

  return {
    file,
    async get() {
      const raw = await read();
      return { deviceName: typeof raw.deviceName === "string" ? raw.deviceName : null };
    },
    /** A device name must survive being a folder name, so it is sanitized. */
    async setDeviceName(value) {
      const cleaned = String(value ?? "")
        .replace(/\.local$/i, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!cleaned) {
        throw configError("CONFIG_INVALID", "deviceName must contain at least one letter or digit");
      }
      if (cleaned.length > 64) {
        throw configError("CONFIG_INVALID", "deviceName must be at most 64 characters");
      }
      const next = { ...(await read()), deviceName: cleaned };
      await write(next);
      return { saved: true, deviceName: cleaned };
    },
  };
}
