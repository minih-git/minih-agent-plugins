"use strict";

/**
 * The plugin's whole data file: one entry per mailbox account.
 *
 * Since 0.2.0 a plugin can hold several mailboxes, and every account has its own
 * cursor, its own reported Message-IDs, its own digest queue, its own errors and
 * its own slice of the panel's message list (`lib/store.js`). Keeping them in one
 * file with one writer is what makes "add a second mailbox" cost nothing: the
 * first account's cursor is a sibling of the second's, not a shared variable that
 * a reconnect can overwrite.
 *
 * The provider is stored here, keyed by the host's instance id, because the
 * credential slot's field set is frozen: the host decides whether an instance is
 * complete by checking that every declared field has a value, so a per-account
 * `provider` field in the slot would have made the account migrated from 0.1.0
 * look incomplete and be dropped from the list.
 *
 * Upgrading from 0.1.0: that release kept one state file (`inbox-mail.json`) for
 * one mailbox and a global `provider` setting. The host turns the old single
 * credential value into the first instance, and the first run of 0.2.0 moves the
 * old state under that instance and remembers the old provider for it. The old
 * file is removed only after the new file is on disk, so a crash between the two
 * writes repeats the same migration instead of losing the cursor.
 */

const store = require("./store");
const providers = require("./providers");

/** This file, inside the plugin's own data directory. */
const FILE = "accounts.json";
/** The 0.1.0 state file, read once during the upgrade. */
const LEGACY_FILE = "inbox-mail.json";
const ROOT_VERSION = 2;
/** The host's own ceiling for one `multiple` slot, and the manifest's. */
const MAX_ACCOUNTS = 5;

function emptyRoot() {
  return { version: ROOT_VERSION, accounts: {}, providers: {} };
}

/** Anything on disk is untrusted: unknown shapes load as empty accounts. */
function normalizeRoot(raw) {
  const base = emptyRoot();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const accounts = raw.accounts && typeof raw.accounts === "object" && !Array.isArray(raw.accounts) ? raw.accounts : {};
  for (const [instanceId, value] of Object.entries(accounts)) {
    if (!instanceId || instanceId.length > 120) continue;
    base.accounts[instanceId] = store.normalizeState(value);
  }
  const stored = raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers) ? raw.providers : {};
  for (const [instanceId, providerId] of Object.entries(stored)) {
    if (!base.accounts[instanceId]) continue;
    if (providers.findProvider(providerId)) base.providers[instanceId] = providerId;
  }
  return base;
}

/** One account's state, created on first use. */
function accountState(root, instanceId) {
  if (!root.accounts[instanceId]) root.accounts[instanceId] = store.emptyState();
  return root.accounts[instanceId];
}

function providerOf(root, instanceId) {
  const id = root.providers[instanceId];
  return providers.findProvider(id) ?? null;
}

/** Record the provider the user (or the domain table) chose for one account. */
function setProvider(root, instanceId, providerId) {
  const provider = providers.findProvider(providerId);
  if (!provider) return null;
  root.providers[instanceId] = provider.id;
  return provider;
}

/**
 * Drop everything belonging to an account the host no longer holds.
 *
 * The host is the owner of the account list: an instance removed in Settings is
 * gone, and keeping its envelopes here would show a mailbox that does not exist
 * any more. Returns the ids that were removed so the caller can close their
 * connections.
 */
function retainAccounts(root, instanceIds) {
  const keep = new Set(instanceIds);
  const removed = [];
  for (const instanceId of Object.keys(root.accounts)) {
    if (keep.has(instanceId)) continue;
    delete root.accounts[instanceId];
    delete root.providers[instanceId];
    removed.push(instanceId);
  }
  return removed;
}

/**
 * Move the 0.1.0 state under the one account the host migrated.
 *
 * Called only when the new file does not exist yet, the old one does, and the
 * host reports exactly one instance: with two accounts there is no honest way to
 * tell which one the old cursor came from, so the old file is left alone rather
 * than guessed at.
 */
function adoptLegacy(root, instanceId, legacyState, providerId) {
  const target = store.normalizeState(legacyState);
  // `version` is this file's business, not one account's.
  delete target.version;
  root.accounts[instanceId] = target;
  const provider = providers.findProvider(providerId);
  if (provider) root.providers[instanceId] = provider.id;
  return target;
}

module.exports = {
  FILE,
  LEGACY_FILE,
  MAX_ACCOUNTS,
  ROOT_VERSION,
  accountState,
  adoptLegacy,
  emptyRoot,
  normalizeRoot,
  providerOf,
  retainAccounts,
  setProvider,
};
