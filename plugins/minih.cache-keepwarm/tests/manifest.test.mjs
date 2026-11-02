import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The manifest this repository publishes.
 *
 * The host validates a manifest again on install, so this is not a second
 * validator: it pins the decisions that would otherwise drift silently — the
 * one paid permission, the renderer surface, the two contract locales, and the
 * settings a user can use to spend less.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const exists = (file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true;

test("the plugin is published as minih.cache-keepwarm", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "minih.cache-keepwarm");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, "main.js");
  assert.ok(exists(manifest.main), "the entry point must be in the tree");
  assert.ok(exists(manifest.renderer), "the renderer entry must be in the tree");
});

test("it asks for the paid keep-warm grant and nothing broader", () => {
  // No session-read permission: the model a session runs arrives on the
  // keep-warm answer itself, which is the only place a plugin may learn it.
  assert.deepEqual([...manifest.permissions].sort(), [
    "renderer.extension",
    "session.keepWarm",
  ]);
});

test("the renderer entry can only call its own plugin", () => {
  assert.deepEqual(manifest.rendererActions, ["plugin.call"]);
  assert.deepEqual([...manifest.rendererCallMethods].sort(), ["status", "toggle"]);
});

test("it starts with the app, because a timer that waits for a window is not a schedule", () => {
  assert.deepEqual(manifest.activationEvents, ["onStartup"]);
});

test("every spend limit the design promised is a setting", () => {
  const settings = new Map(manifest.contributes.settings.map((entry) => [entry.key, entry]));
  assert.equal(settings.get("intervalMinutes").default, 50);
  assert.equal(settings.get("maxConsecutive").default, 4);
  assert.equal(settings.get("dailyCostLimitUsd").default, 1);
  assert.equal(settings.get("modelScope").default, "anthropic");
  assert.deepEqual(
    settings.get("modelScope").enum.map((option) => option.value),
    ["anthropic", "anthropicOpenai", "all"],
  );
});

test("it declares the app version that actually has the API", () => {
  // 1.2.0 is the first release with `session.keepWarm`; declaring 1.1.5 would let
  // an install through on an app that cannot answer the call.
  assert.equal(manifest.engines.minihAgent, ">=1.2.0");
  assert.equal(manifest.engines.piDesktop, ">=1.2.0");
  assert.match(manifest.i18n.en.note, />=1\.2\.0/);
});

test("both contract locales are published, and the flat notes are the English ones", () => {
  assert.ok(manifest.i18n.en?.safetyNotes);
  assert.ok(manifest.i18n["zh-CN"]?.safetyNotes);
  assert.equal(manifest.safetyNotes, manifest.i18n.en.safetyNotes);
});
