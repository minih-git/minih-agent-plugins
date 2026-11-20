"use strict";

/**
 * The settings the generated sheet writes, normalized once per read.
 *
 * Every value is a user-editable field, so each is clamped rather than trusted:
 * a digest interval of `0` would post a notification per message and a negative
 * one would post on every cycle. The defaults are the same ones the manifest
 * declares, and the plugin runs on them before the user opens Settings at all.
 */

const { DEFAULT_PROVIDER_ID, providerFor } = require("./providers");

const MIN_DIGEST_MINUTES = 1;
const MAX_DIGEST_MINUTES = 24 * 60;

const DEFAULTS = {
  provider: DEFAULT_PROVIDER_ID,
  importantSenders: "",
  keywords: "",
  digestMinutes: 30,
  unreadOnly: false,
};

function clampMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULTS.digestMinutes;
  return Math.min(MAX_DIGEST_MINUTES, Math.max(MIN_DIGEST_MINUTES, Math.round(minutes)));
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    provider: providerFor(source.provider).id,
    importantSenders: typeof source.importantSenders === "string" ? source.importantSenders : "",
    keywords: typeof source.keywords === "string" ? source.keywords : "",
    digestMinutes: clampMinutes(source.digestMinutes),
    unreadOnly: source.unreadOnly === true,
  };
}

module.exports = { DEFAULTS, MAX_DIGEST_MINUTES, MIN_DIGEST_MINUTES, normalizeSettings };
