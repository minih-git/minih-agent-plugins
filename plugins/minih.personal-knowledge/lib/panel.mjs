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

  function validate(values) {
    if (values.vaultPath !== undefined && values.vaultPath !== null) {
      if (!path.isAbsolute(values.vaultPath)) {
        throw configError("CONFIG_INVALID", "vaultPath must be an absolute path");
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
      validate(values);
      let existing = null;
      try {
        existing = await readJson(configPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const { raw: template } = await current();
      const merged = { ...template, ...(existing ?? {}) };
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
  const file = dataPath ? path.join(dataPath, "view-prefs.json") : null;
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
