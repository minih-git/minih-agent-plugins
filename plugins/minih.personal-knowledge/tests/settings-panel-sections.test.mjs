import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { STRINGS } from "../view/strings.js";
import { conversationsView, profileView } from "../view/settings-page.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the two new settings sections exist in the panel markup", async () => {
  const html = await readFile(path.join(PLUGIN_ROOT, "view", "settings.html"), "utf8");
  for (const id of [
    "sec-conversations",
    "sec-profile",
    "nav-conversations",
    "nav-profile",
    "conversations-state-badge",
    "conversations-archive-badge",
    "conversations-where-hint",
    "conversations-synced-value",
    "conversations-counts-value",
    "conversations-error-value",
    "conversations-device",
    "btn-conversations-sync",
    "btn-conversations-save-device",
    "profile-enabled",
    "profile-model",
    "profile-last-run-value",
    "profile-next-run-value",
    "profile-candidate-value",
    "btn-profile-copy-link",
    "btn-profile-save",
    "btn-profile-run",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // The order the user sees: archive then profile, both after memory.
  const memory = html.indexOf('id="sec-memory"');
  const conversations = html.indexOf('id="sec-conversations"');
  const profile = html.indexOf('id="sec-profile"');
  assert.ok(memory < conversations && conversations < profile);
});

test("both languages define every string the two sections use", async () => {
  const source = await readFile(path.join(PLUGIN_ROOT, "view", "settings-page.js"), "utf8");
  const used = new Set();
  for (const match of source.matchAll(/\bt\("((?:conversations|profile)[A-Za-z]+)"/g)) used.add(match[1]);
  assert.ok(used.size > 20, `expected the sections to use their strings, found ${used.size}`);
  for (const language of ["zh-CN", "en"]) {
    const missing = [...used].filter((key) => typeof STRINGS[language][key] !== "string");
    assert.deepEqual(missing, [], `${language} is missing ${missing.join(", ")}`);
  }
  const zh = Object.keys(STRINGS["zh-CN"]).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(zh, en, "the two dictionaries carry the same keys");
});

test("an archive switch that is on renders as healthy and hides the where-to-enable hint", () => {
  const view = conversationsView({
    state: "ok",
    enabled: true,
    device: "mac-a",
    finishedAt: "2026-11-09T06:40:12.000Z",
    written: 3,
    removed: 1,
    skipped: 12,
    error: null,
  });
  assert.equal(view.stateKey, "conversationsStateOk");
  assert.equal(view.stateTone, "ok");
  assert.equal(view.archiveOn, true);
  assert.equal(view.showWhereHint, false);
  assert.deepEqual(view.counts, { written: 3, removed: 1, skipped: 12 });
  assert.equal(view.device, "mac-a");
  assert.equal(view.error, "");
});

test("a switch that is off renders the host location hint and never claims a sync", () => {
  const view = conversationsView({ state: "disabled", enabled: false, device: "mac-a", finishedAt: null });
  assert.equal(view.stateKey, "conversationsStateDisabled");
  assert.equal(view.archiveOn, false);
  assert.equal(view.archiveTone, "warn");
  assert.equal(view.showWhereHint, true);
  assert.equal(view.syncedAt, null);
});

test("an unknown or failing syncer stays neutral, and an error code is shown alone", () => {
  const stopped = conversationsView({ state: "stopped", device: "mac-a" });
  assert.equal(stopped.archiveKnown, false);
  assert.equal(stopped.archiveTone, "muted");
  assert.equal(stopped.showWhereHint, true);

  const failed = conversationsView({ state: "error", enabled: true, error: "CONVERSATION_API_UNAVAILABLE" });
  assert.equal(failed.stateTone, "error");
  assert.equal(failed.stateKey, "conversationsStateError");
  assert.equal(failed.error, "CONVERSATION_API_UNAVAILABLE", "only the code, never content");
});

test("profile candidates start disabled and cannot run without a model", () => {
  const off = profileView(null);
  assert.equal(off.enabled, false);
  assert.equal(off.canRun, false);
  assert.equal(off.runBlockedReason, "disabled");

  const onWithoutModel = profileView({ settings: { enabled: true, modelKey: null } });
  assert.equal(onWithoutModel.canRun, false);
  assert.equal(onWithoutModel.runBlockedReason, "model");

  const ready = profileView({ settings: { enabled: true, modelKey: "minih-router/deepseek-flash" } });
  assert.equal(ready.canRun, true);
  assert.equal(ready.runBlockedReason, null);

  const busy = profileView({ settings: { enabled: true, modelKey: "m" } }, { busy: true });
  assert.equal(busy.canRun, false, "a run in flight disables the button");
});

test("the weekly limit shows the next allowed run and the latest candidate", () => {
  const limited = profileView({
    settings: { enabled: true, modelKey: "m" },
    lastRunAt: "2026-11-08T07:10:00.000Z",
    lastCandidate: "00 Inbox/画像候选 2026-11-08.md",
    due: { due: false, reason: "TOO_SOON", nextEligibleAt: "2026-11-15T07:10:00.000Z" },
  });
  assert.equal(limited.nextEligibleAt, "2026-11-15T07:10:00.000Z");
  assert.equal(limited.candidate, "00 Inbox/画像候选 2026-11-08.md");
  assert.equal(limited.error, "");

  const due = profileView({ settings: { enabled: true, modelKey: "m" }, due: { due: true } });
  assert.equal(due.nextEligibleAt, null, "no countdown while a run is allowed");

  const failed = profileView({ settings: { enabled: true, modelKey: "m" }, lastError: "MODEL_FAILED" });
  assert.equal(failed.error, "MODEL_FAILED");
});
