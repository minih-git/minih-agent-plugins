import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The manifest this repository publishes.
 *
 * The host validates a manifest again on install, so this is not a second
 * validator: it pins the decisions that would otherwise drift silently — the
 * sidebar placement, the permission set, the two contract locales, and the flat
 * `safetyNotes` that `scripts/build-catalog.mjs` puts in `catalog.json`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const exists = (file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true;

test("the plugin is published as minih.terminal", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "minih.terminal");
  assert.equal(manifest.name, "Terminal");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, "main.js");
  assert.ok(exists(manifest.main), "the entry point must be in the tree");
});

test("it is a sidebar-placed view, not a work-panel tab", () => {
  const views = manifest.contributes.views;
  assert.equal(views.length, 1);
  const [view] = views;
  assert.equal(view.id, "terminal");
  assert.equal(view.placement, "sidebar");
  assert.equal(view.icon, "terminal");
  assert.ok(exists(view.entry), `view entry missing: ${view.entry}`);
  assert.deepEqual(Object.keys(view.title).sort(), ["en", "zh-CN"]);
});

test("it asks for the view, the directory picker, and both clipboard directions", () => {
  // Copy needs write, paste needs read: macOS sends Cmd+C / Cmd+V to the app's
  // Edit menu, which copies a DOM selection this page does not have, so the
  // terminal's own menu and chords are the only working paths.
  assert.deepEqual([...manifest.permissions].sort(), [
    "clipboard.read",
    "clipboard.write",
    "fs.read",
    "ui.view",
  ]);
  // A terminal is a manual surface: no agent tools, extensions, MCP servers,
  // prompt injection, or background services.
  for (const forbidden of [
    "agentTools",
    "agentExtensions",
    "mcpServers",
    "services",
    "sessionSources",
    "composerTransforms",
  ]) {
    assert.equal(manifest.contributes[forbidden], undefined, forbidden);
  }
  assert.equal(manifest.ui, undefined, "no detached panel window");
});

test("both contract locales state that it runs local commands with the user's privileges", () => {
  for (const locale of ["en", "zh-CN"]) {
    const entry = manifest.i18n[locale];
    assert.equal(typeof entry.name, "string", locale);
    assert.ok(entry.name.trim().length > 0, locale);
    assert.ok(entry.safetyNotes.trim().length > 40, `${locale} note must say something real`);
    assert.match(entry.safetyNotes, locale === "en" ? /privileges|permissions/i : /权限/);
  }
  // The catalog has no i18n resolution of its own: it publishes this field.
  assert.equal(manifest.safetyNotes, manifest.i18n.en.safetyNotes);
});

test("the app versions it supports are declared the way both readers expect", () => {
  assert.equal(typeof manifest.engines.minihAgent, "string");
  assert.equal(typeof manifest.engines.piDesktop, "string");
  assert.equal(manifest.activationEvents.includes("onStartup"), true);
});

test("the default terminal is configured in settings, not in the start dialog", () => {
  const settings = manifest.contributes.settings ?? [];
  const byKey = Object.fromEntries(settings.map((setting) => [setting.key, setting]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    "copyOnSelect",
    "defaultDirectory",
    "defaultShell",
    "openOnView",
  ]);
  // Copy-on-select overwrites the clipboard on every drag, so it is opt-in.
  assert.equal(byKey.copyOnSelect.type, "boolean");
  assert.equal(byKey.copyOnSelect.default, false);
  // Opening the view means asking for a terminal: the shipped answer starts one.
  assert.equal(byKey.openOnView.type, "boolean");
  assert.equal(byKey.openOnView.default, true);
  // `auto` keeps working on a machine where the named shell is not installed.
  assert.equal(byKey.defaultShell.type, "select");
  assert.equal(byKey.defaultShell.default, "auto");
  assert.ok(
    byKey.defaultShell.enum.some((option) => option.value === "auto"),
    "auto must stay selectable",
  );
  assert.equal(byKey.defaultDirectory.type, "string");
  assert.equal(byKey.defaultDirectory.default, "");
  for (const setting of settings) {
    // The generated sheet does not localize titles, so they stay plain strings.
    assert.equal(typeof setting.title, "string", setting.key);
    assert.ok(setting.title.trim().length > 0, setting.key);
  }
});
