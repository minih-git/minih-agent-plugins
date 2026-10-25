/**
 * Personal Knowledge settings panel logic (settings-panel.md §1–§7).
 *
 * Manages the seven sections in a single host panel:
 * 1. Vault (`kg.config.get` / `kg.config.set`)
 * 2. Vector retrieval (`kg.settings.get` / `kg.settings.set` / `kg.settings.test`)
 * 3. Index (`kg.index.status` / `kg.index.rebuild` with 1s polling while running)
 * 4. Display (`kg.prefs.get` / `kg.prefs.set`)
 * 5. Ontology health (`kg.graph` issues + severity filter + Obsidian link copy)
 * 6. Project routing (`kg.routing.get`, read-only with missing-note flags)
 * 7. Memory (`kg.memory.status`, read-only)
 */

import { invokeBridge, hasBridge } from "./bridge.js";
import {
  STRINGS,
  BRIDGE_TIMEOUT_MS,
  classifyIssueCode,
  nodeSeverity,
} from "./strings.js";
import { EMBEDDING_DEFAULTS as DEFAULT_EMBEDDING_SETTINGS } from "./vendor/embedding-defaults.mjs";
import { FIXTURE_GRAPH } from "./fixture.js";

const LEGACY_LANGUAGE_STORAGE_KEY = "kg-universe:lang";
const INDEX_POLL_INTERVAL_MS = 1000;

const $ = (id) => document.getElementById(id);

function parseCommaList(rawText) {
  return String(rawText || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function vaultBasename(vaultPath, fallback = "Knowledge") {
  const cleaned = String(vaultPath ?? "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) return fallback;
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fallback;
}

export function buildObsidianLink(vaultName, filePath) {
  const vault = vaultName || "Knowledge";
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(filePath)}`;
}

function normalizeEmbeddingConfig(raw) {
  const src = raw || DEFAULT_EMBEDDING_SETTINGS;
  return {
    enabled: Boolean(src.enabled),
    provider: src.provider === "openai-compatible" ? "openai-compatible" : "ollama",
    baseUrl: String(src.baseUrl ?? DEFAULT_EMBEDDING_SETTINGS.baseUrl).trim(),
    model: String(src.model ?? DEFAULT_EMBEDDING_SETTINGS.model).trim(),
    allowRemote: Boolean(src.allowRemote),
    apiKeyEnv: String(src.apiKeyEnv ?? "").trim(),
    exclude: Array.isArray(src.exclude)
      ? src.exclude.map((item) => String(item).trim()).filter((item) => item.length > 0)
      : [],
  };
}

function areEmbeddingConfigsEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.allowRemote === b.allowRemote &&
    a.apiKeyEnv === b.apiKeyEnv &&
    a.exclude.length === b.exclude.length &&
    a.exclude.every((item, i) => item === b.exclude[i])
  );
}

const DEMO_ROUTING = {
  projects: [
    {
      name: "Alpha (核心网关系统)",
      repoPrefixes: ["/Users/demo/Projects/alpha-gateway"],
      aliases: ["alpha", "gateway"],
      notes: [
        { path: "01 Projects/Project - Alpha/Project - Alpha.md", exists: true },
        { path: "01 Projects/Project - Alpha/Alpha - 系统架构.md", exists: true },
      ],
    },
    {
      name: "Delta (知识图谱引擎)",
      repoPrefixes: ["/Users/demo/Projects/delta-graph"],
      aliases: ["delta", "kg"],
      notes: [
        { path: "01 Projects/Project - Delta/Project - Delta.md", exists: true },
        { path: "01 Projects/Project - Delta/Missing - 历史归档说明.md", exists: false },
      ],
    },
  ],
  topicRoutes: [
    {
      name: "基础设施与安全规范",
      aliases: ["infra", "security", "tls"],
      notes: [
        { path: "08 Standards/知识库规范.md", exists: true },
        { path: "08 Standards/Ghost - 缺失的认证模块.md", exists: false },
      ],
    },
  ],
  defaultNotes: [
    { path: "08 Standards/知识本体.md", exists: true },
    { path: "08 Standards/知识库规范.md", exists: true },
  ],
};

export class RetrievalSettingsPanel {
  constructor({ t, showToast, onSaved }) {
    this.t = t;
    this.showToast = showToast;
    this.onSaved = onSaved;
    this.panel = $("sec-retrieval");
    this.bridgeAvailable = false;
    this.busy = false;
    this.confirmingRemote = false;
    this.savedSettings = null;
    this.baselineSnapshot = null;
    this.apiKeyStatus = "not-required";
    this.index = null;
    this.estimate = null;
    this.bind();
  }

  bind() {
    $("btn-settings-test")?.addEventListener("click", () => this.test());
    $("btn-settings-save")?.addEventListener("click", () => this.save());
    $("btn-settings-confirm")?.addEventListener("click", () => this.save());
    const dirty = () => {
      this.confirmingRemote = false;
      this.renderDynamic();
    };
    for (const id of [
      "settings-enabled",
      "settings-provider",
      "settings-baseurl",
      "settings-model",
      "settings-apikey-env",
      "settings-exclude",
      "settings-allow-remote",
    ]) {
      const el = $(id);
      el?.addEventListener("input", dirty);
      el?.addEventListener("change", dirty);
    }
  }

  formValues() {
    return {
      enabled: Boolean($("settings-enabled").checked),
      provider:
        $("settings-provider").value === "openai-compatible"
          ? "openai-compatible"
          : "ollama",
      baseUrl: $("settings-baseurl").value.trim(),
      model: $("settings-model").value.trim(),
      allowRemote: Boolean($("settings-allow-remote").checked),
      apiKeyEnv: $("settings-apikey-env").value.trim(),
      exclude: parseCommaList($("settings-exclude").value),
    };
  }

  writeForm(config) {
    const norm = normalizeEmbeddingConfig(config);
    $("settings-enabled").checked = norm.enabled;
    $("settings-provider").value = norm.provider;
    $("settings-baseurl").value = norm.baseUrl;
    $("settings-model").value = norm.model;
    $("settings-allow-remote").checked = norm.allowRemote;
    $("settings-apikey-env").value = norm.apiKeyEnv;
    $("settings-exclude").value = norm.exclude.join(", ");
  }

  setControlsDisabled(disabled) {
    for (const id of [
      "settings-enabled",
      "settings-provider",
      "settings-baseurl",
      "settings-model",
      "settings-apikey-env",
      "settings-exclude",
      "settings-allow-remote",
      "btn-settings-test",
      "btn-settings-save",
      "btn-settings-confirm",
    ]) {
      const el = $(id);
      if (el) el.disabled = disabled;
    }
  }

  feedback(message, isError) {
    const box = $("settings-feedback");
    if (!box) return;
    box.textContent = message;
    box.classList.toggle("is-hidden", !message);
    box.classList.toggle("is-error", Boolean(isError));
    box.classList.toggle("is-ok", !isError && Boolean(message));
  }

  async load(populateForm = true) {
    this.bridgeAvailable = hasBridge();
    $("settings-fixture-notice")?.classList.add("is-hidden");
    if (!this.bridgeAvailable) {
      this.savedSettings = null;
      this.baselineSnapshot = normalizeEmbeddingConfig(DEFAULT_EMBEDDING_SETTINGS);
      this.apiKeyStatus = "not-required";
      this.index = null;
      this.estimate = null;
      this.confirmingRemote = false;
      if (populateForm) this.writeForm(DEFAULT_EMBEDDING_SETTINGS);
      this.feedback("", false);
      this.setControlsDisabled(true);
      this.renderDynamic();
      return;
    }
    this.setControlsDisabled(true);
    try {
      const res = await invokeBridge("kg.settings.get", {}, BRIDGE_TIMEOUT_MS);
      this.savedSettings = res?.settings ? normalizeEmbeddingConfig(res.settings) : null;
      this.baselineSnapshot = normalizeEmbeddingConfig(res?.settings || DEFAULT_EMBEDDING_SETTINGS);
      this.apiKeyStatus = res?.apiKeyStatus || "not-required";
      this.index = res?.index || null;
      this.estimate = res?.estimate || null;
      this.confirmingRemote = false;
      if (populateForm) this.writeForm(this.baselineSnapshot);
      if (res?.settingsError) {
        const code = res.settingsError.code || "";
        const msg = res.settingsError.message || "";
        this.feedback(msg ? (code && !msg.startsWith(code) ? `${code} ${msg}` : msg) : code, true);
      } else {
        this.feedback("", false);
      }
    } catch (error) {
      this.feedback(error?.message || String(error), true);
    } finally {
      this.setControlsDisabled(false);
      this.renderDynamic();
    }
  }

  renderDynamic() {
    const values = this.formValues();
    const remoteWarn = $("settings-remote-warning");
    remoteWarn.textContent = this.t("settingsRemoteWarning");
    remoteWarn.classList.toggle("is-hidden", !values.allowRemote);

    const isDirty =
      this.bridgeAvailable &&
      this.baselineSnapshot !== null &&
      !areEmbeddingConfigsEqual(values, this.baselineSnapshot);
    $("settings-unsaved-pill").classList.toggle("is-hidden", !isDirty);
    $("settings-estimate-dirty-dot").classList.toggle("is-hidden", !isDirty);

    const keyBadge = $("settings-key-status");
    keyBadge.className = `key-status-badge status-${this.apiKeyStatus}`;
    keyBadge.textContent = this.t(
      this.apiKeyStatus === "found"
        ? "settingsKeyFound"
        : this.apiKeyStatus === "missing"
          ? "settingsKeyMissing"
          : "settingsKeyNotRequired",
    );

    const indexEl = $("settings-index-stats");
    indexEl.textContent = this.index
      ? this.t("settingsIndexFormat", {
          identity: this.index.identity || "—",
          dims: this.index.dims ?? "—",
          chunks: this.index.chunks ?? 0,
          builtAt: this.index.builtAt || "—",
        })
      : this.t("settingsIndexNotBuilt");

    const estEl = $("settings-estimate-value");
    estEl.textContent = this.estimate
      ? this.t("settingsEstimateFormat", {
          chunks: this.estimate.chunks ?? 0,
          characters: this.estimate.characters ?? 0,
        })
      : "—";

    const confirmBtn = $("btn-settings-confirm");
    const savedRemote = Boolean(this.savedSettings?.allowRemote);
    if (!values.allowRemote || savedRemote) this.confirmingRemote = false;
    $("label-settings-confirm").textContent = this.t("settingsConfirmSendBtn", {
      chunks: this.estimate?.chunks ?? 0,
      characters: this.estimate?.characters ?? 0,
    });
    confirmBtn.classList.toggle("is-hidden", !this.confirmingRemote);
  }

  applyTranslations() {
    const t = this.t;
    $("settings-heading").textContent = t("settingsHeading");
    $("settings-unsaved-label").textContent = t("settingsUnsaved");
    $("settings-fixture-notice").textContent = t("settingsFixtureNotice");
    $("label-settings-enabled").textContent = t("settingsEnabledLabel");
    $("label-settings-provider").textContent = t("settingsProviderLabel");
    $("opt-provider-ollama").textContent = t("settingsProviderOllama");
    $("opt-provider-openai").textContent = t("settingsProviderOpenai");
    $("label-settings-baseurl").textContent = t("settingsBaseUrlLabel");
    $("settings-baseurl").placeholder = t("settingsBaseUrlPlaceholder");
    $("hint-settings-baseurl").textContent = t("settingsBaseUrlHint");
    $("label-settings-model").textContent = t("settingsModelLabel");
    $("settings-model").placeholder = t("settingsModelPlaceholder");
    $("label-settings-apikey-env").textContent = t("settingsApiKeyEnvLabel");
    $("settings-apikey-env").placeholder = t("settingsApiKeyEnvPlaceholder");
    $("hint-settings-apikey-env").textContent = t("settingsApiKeyEnvHint");
    $("label-settings-exclude").textContent = t("settingsExcludeLabel");
    $("settings-exclude").placeholder = t("settingsExcludePlaceholder");
    $("hint-settings-exclude").textContent = t("settingsExcludeHint");
    $("label-settings-allow-remote").textContent = t("settingsAllowRemoteLabel");
    $("label-settings-key-status").textContent = t("settingsKeyStatusLabel");
    $("label-settings-index").textContent = t("settingsIndexLabel");
    $("label-settings-estimate").textContent = t("settingsEstimateLabel");
    $("label-settings-test").textContent = t("settingsTestBtn");
    $("label-settings-save").textContent = t("settingsSaveBtn");
    this.renderDynamic();
  }

  async save() {
    if (!this.bridgeAvailable || this.busy) return;
    const values = this.formValues();
    const savedRemote = Boolean(this.savedSettings?.allowRemote);
    if (values.allowRemote && !savedRemote && !this.confirmingRemote) {
      this.confirmingRemote = true;
      this.renderDynamic();
      $("btn-settings-confirm")?.focus();
      return;
    }
    this.busy = true;
    this.setControlsDisabled(true);
    try {
      await invokeBridge("kg.settings.set", { embedding: values }, BRIDGE_TIMEOUT_MS);
      this.confirmingRemote = false;
      this.showToast(this.t("toastSettingsSaved"));
      await this.load(true);
      await this.onSaved?.();
    } catch (error) {
      this.confirmingRemote = false;
      this.feedback(error?.message || String(error), true);
    } finally {
      this.busy = false;
      this.setControlsDisabled(false);
      this.renderDynamic();
    }
  }

  async test() {
    if (!this.bridgeAvailable || this.busy) return;
    const values = this.formValues();
    this.busy = true;
    this.setControlsDisabled(true);
    try {
      const res = await invokeBridge("kg.settings.test", { embedding: values }, BRIDGE_TIMEOUT_MS);
      if (res?.ok) {
        this.feedback(this.t("settingsTestOk", { dims: res.dims ?? "—", latencyMs: res.latencyMs ?? "—" }), false);
      } else {
        const reason = res?.reason ? String(res.reason) : "";
        const msg = res?.message ? String(res.message) : "";
        this.feedback(
          msg ? (reason && !msg.startsWith(reason) ? `${reason} ${msg}` : msg) : reason || "Test failed",
          true,
        );
      }
    } catch (error) {
      this.feedback(error?.message || String(error), true);
    } finally {
      this.busy = false;
      this.setControlsDisabled(false);
      this.renderDynamic();
    }
  }
}

// ---- Settings Page State & Controller ----

const state = {
  lang: "zh-CN",
  langPref: "auto",
  bridgeAvailable: false,
  vaultName: "Knowledge",
  vaultConfig: null,
  vaultBusy: false,
  indexStatus: null,
  indexBusy: false,
  indexPollTimer: null,
  hasIndexRunInSession: false,
  graphPayload: null,
  healthSeverity: "all",
  routing: null,
  memoryStatus: { readEnabled: false },
  lastCopiedLink: null,
};

let retrievalPanel = null;

function resolveLanguage(pref) {
  if (pref === "zh-CN" || pref === "en") return pref;
  return navigator.language?.startsWith("zh") ? "zh-CN" : "en";
}

function t(key, vars = {}) {
  const dict = STRINGS[state.lang] ?? STRINGS.en;
  let str = dict[key] ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, String(v));
  return str;
}

function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.remove("is-hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("is-hidden"), 2600);
}

function setFeedback(id, message, isError = false) {
  const box = $(id);
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("is-hidden", !message);
  box.classList.toggle("is-error", Boolean(isError));
  box.classList.toggle("is-ok", !isError && Boolean(message));
}

// ---- Theme synchronization ----

function applyHostTheme(isDark) {
  document.body.classList.toggle("theme-dark", Boolean(isDark));
  document.body.classList.toggle("theme-light", !isDark);
}

function initThemeWatcher() {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (mq) {
    applyHostTheme(mq.matches);
    mq.addEventListener?.("change", (event) => applyHostTheme(event.matches));
  }
  window.addEventListener("appearance:changed", (event) => {
    const detailTheme = event?.detail?.theme;
    if (detailTheme === "light") applyHostTheme(false);
    else if (detailTheme === "dark") applyHostTheme(true);
    else if (mq) applyHostTheme(mq.matches);
  });
}

// ---- Section 4: Display / Language ----

async function loadPrefs({ migrateLegacy = false } = {}) {
  let pref = state.langPref || "auto";
  let legacy = null;
  if (migrateLegacy) {
    try {
      legacy = localStorage.getItem(LEGACY_LANGUAGE_STORAGE_KEY);
      if (legacy !== null) localStorage.removeItem(LEGACY_LANGUAGE_STORAGE_KEY);
    } catch {
      legacy = null;
    }
  }
  if (hasBridge()) {
    try {
      const res = await invokeBridge("kg.prefs.get", {}, BRIDGE_TIMEOUT_MS);
      pref = res?.language || "auto";
      if (
        migrateLegacy &&
        (legacy === "zh-CN" || legacy === "en") &&
        pref === "auto" &&
        res?.available !== false
      ) {
        await invokeBridge("kg.prefs.set", { language: legacy }, BRIDGE_TIMEOUT_MS);
        pref = legacy;
      }
    } catch {
      if (legacy === "zh-CN" || legacy === "en") pref = legacy;
    }
  } else if (legacy === "zh-CN" || legacy === "en") {
    pref = legacy;
  }
  state.langPref = pref;
  state.lang = resolveLanguage(pref);
  document.documentElement.lang = state.lang;
  renderLanguageButtons();
}

function renderLanguageButtons() {
  const disabled = !hasBridge();
  for (const [id, code] of [
    ["opt-lang-auto", "auto"],
    ["opt-lang-zh", "zh-CN"],
    ["opt-lang-en", "en"],
  ]) {
    const btn = $(id);
    if (!btn) continue;
    btn.disabled = disabled;
    const active = state.langPref === code;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

async function selectLanguage(language) {
  if (!hasBridge()) return;
  try {
    await invokeBridge("kg.prefs.set", { language }, BRIDGE_TIMEOUT_MS);
    state.langPref = language;
    state.lang = resolveLanguage(language);
    document.documentElement.lang = state.lang;
    applyTranslations();
    showToast(t("toastLanguageSaved"));
  } catch (error) {
    showToast(error?.message || String(error), true);
  }
}

// ---- Section 1: Vault (`kg.config.get` / `kg.config.set`) ----

async function loadVaultConfig({ populateForm = true, preserveFeedback = false } = {}) {
  if (!preserveFeedback) setFeedback("vault-feedback", "", false);
  if (!hasBridge()) {
    state.vaultConfig = {
      path: "~/.personal-knowledge/repo-map.json",
      source: "template",
      values: {
        vaultPath: "~/Documents/Knowledge",
        ignoreFolders: [".obsidian", ".trash"],
        backupRetentionDays: 30,
        readOnly: false,
      },
      locked: {},
      vault: { exists: true, notes: FIXTURE_GRAPH.nodes.length },
      reloadRequired: ["vaultPath", "ignoreFolders"],
    };
    state.vaultName = vaultBasename(state.vaultConfig.values.vaultPath, "Knowledge");
    if (populateForm) writeVaultForm(state.vaultConfig);
    renderVaultSection();
    return;
  }
  try {
    const res = await invokeBridge("kg.config.get", {}, BRIDGE_TIMEOUT_MS);
    state.vaultConfig = res;
    if (res?.values?.vaultPath) {
      state.vaultName = vaultBasename(res.values.vaultPath, state.vaultName);
    }
    if (populateForm) writeVaultForm(res);
  } catch (error) {
    setFeedback("vault-feedback", error?.message || String(error), true);
  } finally {
    renderVaultSection();
  }
}

function writeVaultForm(config) {
  const values = config?.values ?? {};
  $("vault-path").value = values.vaultPath ?? "";
  $("vault-readonly").checked = Boolean(values.readOnly || config?.locked?.readOnly);
  $("vault-retention").value =
    values.backupRetentionDays !== null && values.backupRetentionDays !== undefined
      ? String(values.backupRetentionDays)
      : "";
  $("vault-ignore-folders").value = Array.isArray(values.ignoreFolders)
    ? values.ignoreFolders.join(", ")
    : "";
}

function renderVaultSection() {
  const cfg = state.vaultConfig;
  const locked = cfg?.locked ?? {};
  const disabledBase = !hasBridge() || state.vaultBusy;

  $("vault-source-badge").textContent =
    cfg?.source === "user" ? t("vaultSourceUser") : t("vaultSourceTemplate");
  $("vault-config-path").textContent = cfg?.path || "";

  const pathLockEl = $("vault-path-lock");
  if (locked.vaultPath) {
    pathLockEl.textContent = t("vaultLockedByEnv", { env: locked.vaultPath });
    pathLockEl.classList.remove("is-hidden");
  } else {
    pathLockEl.textContent = "";
    pathLockEl.classList.add("is-hidden");
  }
  $("vault-path").disabled = disabledBase || Boolean(locked.vaultPath);

  const readOnlyLockEl = $("vault-readonly-lock");
  if (locked.readOnly) {
    readOnlyLockEl.textContent = t("vaultLockedByEnv", { env: locked.readOnly });
    readOnlyLockEl.classList.remove("is-hidden");
  } else {
    readOnlyLockEl.textContent = "";
    readOnlyLockEl.classList.add("is-hidden");
  }
  $("vault-readonly").disabled = disabledBase || Boolean(locked.readOnly);

  $("vault-retention").disabled = disabledBase;
  $("vault-ignore-folders").disabled = disabledBase;
  $("btn-vault-save").disabled = disabledBase;

  const statusBadge = $("vault-status-badge");
  const vaultPathVal = cfg?.values?.vaultPath;
  if (vaultPathVal) {
    if (cfg?.vault?.exists) {
      statusBadge.className = "status-pill status-ok";
      statusBadge.textContent =
        cfg.vault.notes !== null && cfg.vault.notes !== undefined
          ? t("vaultStatusExists", { notes: cfg.vault.notes })
          : t("vaultStatusExistsNoCount");
    } else {
      statusBadge.className = "status-pill status-error";
      statusBadge.textContent = t("vaultStatusMissing");
    }
  } else {
    statusBadge.className = "status-pill status-muted";
    statusBadge.textContent = t("vaultStatusDefault");
  }
}

async function saveVaultConfig() {
  if (!hasBridge() || state.vaultBusy) return;
  const locked = state.vaultConfig?.locked ?? {};
  const rawPath = $("vault-path").value.trim();
  const rawRetention = $("vault-retention").value.trim();
  const rawIgnore = $("vault-ignore-folders").value;
  const readOnly = Boolean($("vault-readonly").checked);

  const values = {
    ignoreFolders: parseCommaList(rawIgnore),
    backupRetentionDays: rawRetention === "" ? null : Number(rawRetention),
  };
  if (!locked.vaultPath) {
    values.vaultPath = rawPath ? rawPath : null;
  }
  if (!locked.readOnly) {
    values.readOnly = readOnly;
  }

  state.vaultBusy = true;
  renderVaultSection();
  try {
    await invokeBridge("kg.config.set", { values }, BRIDGE_TIMEOUT_MS);
    showToast(t("vaultSavedToast"));
    setFeedback("vault-feedback", t("vaultSavedReloadNotice"), false);
    await loadVaultConfig({ populateForm: true, preserveFeedback: true });
    renderHealthList();
  } catch (error) {
    setFeedback("vault-feedback", error?.message || String(error), true);
  } finally {
    state.vaultBusy = false;
    renderVaultSection();
  }
}

// ---- Section 3: Index (`kg.index.status` / `kg.index.rebuild`) ----

function stopIndexPoll() {
  if (state.indexPollTimer !== null) {
    clearTimeout(state.indexPollTimer);
    state.indexPollTimer = null;
  }
}

function scheduleIndexPoll() {
  stopIndexPoll();
  if (document.hidden || !hasBridge() || !state.indexStatus?.running) return;
  state.indexPollTimer = setTimeout(() => {
    void loadIndexStatus();
  }, INDEX_POLL_INTERVAL_MS);
}

async function loadIndexStatus() {
  if (!hasBridge()) {
    state.indexStatus = {
      enabled: false,
      vectorReady: false,
      notes: FIXTURE_GRAPH.nodes.length,
      chunks: 0,
      stored: 0,
      pending: 0,
      model: DEFAULT_EMBEDDING_SETTINGS.model,
      dims: null,
      writtenAt: null,
      running: false,
      done: 0,
      total: 0,
      reason: null,
    };
    renderIndexSection();
    return;
  }
  const wasRunning = Boolean(state.indexStatus?.running);
  try {
    const res = await invokeBridge("kg.index.status", {}, BRIDGE_TIMEOUT_MS);
    state.indexStatus = res;
    renderIndexSection();
    if (res?.running) {
      state.hasIndexRunInSession = true;
      scheduleIndexPoll();
    } else {
      stopIndexPoll();
      if (wasRunning) {
        setFeedback("index-feedback", t("indexCompleted"), false);
        await retrievalPanel?.load(false);
      }
    }
  } catch (error) {
    stopIndexPoll();
    setFeedback("index-feedback", error?.message || String(error), true);
    renderIndexSection();
  }
}

function renderIndexSection() {
  const status = state.indexStatus ?? {};
  const badge = $("index-status-badge");
  if (status.running) {
    badge.className = "status-pill status-running";
    badge.textContent = t("indexStatusRunning", {
      done: status.done ?? 0,
      total: status.total ?? 0,
    });
  } else if (!status.enabled) {
    badge.className = "status-pill status-muted";
    badge.textContent = t("indexStatusDisabled");
  } else if (status.vectorReady) {
    badge.className = "status-pill status-ok";
    badge.textContent = t("indexStatusReady");
  } else {
    badge.className = "status-pill status-warn";
    badge.textContent = t("indexStatusEnabled");
  }

  $("index-stat-notes").textContent = String(status.notes ?? 0);
  $("index-stat-chunks").textContent = String(status.chunks ?? 0);
  $("index-stat-stored").textContent = String(status.stored ?? 0);
  $("index-stat-pending").textContent = String(status.pending ?? 0);
  $("index-stat-model").textContent = status.model
    ? status.dims
      ? t("indexStatModelFormat", { model: status.model, dims: status.dims })
      : String(status.model)
    : "—";
  $("index-stat-written").textContent = status.writtenAt
    ? new Date(status.writtenAt).toLocaleString()
    : t("indexStatNever");

  const reasonEl = $("index-reason");
  if (status.reason) {
    reasonEl.textContent = t("indexReasonLabel", { reason: status.reason });
    reasonEl.classList.remove("is-hidden");
  } else {
    reasonEl.textContent = "";
    reasonEl.classList.add("is-hidden");
  }

  const progressWrap = $("index-progress-wrap");
  const showProgress = Boolean(status.running || state.hasIndexRunInSession);
  progressWrap.classList.toggle("is-hidden", !showProgress);
  if (showProgress) {
    const done = Math.max(0, Number(status.done) || 0);
    const total = Math.max(0, Number(status.total) || 0);
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : status.running ? 10 : 100;
    const bar = $("index-progress-bar");
    bar.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(done));
    bar.setAttribute("aria-valuemax", String(total || 100));
    $("index-progress-text").textContent = `${done} / ${total}`;
  }

  const disableActions = !hasBridge() || Boolean(status.running) || state.indexBusy;
  $("btn-index-rebuild-incremental").disabled = disableActions;
  $("btn-index-rebuild-full").disabled = disableActions;
}

async function startIndexRebuild(mode) {
  if (!hasBridge() || state.indexBusy) return;
  $("index-confirm-box").classList.add("is-hidden");
  state.indexBusy = true;
  renderIndexSection();
  try {
    const res = await invokeBridge("kg.index.rebuild", { mode }, BRIDGE_TIMEOUT_MS);
    if (res?.started) {
      state.hasIndexRunInSession = true;
      setFeedback(
        "index-feedback",
        mode === "full" ? t("indexStartedFull") : t("indexStartedIncremental"),
        false,
      );
      await loadIndexStatus();
    } else if (res?.reason === "RUNNING") {
      setFeedback("index-feedback", t("indexRefusedRunning"), true);
      await loadIndexStatus();
    } else if (res?.reason === "DISABLED") {
      setFeedback("index-feedback", t("indexRefusedDisabled"), true);
    } else {
      setFeedback("index-feedback", res?.reason || "Rebuild refused", true);
    }
  } catch (error) {
    setFeedback("index-feedback", error?.message || String(error), true);
  } finally {
    state.indexBusy = false;
    renderIndexSection();
  }
}

// ---- Section 5: Ontology Health (`kg.graph`) ----

async function loadHealthGraph() {
  if (!hasBridge()) {
    state.graphPayload = FIXTURE_GRAPH;
    renderHealthList();
    return;
  }
  try {
    const payload = await invokeBridge("kg.graph", { includeMemory: false }, BRIDGE_TIMEOUT_MS);
    state.graphPayload = payload;
    if (!state.vaultConfig?.values?.vaultPath && payload?.vaultName) {
      state.vaultName = payload.vaultName;
    }
  } catch {
    state.graphPayload = FIXTURE_GRAPH;
  }
  renderHealthList();
}

function normalizeNodeIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues
    .map((item) => {
      if (typeof item === "string") return { code: item, detail: "" };
      if (item && typeof item.code === "string") return { code: item.code, detail: item.detail || "" };
      return null;
    })
    .filter(Boolean);
}

function renderHealthList() {
  const list = $("health-list");
  if (!list) return;
  list.innerHTML = "";

  const nodes = state.graphPayload?.nodes ?? [];
  const filter = state.healthSeverity || "all";
  const allIssueNodes = [];
  const filteredNodes = [];

  for (const node of nodes) {
    if (node.kind === "satellite" || node.family === "memory") continue;
    const issueItems = normalizeNodeIssues(node.issues);
    const worst = nodeSeverity(issueItems);
    if (issueItems.length === 0 || worst === "ok") continue;
    allIssueNodes.push({ node, issueItems, worst });
    if (filter === "all" || worst === filter) {
      filteredNodes.push({ node, issueItems, worst });
    }
  }

  $("health-summary-count").textContent = t("healthSummaryCount", { count: allIssueNodes.length });

  const rank = { red: 0, amber: 1, muted: 2 };
  filteredNodes.sort(
    (a, b) =>
      (rank[a.worst] ?? 3) - (rank[b.worst] ?? 3) ||
      (a.node.id < b.node.id ? -1 : 1),
  );

  if (filteredNodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("healthEmpty");
    list.appendChild(empty);
    return;
  }

  for (const { node, issueItems } of filteredNodes) {
    const row = document.createElement("div");
    row.className = "health-row";

    const top = document.createElement("div");
    top.className = "health-row-top";

    const info = document.createElement("div");
    info.className = "health-note-info";

    const title = document.createElement("div");
    title.className = "health-row-title";
    title.textContent = node.title || node.id;

    const meta = document.createElement("div");
    meta.className = "health-row-meta";
    const clsName = t("classes")[node.cls] ?? t("classUnknown");
    const charsText = typeof node.chars === "number" ? `${node.chars.toLocaleString()} chars` : "";
    meta.textContent = [clsName, node.id, charsText].filter(Boolean).join(" · ");

    info.append(title, meta);

    const link = buildObsidianLink(state.vaultName, node.id);
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ghost-btn copy-link-btn";
    copyBtn.textContent = t("drawerCopyLink");
    copyBtn.dataset.link = link;
    copyBtn.title = link;
    copyBtn.addEventListener("click", () => {
      void copyNoteLink(node.id);
    });

    top.append(info, copyBtn);

    const chips = document.createElement("div");
    chips.className = "health-row-issues";
    for (const { code, detail } of issueItems) {
      const chip = document.createElement("span");
      chip.className = `issue-chip sev-${classifyIssueCode(code)}`;
      const label = t("issues")[code] ?? code;
      chip.textContent = detail ? `${label} · ${code} (${detail})` : `${label} · ${code}`;
      if (detail) chip.title = detail;
      chips.appendChild(chip);
    }

    row.append(top, chips);
    list.appendChild(row);
  }
}

async function copyNoteLink(notePath) {
  const link = buildObsidianLink(state.vaultName, notePath);
  state.lastCopiedLink = link;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied && hasBridge()) {
    try {
      await invokeBridge("kg.copyLink", { path: notePath }, BRIDGE_TIMEOUT_MS);
      copied = true;
    } catch (error) {
      showToast(t("toastCopyFailed", { reason: error?.message || String(error) }), true);
      return;
    }
  }
  showToast(t("toastCopied"));
}

// ---- Section 6: Project Routing (`kg.routing.get`) ----

async function loadRouting() {
  if (!hasBridge()) {
    state.routing = DEMO_ROUTING;
    renderRoutingSection();
    return;
  }
  try {
    state.routing = await invokeBridge("kg.routing.get", {}, BRIDGE_TIMEOUT_MS);
  } catch {
    state.routing = { projects: [], topicRoutes: [], defaultNotes: [] };
  }
  renderRoutingSection();
}

function createNoteChip(note) {
  const chip = document.createElement("span");
  const exists = Boolean(note?.exists);
  chip.className = `routing-note-chip${exists ? "" : " is-missing"}`;
  const pathSpan = document.createElement("span");
  pathSpan.textContent = note?.path ?? "";
  chip.appendChild(pathSpan);
  if (!exists) {
    const flag = document.createElement("span");
    flag.className = "badge badge-danger";
    flag.textContent = t("routingNoteMissing");
    chip.appendChild(flag);
  }
  return chip;
}

function renderRoutingSection() {
  const routing = state.routing ?? { projects: [], topicRoutes: [], defaultNotes: [] };

  const projectsEl = $("routing-projects-list");
  projectsEl.innerHTML = "";
  if (!routing.projects?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("routingEmpty");
    projectsEl.appendChild(empty);
  } else {
    for (const proj of routing.projects) {
      const card = document.createElement("div");
      card.className = "routing-card";
      const title = document.createElement("div");
      title.className = "routing-card-title";
      title.textContent = proj.name || "—";
      card.appendChild(title);

      if (proj.repoPrefixes?.length) {
        const line = document.createElement("div");
        line.className = "routing-meta-line";
        const label = document.createElement("span");
        label.className = "routing-meta-label";
        label.textContent = `${t("routingRepoPrefixes")}:`;
        line.appendChild(label);
        for (const prefix of proj.repoPrefixes) {
          const tag = document.createElement("code");
          tag.className = "code-tag";
          tag.textContent = prefix;
          line.appendChild(tag);
        }
        card.appendChild(line);
      }

      if (proj.aliases?.length) {
        const line = document.createElement("div");
        line.className = "routing-meta-line";
        const label = document.createElement("span");
        label.className = "routing-meta-label";
        label.textContent = `${t("routingAliases")}:`;
        line.appendChild(label);
        for (const alias of proj.aliases) {
          const tag = document.createElement("span");
          tag.className = "code-tag";
          tag.textContent = alias;
          line.appendChild(tag);
        }
        card.appendChild(line);
      }

      const notesLine = document.createElement("div");
      notesLine.className = "routing-meta-line";
      const notesLabel = document.createElement("span");
      notesLabel.className = "routing-meta-label";
      notesLabel.textContent = `${t("routingNotes")}:`;
      notesLine.appendChild(notesLabel);
      for (const note of proj.notes ?? []) {
        notesLine.appendChild(createNoteChip(note));
      }
      card.appendChild(notesLine);
      projectsEl.appendChild(card);
    }
  }

  const topicsEl = $("routing-topics-list");
  topicsEl.innerHTML = "";
  if (!routing.topicRoutes?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("routingEmpty");
    topicsEl.appendChild(empty);
  } else {
    for (const route of routing.topicRoutes) {
      const card = document.createElement("div");
      card.className = "routing-card";
      const title = document.createElement("div");
      title.className = "routing-card-title";
      title.textContent = route.name || "—";
      card.appendChild(title);

      if (route.aliases?.length) {
        const line = document.createElement("div");
        line.className = "routing-meta-line";
        const label = document.createElement("span");
        label.className = "routing-meta-label";
        label.textContent = `${t("routingAliases")}:`;
        line.appendChild(label);
        for (const alias of route.aliases) {
          const tag = document.createElement("span");
          tag.className = "code-tag";
          tag.textContent = alias;
          line.appendChild(tag);
        }
        card.appendChild(line);
      }

      const notesLine = document.createElement("div");
      notesLine.className = "routing-meta-line";
      const notesLabel = document.createElement("span");
      notesLabel.className = "routing-meta-label";
      notesLabel.textContent = `${t("routingNotes")}:`;
      notesLine.appendChild(notesLabel);
      for (const note of route.notes ?? []) {
        notesLine.appendChild(createNoteChip(note));
      }
      card.appendChild(notesLine);
      topicsEl.appendChild(card);
    }
  }

  const defaultsEl = $("routing-defaults-list");
  defaultsEl.innerHTML = "";
  if (!routing.defaultNotes?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("routingEmpty");
    defaultsEl.appendChild(empty);
  } else {
    const line = document.createElement("div");
    line.className = "routing-meta-line";
    for (const note of routing.defaultNotes) {
      line.appendChild(createNoteChip(note));
    }
    defaultsEl.appendChild(line);
  }
}

// ---- Section 7: Memory (`kg.memory.status`) ----

async function loadMemoryStatus() {
  if (!hasBridge()) {
    state.memoryStatus = { readEnabled: false };
    renderMemorySection();
    return;
  }
  try {
    const res = await invokeBridge("kg.memory.status", {}, BRIDGE_TIMEOUT_MS);
    state.memoryStatus = { readEnabled: Boolean(res?.readEnabled) };
  } catch {
    state.memoryStatus = { readEnabled: false };
  }
  renderMemorySection();
}

function renderMemorySection() {
  const enabled = Boolean(state.memoryStatus?.readEnabled);
  const badge = $("memory-status-badge");
  badge.className = `status-pill ${enabled ? "status-ok" : "status-muted"}`;
  badge.textContent = enabled ? t("memoryStatusEnabled") : t("memoryStatusDisabled");
}

// ---- Translations ----

function applyTranslations() {
  document.title = `${t("panelTitle")} · Personal Knowledge`;
  $("panel-title").textContent = t("panelTitle");
  $("panel-subtitle").textContent = t("panelSubtitle");
  $("panel-stub-notice").textContent = t("panelStubNotice");

  $("nav-vault").textContent = t("navVault");
  $("nav-retrieval").textContent = t("navRetrieval");
  $("nav-index").textContent = t("navIndex");
  $("nav-display").textContent = t("navDisplay");
  $("nav-health").textContent = t("navHealth");
  $("nav-routing").textContent = t("navRouting");
  $("nav-memory").textContent = t("navMemory");

  // 1. Vault
  $("vault-heading").textContent = t("vaultHeading");
  $("vault-desc").textContent = t("vaultDesc");
  $("label-vault-path").textContent = t("vaultPathLabel");
  $("vault-path").placeholder = t("vaultPathPlaceholder");
  $("vault-path-reload").textContent = t("vaultPathReloadHint");
  $("label-vault-readonly").textContent = t("vaultReadOnlyLabel");
  $("hint-vault-readonly").textContent = t("vaultReadOnlyHint");
  $("label-vault-retention").textContent = t("vaultRetentionLabel");
  $("vault-retention").placeholder = t("vaultRetentionPlaceholder");
  $("hint-vault-retention").textContent = t("vaultRetentionHint");
  $("label-vault-ignore").textContent = t("vaultIgnoreLabel");
  $("vault-ignore-folders").placeholder = t("vaultIgnorePlaceholder");
  $("vault-ignore-reload").textContent = t("vaultPathReloadHint");
  $("hint-vault-ignore").textContent = t("vaultIgnoreHint");
  $("label-vault-save").textContent = t("vaultSaveBtn");
  renderVaultSection();

  // 2. Vector retrieval
  retrievalPanel?.applyTranslations();

  // 3. Index
  $("index-heading").textContent = t("indexHeading");
  $("index-desc").textContent = t("indexDesc");
  $("label-index-notes").textContent = t("indexStatNotes");
  $("label-index-chunks").textContent = t("indexStatChunks");
  $("label-index-stored").textContent = t("indexStatStored");
  $("label-index-pending").textContent = t("indexStatPending");
  $("label-index-model").textContent = t("indexStatModel");
  $("label-index-written").textContent = t("indexStatWrittenAt");
  $("label-index-incremental").textContent = t("indexRefreshIncrementalBtn");
  $("label-index-full").textContent = t("indexRebuildFullBtn");
  $("index-confirm-text").textContent = t("indexFullConfirmPrompt");
  $("btn-index-confirm-full").textContent = t("indexFullConfirmBtn");
  $("btn-index-cancel-full").textContent = t("indexFullCancelBtn");
  renderIndexSection();

  // 4. Display
  $("display-heading").textContent = t("displayHeading");
  $("display-desc").textContent = t("displayDesc");
  $("label-display-language").textContent = t("displayLanguageLabel");
  $("opt-lang-auto").textContent = t("languageAuto");
  $("opt-lang-zh").textContent = t("languageZh");
  $("opt-lang-en").textContent = t("languageEn");
  renderLanguageButtons();

  // 5. Ontology health
  $("health-heading").textContent = t("healthHeading");
  $("health-desc").textContent = t("healthDesc");
  $("health-sev-all").textContent = t("healthFilterAll");
  $("health-sev-red").textContent = t("healthFilterRed");
  $("health-sev-amber").textContent = t("healthFilterAmber");
  $("health-sev-muted").textContent = t("healthFilterMuted");
  renderHealthList();

  // 6. Project routing
  $("routing-heading").textContent = t("routingHeading");
  $("routing-readonly-hint").textContent = t("routingReadOnlyHint");
  $("routing-projects-heading").textContent = t("routingProjectsSubheading");
  $("routing-topics-heading").textContent = t("routingTopicsSubheading");
  $("routing-defaults-heading").textContent = t("routingDefaultsSubheading");
  renderRoutingSection();

  // 7. Memory
  $("memory-heading").textContent = t("memoryHeading");
  $("memory-desc").textContent = t("memoryDesc");
  $("label-memory-status").textContent = t("memoryReadStatusLabel");
  $("memory-where-hint").textContent = t("memoryWhereToEnable");
  renderMemorySection();
}

// ---- Bindings & Boot ----

function bindUi() {
  $("btn-vault-save").addEventListener("click", () => {
    void saveVaultConfig();
  });

  $("btn-index-rebuild-incremental").addEventListener("click", () => {
    void startIndexRebuild("incremental");
  });
  $("btn-index-rebuild-full").addEventListener("click", () => {
    if (!hasBridge() || state.indexBusy || state.indexStatus?.running) return;
    $("index-confirm-box").classList.remove("is-hidden");
    $("btn-index-confirm-full")?.focus();
  });
  $("btn-index-confirm-full").addEventListener("click", () => {
    void startIndexRebuild("full");
  });
  $("btn-index-cancel-full").addEventListener("click", () => {
    $("index-confirm-box").classList.add("is-hidden");
  });

  for (const [id, code] of [
    ["opt-lang-auto", "auto"],
    ["opt-lang-zh", "zh-CN"],
    ["opt-lang-en", "en"],
  ]) {
    $(id).addEventListener("click", () => {
      void selectLanguage(code);
    });
  }

  $("health-severity-filter").addEventListener("change", (event) => {
    state.healthSeverity = event.target.value;
    renderHealthList();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopIndexPoll();
    } else if (hasBridge()) {
      void loadPrefs();
      void loadIndexStatus();
    }
  });
}

async function reloadAll() {
  state.bridgeAvailable = hasBridge();
  $("panel-stub-notice").classList.toggle("is-hidden", state.bridgeAvailable);
  await loadPrefs({ migrateLegacy: true });
  applyTranslations();
  await Promise.all([
    loadVaultConfig({ populateForm: true }),
    retrievalPanel.load(true),
    loadIndexStatus(),
    loadHealthGraph(),
    loadRouting(),
    loadMemoryStatus(),
  ]);
  applyTranslations();
}

async function boot() {
  initThemeWatcher();
  state.lang = resolveLanguage("auto");
  retrievalPanel = new RetrievalSettingsPanel({
    t,
    showToast,
    onSaved: () => loadIndexStatus(),
  });
  bindUi();
  await reloadAll();
}

window.__kgSettingsPanel = {
  state,
  get retrievalPanel() {
    return retrievalPanel;
  },
  reloadAll,
  buildObsidianLink,
  vaultBasename,
};

boot();
