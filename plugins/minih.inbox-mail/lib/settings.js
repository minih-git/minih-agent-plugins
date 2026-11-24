"use strict";

/**
 * The settings the generated sheet writes, normalized once per read.
 *
 * Every value is a user-editable field, so each is clamped rather than trusted:
 * a digest interval of `0` would post a notification per message and a negative
 * one would post on every cycle. The defaults are the same ones the manifest
 * declares, and the plugin runs on them before the user opens Settings at all.
 *
 * The mail provider is not a setting since 0.2.0: each account records its own,
 * because one plugin can hold five mailboxes on five different services. What is
 * left here is what is genuinely shared by every account — who is important, what
 * words matter, how long a digest collects, whether read mail is reported.
 */

const MIN_DIGEST_MINUTES = 1;
const MAX_DIGEST_MINUTES = 24 * 60;

const DEFAULTS = {
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
    importantSenders: typeof source.importantSenders === "string" ? source.importantSenders : "",
    keywords: typeof source.keywords === "string" ? source.keywords : "",
    digestMinutes: clampMinutes(source.digestMinutes),
    // A host sheet that still carries the 0.1.0 provider is ignored here: it
    // named one mailbox, and this release has one provider per account.
    unreadOnly: source.unreadOnly === true,
  };
}

module.exports = { DEFAULTS, MAX_DIGEST_MINUTES, MIN_DIGEST_MINUTES, normalizeSettings };
