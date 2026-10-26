import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const { rendererMethods } = require("../main.js");

/** The host's `PLUGIN_RENDERER_ACTIONS`, which the SDK owns and this plugin may not exceed. */
const KNOWN_ACTIONS = [
  "plugin.call",
  "composer.insertText",
  "composer.readDraft",
  "composer.replaceDraft",
  "attachments.add",
  "attachments.list",
  "attachments.remove",
];

test("the id matches the directory and the entry files exist", () => {
  assert.equal(manifest.id, "minih.selection-translate");
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const field of ["main", "renderer"]) {
    const path = join(root, manifest[field]);
    assert.ok(existsSync(path), `${field} file is missing: ${manifest[field]}`);
  }
});

test("a renderer module declares the permission, the entry and both whitelists", () => {
  assert.match(manifest.renderer, /\.m?js$/);
  assert.ok(manifest.permissions.includes("renderer.extension"));
  assert.ok(Array.isArray(manifest.rendererActions));
  for (const action of manifest.rendererActions) {
    assert.ok(KNOWN_ACTIONS.includes(action), `unknown renderer action: ${action}`);
  }
});

test("every declared call method is implemented, and nothing else is reachable", () => {
  assert.deepEqual([...manifest.rendererCallMethods].sort(), Object.keys(rendererMethods).sort());
});

test("the permissions are exactly what the code uses", () => {
  // renderer.extension: the renderer module. agent.complete: the one model call.
  // models.list: the dropdown. clipboard.write: the copy fallback.
  assert.deepEqual([...manifest.permissions].sort(), [
    "agent.complete",
    "clipboard.write",
    "models.list",
    "renderer.extension",
  ]);
});

test("settings are declarative and valid for the host", () => {
  const settings = manifest.contributes.settings;
  assert.equal(settings.length, 1);
  const [model] = settings;
  assert.equal(model.key, "model");
  assert.equal(model.type, "string");
  assert.match(model.key, /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/);
});

test("the marketplace-facing text is present in both languages", () => {
  for (const locale of ["en", "zh-CN"]) {
    const entry = manifest.i18n[locale];
    assert.ok(entry?.name && entry?.description && entry?.safetyNotes, `missing i18n.${locale}`);
  }
});