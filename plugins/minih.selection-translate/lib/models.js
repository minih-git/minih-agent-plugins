"use strict";

/**
 * Which model a translation runs on.
 *
 * The configured model is a plain setting (`model`, `providerId/modelId`),
 * because the host's declarative settings sheet cannot fill a dropdown from the
 * live model list. Choosing from the live list is therefore the plugin's own
 * card, which writes the same setting; this module is the one place that
 * decides what a request actually runs on, and it is pure so the fallback rules
 * are unit tested.
 */

/**
 * The model a request runs on.
 *
 * - a configured model that still exists wins;
 * - a configured model that is gone is not an error: the host default takes
 *   over, and `note` says so, so a deleted provider degrades instead of
 *   breaking every selection;
 * - with nothing configured, the host default model is used, so the plugin
 *   works before it is configured at all.
 */
function resolveModel(models, configured) {
  const list = Array.isArray(models) ? models : [];
  const wanted = typeof configured === "string" ? configured.trim() : "";
  if (list.length === 0) return { model: null, note: "" };
  if (wanted) {
    const match = list.find((model) => model.key === wanted);
    if (match) return { model: match, note: "" };
  }
  const fallback = list.find((model) => model.isDefault) ?? list[0];
  return {
    model: fallback,
    note: wanted ? `配置的模型已不可用，本次改用 ${fallback.label}` : "",
  };
}

/** Dropdown options in a stable order: the host default first, then by label. */
function modelOptions(models) {
  const list = Array.isArray(models) ? models : [];
  return list
    .map((model) => ({
      key: model.key,
      label: model.alias ? `${model.alias} · ${model.label}` : model.label,
      isDefault: model.isDefault === true,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
}

/** A model key the list actually holds, or `""` for "follow the host default". */
function isSelectableModel(models, key) {
  if (key === "") return true;
  return (Array.isArray(models) ? models : []).some((model) => model.key === key);
}

module.exports = { isSelectableModel, modelOptions, resolveModel };