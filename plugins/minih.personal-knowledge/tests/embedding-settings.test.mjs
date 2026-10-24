import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

import {
  EMBEDDING_DEFAULTS,
  loadEmbeddingSettings,
  resolveApiKey,
  validateEmbeddingSettings,
} from "../lib/embeddings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const FAKE_SERVERS = [];
after(() => {
  for (const server of FAKE_SERVERS) {
    server.closeAllConnections?.();
    server.close();
  }
});

test("a missing settings file yields exactly the documented defaults", async () => {
  const settings = await loadEmbeddingSettings(path.join(os.tmpdir(), "pk-missing-embedding.json"));
  assert.deepEqual(settings, { ...EMBEDDING_DEFAULTS });
});

test("settings rules reject every §6.1 violation and keep valid remote settings", () => {
  assert.throws(() => validateEmbeddingSettings({ baseUrl: "https://x.example.com/v1" }), /EMBEDDING_NOT_LOOPBACK/);
  assert.throws(() => validateEmbeddingSettings({ baseUrl: "http://x.example.com/v1", allowRemote: true }), /EMBEDDING_INSECURE_URL/);
  assert.throws(() => validateEmbeddingSettings({ apiKeyEnv: "9BAD" }), /EMBEDDING_CONFIG_INVALID/);
  assert.throws(() => validateEmbeddingSettings({ exclude: ["a/../b"] }), /EMBEDDING_CONFIG_INVALID/);
  assert.throws(() => validateEmbeddingSettings({ exclude: ["/abs"] }), /EMBEDDING_CONFIG_INVALID/);
  assert.throws(() => validateEmbeddingSettings("not an object"), /EMBEDDING_CONFIG_INVALID/);
  const ok = validateEmbeddingSettings({
    baseUrl: "https://rc.hmini.org/v1",
    allowRemote: true,
    provider: "openai-compatible",
    model: "text-embedding-3-small",
    apiKeyEnv: "MINIH_ROUTER_ACCESS_KEY",
    exclude: ["04 Archive", "05 Daily"],
  });
  assert.equal(ok.allowRemote, true);
  assert.deepEqual(ok.exclude, ["04 Archive", "05 Daily"]);
});

test("the API key resolves from the process environment first", async () => {
  const found = await resolveApiKey("PK_SETTINGS_TEST_KEY", { env: { PK_SETTINGS_TEST_KEY: "from-env" } });
  assert.deepEqual(found, { status: "found", value: "from-env" });
  const notRequired = await resolveApiKey("", { env: {} });
  assert.equal(notRequired.status, "not-required");
});

test("the API key falls back to the shell rc of a temporary HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pk-shell-home-"));
  await writeFile(path.join(home, ".zshrc"), "export PK_RC_TEST_KEY=from-rc\n");
  const savedShell = process.env.SHELL;
  process.env.SHELL = "/bin/zsh";
  try {
    const result = await resolveApiKey("PK_RC_TEST_KEY", { env: {}, home });
    assert.deepEqual(result, { status: "found", value: "from-rc" });
  } finally {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  }
});

test("a key that exists nowhere reports missing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pk-shell-home-"));
  const result = await resolveApiKey("PK_ABSENT_KEY", { env: {}, home });
  assert.deepEqual(result, { status: "missing", value: null });
});

/** Fixture vault + stubbed host for the plugin backend channels. */
async function loadBackend() {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-settings-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "00 Inbox"), { recursive: true });
  await writeFile(
    path.join(vault, "Project - Demo.md"),
    "---\ntitle: Project - Demo\ntype: project\nstatus: active\nrepo: /repo/demo\n---\n# Demo\n",
  );
  const emptyConfig = path.join(root, "repo-map.json");
  await writeFile(emptyConfig, "{}\n");
  process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
  process.env.PERSONAL_KNOWLEDGE_CONFIG = emptyConfig;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = path.join(root, "index");
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = path.join(root, "embedding.json");
  await writeFile(process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG, '{"enabled": false}\n');
  delete process.env.PERSONAL_KNOWLEDGE_READ_ONLY;
  globalThis.pi = {};
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  const backend = require(path.join(ROOT, "main.js"));
  return { root, vault, backend, settingsPath: process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG };
}

test("kg.settings.get returns settings, key status, index stats, and the send estimate", async () => {
  const { backend, settingsPath } = await loadBackend();
  process.env.PK_GET_KEY = "value-hidden-from-payload";
  await writeFile(
    settingsPath,
    `${JSON.stringify({ enabled: true, provider: "openai-compatible", baseUrl: "https://rc.example.com/v1", allowRemote: true, model: "embed-x", apiKeyEnv: "PK_GET_KEY" })}\n`,
  );
  try {
    const result = await backend.onPanelInvoke("kg.settings.get", {});
    assert.equal(result.settings.provider, "openai-compatible");
    assert.equal(result.settings.apiKeyEnv, "PK_GET_KEY");
    assert.ok(!JSON.stringify(result).includes("value-hidden-from-payload"), "the key value never appears in the payload");
    assert.equal(result.apiKeyStatus, "found");
    assert.ok(result.estimate.chunks >= 1);
    assert.ok(result.estimate.characters >= 1);
    assert.equal(result.index, null, "no index built yet");
  } finally {
    delete process.env.PK_GET_KEY;
  }
});

test("kg.settings.set validates, writes atomically with mode 0600, and hot-reloads the MCP side", async () => {
  const { backend, settingsPath } = await loadBackend();
  const saved = await backend.onPanelInvoke("kg.settings.set", {
    embedding: { enabled: false, exclude: ["04 Archive"] },
  });
  assert.equal(saved.settings.enabled, false);
  const info = await stat(settingsPath);
  assert.equal(info.mode & 0o777, 0o600, "the settings file is private");
  const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(onDisk.exclude, ["04 Archive"]);
  await assert.rejects(
    backend.onPanelInvoke("kg.settings.set", { embedding: { baseUrl: "http://remote.example.com/v1", allowRemote: true } }),
    /EMBEDDING_INSECURE_URL/,
  );
});

test("kg.settings.test reports ok with dims, and reason codes without leaking the key", async () => {
  const { backend } = await loadBackend();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const auth = request.headers.authorization ?? "";
      if (auth !== "Bearer sk-good-key-0001") {
        response.writeHead(401).end(JSON.stringify({ error: "bad key" }));
        return;
      }
      if (request.url === "/embeddings" && request.method === "POST") {
        const input = JSON.parse(body).input ?? [];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [1, 0, 0.5] })) }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  FAKE_SERVERS.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Loopback http is allowed by rule (only non-loopback requires https), so
  // the fake endpoint is reachable through its plain local URL.
  const localUrl = `http://127.0.0.1:${server.address().port}`;

  process.env.PK_GOOD_KEY = "sk-good-key-0001";
  try {
    const ok = await backend.onPanelInvoke("kg.settings.test", {
      embedding: { enabled: true, provider: "openai-compatible", baseUrl: localUrl, model: "embed-x", apiKeyEnv: "PK_GOOD_KEY" },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.dims, 3);
    assert.ok(typeof ok.latencyMs === "number");
  } finally {
    process.env.PK_GOOD_KEY = "sk-wrong-key-9999";
  }

  try {
    const bad = await backend.onPanelInvoke("kg.settings.test", {
      embedding: { enabled: true, provider: "openai-compatible", baseUrl: localUrl, model: "embed-x", apiKeyEnv: "PK_GOOD_KEY" },
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "EMBEDDING_AUTH_FAILED");
    assert.ok(!JSON.stringify(bad).includes("sk-wrong-key-9999"), "the key value never appears in the result");
  } finally {
    delete process.env.PK_GOOD_KEY;
  }

  const missing = await backend.onPanelInvoke("kg.settings.test", {
    embedding: { enabled: true, provider: "openai-compatible", baseUrl: localUrl, model: "embed-x", apiKeyEnv: "PK_ABSENT_KEY" },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "EMBEDDING_KEY_MISSING");

  const invalid = await backend.onPanelInvoke("kg.settings.test", {
    embedding: { enabled: true, provider: "openai-compatible", baseUrl: "http://remote.example.com/v1", allowRemote: true, model: "embed-x" },
  });
  assert.equal(invalid.reason, "EMBEDDING_INSECURE_URL");
});

test("kg.settings.set creates the settings directory privately when it is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-settings-dir-"));
  const nested = path.join(root, "pk-settings", "embedding.json");
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = nested;
  globalThis.pi = {};
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  const backend = require(path.join(ROOT, "main.js"));
  await backend.onPanelInvoke("kg.settings.set", { embedding: { enabled: false } });
  const dirInfo = await stat(path.dirname(nested));
  assert.equal(dirInfo.mode & 0o777, 0o700);
  const fileInfo = await stat(nested);
  assert.equal(fileInfo.mode & 0o777, 0o600);
});
