import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const REQUIRED_TOOLS = [
  "knowledge_context",
  "knowledge_links",
  "knowledge_read",
  "knowledge_search",
  "knowledge_stale",
  "knowledge_write",
];

function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function createClient({ cwd, env }) {
  let child;
  let nextId = 1;
  const pending = new Map();

  function settle(id, outcome, payload) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timeout);
    item[outcome](payload);
  }

  return {
    async start() {
      child = spawn(process.execPath, [path.join(cwd, "mcp", "server.mjs")], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "inherit"],
      });
      child.once("error", (error) => {
        for (const id of pending.keys()) settle(id, "reject", error);
      });
      child.once("exit", (code, signal) => {
        const failure = new Error(`MCP server exited early: code=${code} signal=${signal}`);
        for (const id of pending.keys()) settle(id, "reject", failure);
      });
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          for (const id of pending.keys()) settle(id, "reject", error);
          return;
        }
        if (message.id === undefined) return;
        if (message.error) settle(message.id, "reject", new Error(message.error.message));
        else settle(message.id, "resolve", message.result);
      });
    },
    request(method, params = {}) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => settle(id, "reject", new Error(`Timed out: ${method}`)), 10_000);
        pending.set(id, { resolve, reject, timeout });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async close() {
      if (!child) return;
      const closing = child;
      child = null;
      closing.stdin.end();
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        closing.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      if (closing.exitCode === null) closing.kill("SIGTERM");
    },
  };
}

const root = pluginRoot();

// Base mode (default): start the MCP server with the bundled template config
// and assert the tool surface plus graceful empty results. Personal mode:
// `probe.mjs --config <repo-map.json> [--cwd <repo>] [--topic <topic>]`
// additionally asserts project routing against the caller's private mapping.
const argv = process.argv.slice(2);
function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const configPath = argValue("--config");
const probeCwd = argValue("--cwd");
const probeTopic = argValue("--topic") ?? "architecture";

const env = { ...process.env, PERSONAL_KNOWLEDGE_READ_ONLY: "1" };
if (configPath) env.PERSONAL_KNOWLEDGE_CONFIG = configPath;

const client = createClient({ cwd: root, env });

try {
  await client.start();
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "personal-knowledge-probe", version: "0.1.0" },
  });
  client.notify("notifications/initialized");
  const listed = await client.request("tools/list");
  const names = listed.tools.map((tool) => tool.name).sort();
  const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !REQUIRED_TOOLS.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`Tool mismatch. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  }

  if (configPath) {
    if (!probeCwd) throw new Error("--config requires --cwd <repo path> for the routing assertion.");
    const context = await client.request("tools/call", {
      name: "knowledge_context",
      arguments: { cwd: probeCwd, topic: probeTopic, maxChars: 12_000 },
    });
    const matched = context.structuredContent?.matchedProjects ?? [];
    if (context.isError || matched.length < 1) {
      throw new Error(`knowledge_context did not resolve a project mapping for ${probeCwd}.`);
    }
    console.log(`context matched: ${matched.join(", ")}`);
  }

  const stale = await client.request("tools/call", {
    name: "knowledge_stale",
    arguments: { limit: 5 },
  });
  if (stale.isError || !Array.isArray(stale.structuredContent?.due)) {
    throw new Error("knowledge_stale did not return a due list.");
  }

  console.log(JSON.stringify({ status: "ok", tools: names, staleSample: stale.structuredContent.count }, null, 2));
} finally {
  await client.close();
}
