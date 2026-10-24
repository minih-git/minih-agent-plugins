/**
 * Retrieval settings panel (the 0.2.0 panel, now opened from the ⚙ menu).
 *
 * Channels and behavior are unchanged: `kg.settings.get` fills the form,
 * `kg.settings.set` validates and saves, `kg.settings.test` embeds one fixed
 * string. The API key is never displayed or stored — only its variable name.
 */

import { invokeBridge, hasBridge } from "./bridge.js";
import { BRIDGE_TIMEOUT_MS } from "./strings.js";

const DEFAULT_EMBEDDING_SETTINGS = {
  enabled: false,
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "nomic-embed-text",
  allowRemote: false,
  apiKeyEnv: "",
  exclude: [],
};

function parseExcludeFolders(rawText) {
  return String(rawText || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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

export class RetrievalSettingsPanel {
  constructor({ t, showToast }) {
    this.t = t;
    this.showToast = showToast;
    this.panel = document.getElementById("settings-panel");
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
    document.getElementById("settings-close").addEventListener("click", () => this.close());
    document.getElementById("btn-settings-test").addEventListener("click", () => this.test());
    document.getElementById("btn-settings-save").addEventListener("click", () => this.save());
    document.getElementById("btn-settings-confirm").addEventListener("click", () => this.save());
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
      const el = document.getElementById(id);
      el?.addEventListener("input", dirty);
      el?.addEventListener("change", dirty);
    }
  }

  isOpen() {
    return !this.panel.classList.contains("is-hidden");
  }

  open() {
    this.panel.classList.remove("is-hidden");
    this.load(true);
  }

  close() {
    this.panel.classList.add("is-hidden");
  }

  formValues() {
    return {
      enabled: Boolean(document.getElementById("settings-enabled").checked),
      provider:
        document.getElementById("settings-provider").value === "openai-compatible"
          ? "openai-compatible"
          : "ollama",
      baseUrl: document.getElementById("settings-baseurl").value.trim(),
      model: document.getElementById("settings-model").value.trim(),
      allowRemote: Boolean(document.getElementById("settings-allow-remote").checked),
      apiKeyEnv: document.getElementById("settings-apikey-env").value.trim(),
      exclude: parseExcludeFolders(document.getElementById("settings-exclude").value),
    };
  }

  writeForm(config) {
    const norm = normalizeEmbeddingConfig(config);
    document.getElementById("settings-enabled").checked = norm.enabled;
    document.getElementById("settings-provider").value = norm.provider;
    document.getElementById("settings-baseurl").value = norm.baseUrl;
    document.getElementById("settings-model").value = norm.model;
    document.getElementById("settings-allow-remote").checked = norm.allowRemote;
    document.getElementById("settings-apikey-env").value = norm.apiKeyEnv;
    document.getElementById("settings-exclude").value = norm.exclude.join(", ");
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
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    }
  }

  feedback(message, isError) {
    const box = document.getElementById("settings-feedback");
    if (!box) return;
    box.textContent = message;
    box.classList.toggle("is-hidden", !message);
    box.classList.toggle("is-error", Boolean(isError));
    box.classList.toggle("is-ok", !isError && Boolean(message));
  }

  async load(populateForm) {
    this.bridgeAvailable = hasBridge();
    document.getElementById("settings-fixture-notice").classList.toggle("is-hidden", this.bridgeAvailable);
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
    const remoteWarn = document.getElementById("settings-remote-warning");
    remoteWarn.textContent = this.t("settingsRemoteWarning");
    remoteWarn.classList.toggle("is-hidden", !values.allowRemote);

    const isDirty =
      this.bridgeAvailable && this.baselineSnapshot !== null && !areEmbeddingConfigsEqual(values, this.baselineSnapshot);
    document.getElementById("settings-unsaved-pill").classList.toggle("is-hidden", !isDirty);
    const dirtyDot = document.getElementById("settings-estimate-dirty-dot");
    dirtyDot.classList.toggle("is-hidden", !isDirty);

    const keyBadge = document.getElementById("settings-key-status");
    keyBadge.className = `key-status-badge status-${this.apiKeyStatus}`;
    keyBadge.textContent = this.t(
      this.apiKeyStatus === "found"
        ? "settingsKeyFound"
        : this.apiKeyStatus === "missing"
          ? "settingsKeyMissing"
          : "settingsKeyNotRequired",
    );

    const indexEl = document.getElementById("settings-index-stats");
    indexEl.textContent = this.index
      ? this.t("settingsIndexFormat", {
          identity: this.index.identity || "—",
          dims: this.index.dims ?? "—",
          chunks: this.index.chunks ?? 0,
          builtAt: this.index.builtAt || "—",
        })
      : this.t("settingsIndexNotBuilt");

    const estEl = document.getElementById("settings-estimate-value");
    estEl.textContent = this.estimate
      ? this.t("settingsEstimateFormat", {
          chunks: this.estimate.chunks ?? 0,
          characters: this.estimate.characters ?? 0,
        })
      : "—";

    const confirmBtn = document.getElementById("btn-settings-confirm");
    const savedRemote = Boolean(this.savedSettings?.allowRemote);
    if (!values.allowRemote || savedRemote) this.confirmingRemote = false;
    document.getElementById("label-settings-confirm").textContent = this.t("settingsConfirmSendBtn", {
      chunks: this.estimate?.chunks ?? 0,
      characters: this.estimate?.characters ?? 0,
    });
    confirmBtn.classList.toggle("is-hidden", !this.confirmingRemote);
  }

  applyTranslations() {
    const t = this.t;
    this.panel.setAttribute("aria-label", t("settingsHeading"));
    document.getElementById("settings-heading").textContent = t("settingsHeading");
    document.getElementById("settings-close").setAttribute("aria-label", t("settingsCloseAria"));
    document.getElementById("settings-unsaved-label").textContent = t("settingsUnsaved");
    document.getElementById("settings-fixture-notice").textContent = t("settingsFixtureNotice");
    document.getElementById("label-settings-enabled").textContent = t("settingsEnabledLabel");
    document.getElementById("label-settings-provider").textContent = t("settingsProviderLabel");
    document.getElementById("opt-provider-ollama").textContent = t("settingsProviderOllama");
    document.getElementById("opt-provider-openai").textContent = t("settingsProviderOpenai");
    document.getElementById("label-settings-baseurl").textContent = t("settingsBaseUrlLabel");
    document.getElementById("settings-baseurl").placeholder = t("settingsBaseUrlPlaceholder");
    document.getElementById("hint-settings-baseurl").textContent = t("settingsBaseUrlHint");
    document.getElementById("label-settings-model").textContent = t("settingsModelLabel");
    document.getElementById("settings-model").placeholder = t("settingsModelPlaceholder");
    document.getElementById("label-settings-apikey-env").textContent = t("settingsApiKeyEnvLabel");
    document.getElementById("settings-apikey-env").placeholder = t("settingsApiKeyEnvPlaceholder");
    document.getElementById("hint-settings-apikey-env").textContent = t("settingsApiKeyEnvHint");
    document.getElementById("label-settings-exclude").textContent = t("settingsExcludeLabel");
    document.getElementById("settings-exclude").placeholder = t("settingsExcludePlaceholder");
    document.getElementById("hint-settings-exclude").textContent = t("settingsExcludeHint");
    document.getElementById("label-settings-allow-remote").textContent = t("settingsAllowRemoteLabel");
    document.getElementById("label-settings-key-status").textContent = t("settingsKeyStatusLabel");
    document.getElementById("label-settings-index").textContent = t("settingsIndexLabel");
    document.getElementById("label-settings-estimate").textContent = t("settingsEstimateLabel");
    document.getElementById("label-settings-test").textContent = t("settingsTestBtn");
    document.getElementById("label-settings-save").textContent = t("settingsSaveBtn");
    this.renderDynamic();
  }

  async save() {
    if (!this.bridgeAvailable || this.busy) return;
    const values = this.formValues();
    const savedRemote = Boolean(this.savedSettings?.allowRemote);
    if (values.allowRemote && !savedRemote && !this.confirmingRemote) {
      this.confirmingRemote = true;
      this.renderDynamic();
      document.getElementById("btn-settings-confirm")?.focus();
      return;
    }
    this.busy = true;
    this.setControlsDisabled(true);
    try {
      await invokeBridge("kg.settings.set", { embedding: values }, BRIDGE_TIMEOUT_MS);
      this.confirmingRemote = false;
      this.showToast(this.t("toastSettingsSaved"));
      await this.load(true);
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
        this.feedback(msg ? (reason && !msg.startsWith(reason) ? `${reason} ${msg}` : msg) : reason || "Test failed", true);
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
