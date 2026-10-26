import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isSelectableModel, modelOptions, resolveModel } = require("../lib/models.js");

const models = [
  { key: "openai/gpt-5", label: "gpt-5 (OpenAI)", isDefault: false },
  { key: "minimax/m2", label: "m2 (MiniMax)", isDefault: true },
  { key: "anthropic/haiku", label: "haiku (Anthropic)", isDefault: false, alias: "快速" },
];

test("a configured model that exists is the one used", () => {
  assert.equal(resolveModel(models, "openai/gpt-5").model.key, "openai/gpt-5");
  assert.equal(resolveModel(models, "  openai/gpt-5  ").note, "");
});

test("with nothing configured the host default model is used, with no note", () => {
  const { model, note } = resolveModel(models, "");
  assert.equal(model.key, "minimax/m2");
  assert.equal(note, "");
});

test("a configured model that is gone degrades to the default and says so", () => {
  const { model, note } = resolveModel(models, "gone/model");
  assert.equal(model.key, "minimax/m2");
  assert.match(note, /配置的模型已不可用/);
});

test("no models at all is null, not a crash", () => {
  assert.deepEqual(resolveModel([], "openai/gpt-5"), { model: null, note: "" });
  assert.deepEqual(resolveModel(undefined, "openai/gpt-5"), { model: null, note: "" });
});

test("the dropdown lists the default first and keeps an alias visible", () => {
  const options = modelOptions(models);
  assert.deepEqual(options.map((option) => option.key), ["minimax/m2", "openai/gpt-5", "anthropic/haiku"]);
  const haiku = options.find((option) => option.key === "anthropic/haiku");
  assert.match(haiku.label, /^快速 · haiku/);
  assert.equal(options[0].isDefault, true);
});

test("an empty key means the default; anything else must be in the list", () => {
  assert.equal(isSelectableModel(models, ""), true);
  assert.equal(isSelectableModel(models, "openai/gpt-5"), true);
  assert.equal(isSelectableModel(models, "gone/model"), false);
});