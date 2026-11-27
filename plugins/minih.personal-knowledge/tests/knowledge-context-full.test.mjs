import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createContextVault } from "./helpers/context-fixture.mjs";
import { isolatedHome } from "./helpers/home.mjs";

// Keep the fixture away from the real ~/.personal-knowledge.
await isolatedHome();

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(PLUGIN_ROOT, "tests", "fixtures", "knowledge-context-full.txt");

/**
 * `mode: "full"` is the 0.7.2 behavior exactly (ADR 0004 §1 and §8). The
 * snapshot beside this test was captured from 0.7.2 through the real MCP
 * server, so this compares the rendered text of the whole tool call — routing,
 * budget, and note rendering — rather than one helper's output.
 */
async function contextThroughMcp(arguments_) {
  const { root, vault, config } = await createContextVault();
  const configPath = path.join(root, "repo-map.json");
  await writeFile(configPath, JSON.stringify({ ...config, vaultPath: vault }));
  const embeddingPath = path.join(root, "embedding.json");
  await writeFile(embeddingPath, JSON.stringify({ enabled: false }));

  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "mcp", "server.mjs")], {
    env: {
      ...process.env,
      PERSONAL_KNOWLEDGE_CONFIG: configPath,
      PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG: embeddingPath,
      PERSONAL_KNOWLEDGE_INDEX_DIR: await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-ctx-index-")),
      PERSONAL_KNOWLEDGE_READ_ONLY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const waiters = new Map();
  let pending = "";
  let nextId = 1;
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
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out; stderr: ${stderr.join("")}`)),
        15_000,
      );
      waiters.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const answer = await call("tools/call", { name: "knowledge_context", arguments: arguments_ });
    assert.equal(answer.error, undefined, stderr.join(""));
    assert.notEqual(answer.result?.isError, true, JSON.stringify(answer.result));
    return answer.result;
  } finally {
    child.kill("SIGTERM");
  }
}

test("knowledge_context renders the 0.7.2 text byte for byte", async () => {
  const result = await contextThroughMcp({
    cwd: "/workspace/demo/src",
    topic: "Demo server",
    maxChars: 20_000,
  });
  const expected = await readFile(SNAPSHOT, "utf8");
  assert.equal(result.content[0].text, expected);
  assert.equal(result.structuredContent.notes.length, 4);
});