"use strict";

/**
 * The languages this plugin can translate into.
 *
 * `name` is what the system prompt asks for (English, because that is what a
 * model follows most reliably); `label` is what the card's dropdown and the
 * plugin's settings enum show. Simplified Chinese is the default — the plugin
 * exists because thinking models answer in English.
 *
 * The same list is declared again in `manifest.json` as the `language` setting's
 * enum, because a manifest is static; `tests/manifest.test.mjs` fails if the two
 * ever disagree.
 */
const LANGUAGES = [
  { code: "zh-CN", label: "简体中文", name: "Simplified Chinese" },
  { code: "zh-TW", label: "繁體中文", name: "Traditional Chinese" },
  { code: "en", label: "English", name: "English" },
  { code: "ja", label: "日本語", name: "Japanese" },
  { code: "ko", label: "한국어", name: "Korean" },
  { code: "fr", label: "Français", name: "French" },
  { code: "de", label: "Deutsch", name: "German" },
  { code: "es", label: "Español", name: "Spanish" },
  { code: "ru", label: "Русский", name: "Russian" },
  { code: "pt", label: "Português", name: "Portuguese" },
];

const DEFAULT_LANGUAGE = "zh-CN";

/** True for a code this plugin can translate into. */
function isLanguage(code) {
  return LANGUAGES.some((language) => language.code === code);
}

/**
 * The language for one request. An unknown or missing code — an old setting
 * written before this list existed, a hand-edited settings file — lands on the
 * default rather than failing the translation.
 */
function languageByCode(code) {
  const wanted = typeof code === "string" ? code.trim() : "";
  return LANGUAGES.find((language) => language.code === wanted) ?? LANGUAGES.find((language) => language.code === DEFAULT_LANGUAGE);
}

module.exports = { DEFAULT_LANGUAGE, LANGUAGES, isLanguage, languageByCode };