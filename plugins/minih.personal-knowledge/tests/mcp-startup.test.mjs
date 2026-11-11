import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedHome } from "./helpers/home.mjs";

const home = await isolatedHome();
const server = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const preload = new URL("./helpers/held-vault-init.mjs", import.meta.url).href;

async function startServer(t) {
  const root = await mkdtemp(path.join(home, "mcp-startup-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  await writeFile(path.join(vault, "Note.md"), "---\ntitle: Note\ntype: topic\n---\n# Note\nReady after scanning.\n");
  const config = path.join(root, "config.json");
  const embedding = path.join(root, "embedding.json");
  await writeFile(config, JSON.stringify({ vaultPath: vault, ignoreFolders: [] }));
  await writeFile(embedding, JSON.stringify({ enabled: false }));
  const child = fork(server, [], {
    execArgv: ["--import", preload],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PERSONAL_KNOWLEDGE_CONFIG: config,
      PERSONAL_KNOWLEDGE_VAULT: vault,
      PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG: embedding,
      PERSONAL_KNOWLEDGE_INDEX_DIR: path.join(root, "index"),
    },
  });
  const pending = new Map();
  const scans = [];
  const scanWaiters = [];
  let sequence = 0;
  let buffer = "";
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.on("message", (message) => {
    if (message?.phase !== "scan") return;
    const waiter = scanWaiters.shift();
    if (waiter) waiter(message);
    else scans.push(message);
  });
  t.after(async () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("MCP test disposed"));
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} blocked by vault startup: ${diagnostics}`));
    }, 2000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const nextScan = () => scans.length ? Promise.resolve(scans.shift()) : new Promise((resolve) => scanWaiters.push(resolve));
  const release = (scan, action = "release") => child.send({ attempt: scan.attempt, action });
  const setReadOnly = (readOnly) => writeFile(config, JSON.stringify({ vaultPath: vault, ignoreFolders: [], readOnly }));
  return { call, nextScan, release, setReadOnly };
}

test("MCP handshake, tool discovery and ping do not wait for a held vault scan", async (t) => {
  const { call, nextScan, release } = await startServer(t);
  const initialized = await call("initialize", { protocolVersion: "2025-06-18" });
  assert.ok(initialized.result.serverInfo);
  const listed = await call("tools/list");
  assert.ok(listed.result.tools.some((tool) => tool.name === "knowledge_read"));
  const first = call("tools/call", { name: "knowledge_read", arguments: { note: "Note.md" } });
  const scan = await nextScan();
  const second = call("tools/call", { name: "knowledge_read", arguments: { note: "Note.md" } });
  assert.deepEqual((await call("ping")).result, {});
  release(scan);
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.result.isError, undefined);
    assert.match(result.result.content[0].text, /Ready after scanning/);
  }
});

test("MCP reports initialization failure to the tool and retries on the next call", async (t) => {
  const { call, nextScan, release } = await startServer(t);
  await call("initialize");
  const failed = call("tools/call", { name: "knowledge_read", arguments: { note: "Note.md" } });
  release(await nextScan(), "fail");
  const error = await failed;
  assert.equal(error.result.isError, true);
  assert.match(error.result.content[0].text, /temporary vault scan failure/);
  const retry = call("tools/call", { name: "knowledge_read", arguments: { note: "Note.md" } });
  release(await nextScan());
  assert.match((await retry).result.content[0].text, /Ready after scanning/);
});

test("MCP rechecks the write guard after waiting for vault initialization", async (t) => {
  const { call, nextScan, release, setReadOnly } = await startServer(t);
  await call("initialize");
  const writing = call("tools/call", {
    name: "knowledge_write",
    arguments: { path: "New.md", content: "---\ntitle: New\ntype: topic\n---\n# New\n", create: true, dryRun: false },
  });
  const scan = await nextScan();
  await setReadOnly(true);
  release(scan);
  const refused = await writing;
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /readOnly is enabled/);
});
