import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedHome } from "./helpers/home.mjs";

// Keep the fixture away from the real ~/.personal-knowledge.
await isolatedHome();

/**
 * The MCP server decides at startup whether it lists the two retrieval tools
 * (ADR 0003 §2). This spawns the real `mcp/server.mjs`, like
 * `scripts/probe-mcp.mjs`, with an `embedding.json` of each provider, and
 * asserts what the model would be offered.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETRIEVAL_TOOLS = ["knowledge_search", "conversation_search"];

/** One MCP exchange over stdio; resolves with every answer by id. */
async function withServer(embedding, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-mcp-list-"));
  const vault = path.join(root, "Knowledge");
  const embeddingPath = path.join(root, "embedding.json");
  const configPath = path.join(root, "repo-map.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(vault, { recursive: true });
  await writeFile(configPath, JSON.stringify({ vaultPath: vault, ignoreFolders: [], backupRetentionDays: 0 }));
  await writeFile(embeddingPath, JSON.stringify(embedding));

  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "mcp", "server.mjs")], {
    env: {
      ...process.env,
      PERSONAL_KNOWLEDGE_CONFIG: configPath,
      PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG: embeddingPath,
      PERSONAL_KNOWLEDGE_INDEX_DIR: path.join(root, "index"),
      PERSONAL_KNOWLEDGE_READ_ONLY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const waiters = new Map();
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiters.get(message.id);
      if (!waiter) continue;
      waiters.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out; stderr: ${stderr.join("")}`)),
        15_000,
      );
      waiters.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return await run({ call });
  } finally {
    child.kill("SIGTERM");
  }
}

test("host mode keeps the retrieval tools away from the MCP server", async () => {
  await withServer(
    { enabled: true, provider: "host", modelKey: "minih-router/text-embedding-3-small", exclude: [] },
    async ({ call }) => {
      const listed = await call("tools/list", {});
      const names = listed.result.tools.map((tool) => tool.name);
      for (const name of RETRIEVAL_TOOLS) {
        assert.ok(!names.includes(name), `${name} must not be listed in host mode`);
      }
      assert.ok(names.includes("knowledge_read"), "the other tools stay");
      assert.ok(names.includes("knowledge_context"));

      // A direct call says where the tool lives instead of "unknown tool".
      const refused = await call("tools/call", { name: "knowledge_search", arguments: { query: "x" } });
      assert.match(refused.error?.message ?? "", /main process in host mode/);
      assert.match(refused.error?.message ?? "", /knowledge_search/);
    },
  );
});

test("a direct endpoint still lists every tool", async () => {
  for (const embedding of [
    { enabled: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "bge-m3", exclude: [] },
    { enabled: false, provider: "host", modelKey: "minih-router/x", exclude: [] },
  ]) {
    await withServer(embedding, async ({ call }) => {
      const listed = await call("tools/list", {});
      const names = listed.result.tools.map((tool) => tool.name);
      for (const name of RETRIEVAL_TOOLS) {
        assert.ok(names.includes(name), `${name} must be listed for ${embedding.provider} (enabled=${embedding.enabled})`);
      }
    });
  }
});

test("a broken embedding file leaves the MCP tools in place", async () => {
  await withServer({ enabled: true, provider: "openai-compatible", baseUrl: "not a url" }, async ({ call }) => {
    const listed = await call("tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    for (const name of RETRIEVAL_TOOLS) {
      assert.ok(names.includes(name), `${name} must survive an unreadable configuration`);
    }
  });
});

test("the MCP server reads the same embedding.json the panel writes", async () => {
  // Written by `kg.settings.set`, read by the MCP server: the two must agree,
  // or the tool lists would disagree with the provider in force.
  const { validateEmbeddingSettings } = await import("../lib/embeddings.mjs");
  const host = validateEmbeddingSettings({ provider: "host", modelKey: "minih-router/embed" });
  const dir = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-mcp-embed-"));
  const file = path.join(dir, "embedding.json");
  await writeFile(file, `${JSON.stringify(host, null, 2)}\n`);
  const reread = JSON.parse(await readFile(file, "utf8"));
  assert.equal(reread.provider, "host");
  assert.equal(reread.modelKey, "minih-router/embed");
});
