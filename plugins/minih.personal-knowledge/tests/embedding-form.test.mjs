import assert from "node:assert/strict";
import test from "node:test";

import { STRINGS } from "../view/strings.js";
import {
  EMBEDDING_REASON_KEYS,
  describeEmbeddingError,
  embeddingModelChoices,
  embeddingModelLabel,
  inspectEndpointForm,
  parseBaseUrl,
} from "../view/embedding-form.mjs";

/**
 * The panel decides before it sends (ADR 0003 §4.3): an address that cannot be
 * used explains itself while it is typed, and Save/Test focus the control the
 * message is about instead of making a request.
 */

test("a loopback address needs nothing", () => {
  const loopback = inspectEndpointForm({ provider: "ollama", baseUrl: "http://127.0.0.1:11434" });
  assert.equal(loopback.blockedReason, null);
  assert.equal(loopback.hint, null);
  assert.equal(loopback.remote, false);

  assert.deepEqual(parseBaseUrl("http://localhost:11434"), {
    protocol: "http:",
    hostname: "localhost",
    loopback: true,
  });
});

test("a remote address without allowRemote is blocked and points at the checkbox", () => {
  const state = inspectEndpointForm({ provider: "openai-compatible", baseUrl: "https://api.example.com/v1" });
  assert.equal(state.blockedReason, "EMBEDDING_NOT_LOOPBACK");
  assert.equal(state.hint, "settingsHintNotLoopback");
  assert.equal(state.focus, "settings-allow-remote");
  assert.equal(state.highlightAllowRemote, true);
  assert.equal(state.remote, true);
});

test("a remote https address with allowRemote is allowed", () => {
  const state = inspectEndpointForm({
    provider: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    allowRemote: true,
  });
  assert.equal(state.blockedReason, null);
  assert.equal(state.highlightAllowRemote, false);
  assert.equal(state.hint, "settingsHintRemoteOk");
});

test("a remote http address is blocked even with allowRemote", () => {
  const state = inspectEndpointForm({
    provider: "openai-compatible",
    baseUrl: "http://api.example.com/v1",
    allowRemote: true,
  });
  assert.equal(state.blockedReason, "EMBEDDING_INSECURE_URL");
  assert.equal(state.hint, "settingsHintInsecureUrl");
  assert.equal(state.focus, "settings-baseurl");
});

test("an empty or malformed address explains itself without blocking typing", () => {
  const empty = inspectEndpointForm({ provider: "openai-compatible", baseUrl: "" });
  assert.equal(empty.blockedReason, null, "an empty field is not an error yet");
  assert.equal(empty.hint, "settingsHintUrlEmpty");

  const malformed = inspectEndpointForm({ provider: "openai-compatible", baseUrl: "api.example.com" });
  assert.equal(malformed.blockedReason, "EMBEDDING_CONFIG_INVALID");
  assert.equal(malformed.hint, "settingsHintUrlInvalid");

  const wrongScheme = inspectEndpointForm({ provider: "openai-compatible", baseUrl: "ftp://127.0.0.1/x" });
  assert.equal(parseBaseUrl("ftp://127.0.0.1/x"), null);
  assert.equal(wrongScheme.blockedReason, "EMBEDDING_CONFIG_INVALID");
});

test("host mode has no endpoint to check", () => {
  const state = inspectEndpointForm({ provider: "host", baseUrl: "", allowRemote: false });
  assert.equal(state.blockedReason, null);
  assert.equal(state.hint, null);
  assert.equal(state.highlightAllowRemote, false);
});

test("every code the backend can report has a sentence in both languages", () => {
  const codes = [
    ...Object.keys(EMBEDDING_REASON_KEYS),
    "EMBEDDING_CONFIG_INVALID",
    "OLLAMA_UNREACHABLE",
    "EMBED_FAILED",
  ];
  for (const code of codes) {
    const { messageKey } = describeEmbeddingError(code);
    assert.ok(messageKey, `${code} has no message key`);
    for (const language of ["zh-CN", "en"]) {
      assert.equal(typeof STRINGS[language][messageKey], "string", `${language} is missing ${messageKey}`);
      assert.ok(STRINGS[language][messageKey].length > 0);
    }
  }
});

test("a code is read from an error, from a prefixed message, and from a reason", () => {
  assert.equal(describeEmbeddingError({ code: "EMBEDDING_NOT_LOOPBACK" }).messageKey, "embedReasonNotLoopback");
  assert.equal(
    describeEmbeddingError("EMBEDDING_INSECURE_URL: a non-loopback baseUrl must use https").messageKey,
    "embedReasonInsecureUrl",
  );
  assert.equal(describeEmbeddingError({ reason: "OLLAMA_UNREACHABLE" }).messageKey, "embedReasonOllamaUnreachable");
  // An unknown code keeps the text and still shows something readable.
  const unknown = describeEmbeddingError({ code: "SOMETHING_NEW", message: "the host said no" });
  assert.equal(unknown.code, "SOMETHING_NEW");
  assert.equal(unknown.messageKey, null);
});

test("host model options read provider · model and say when the list is empty", () => {
  const answer = {
    hostSupported: true,
    models: [
      { key: "minih-router/text-embedding-3-small", label: "text-embedding-3-small", providerName: "Minih Router" },
      { key: "openai/text-embedding-3-large", label: "" },
    ],
  };
  const choices = embeddingModelChoices(answer);
  assert.equal(choices.selectable, true);
  assert.equal(choices.reasonKey, null);
  assert.equal(choices.models[0].optionLabel, "Minih Router · text-embedding-3-small");
  assert.equal(choices.models[1].optionLabel, "openai · text-embedding-3-large");
  assert.equal(embeddingModelLabel({ key: "a/b/c" }), "a · b/c");

  const empty = embeddingModelChoices({ hostSupported: true, models: [] });
  assert.deepEqual(empty.models, []);
  assert.equal(empty.reasonKey, "settingsHostEmbeddingEmpty");
  assert.equal(empty.selectable, true, "the option stays selectable so the hint is visible");

  const unsupported = embeddingModelChoices({ hostSupported: false, models: [] });
  assert.equal(unsupported.reasonKey, "settingsHostEmbeddingUnsupported");
  assert.equal(unsupported.selectable, false, "an old host disables the option");

  for (const reasonKey of ["settingsHostEmbeddingEmpty", "settingsHostEmbeddingUnsupported"]) {
    for (const language of ["zh-CN", "en"]) {
      assert.ok(STRINGS[language][reasonKey], `${language} is missing ${reasonKey}`);
    }
  }
});

test("the panel markup has the host option, the model dropdown and the hint slot", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const html = await readFile(path.join(root, "view", "settings.html"), "utf8");
  for (const id of [
    "opt-provider-host",
    "group-settings-host-model",
    "settings-host-model",
    "hint-settings-host-model",
    "group-settings-baseurl",
    "settings-endpoint-hint",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /<option id="opt-provider-host" value="host">/);

  const source = await readFile(path.join(root, "view", "settings-page.js"), "utf8");
  assert.match(source, /inspectEndpointForm/, "the form uses the shared rules");
  assert.match(source, /kg\.models\.listEmbedding/, "the dropdown asks for embedding models");
  assert.match(source, /feedbackError/, "reasons are shown as sentences");
  assert.doesNotMatch(
    source,
    /this\.feedback\(\s*error\?\.message/,
    "no raw error text reaches the panel",
  );
});
