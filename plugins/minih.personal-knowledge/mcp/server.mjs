import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { createKnowledgeService } from "./knowledge-core.mjs";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(serverDir, "..");

// The plugin ships in two shapes: the desktop `manifest.json` and the Codex
// `.codex-plugin/plugin.json`. Either may be absent when the directory is run
// straight from a checkout, so the version only degrades to a placeholder.
async function readPluginVersion() {
  for (const relative of ["manifest.json", path.join(".codex-plugin", "plugin.json")]) {
    try {
      const parsed = JSON.parse(await readFile(path.join(pluginRoot, relative), "utf8"));
      if (typeof parsed?.version === "string" && parsed.version) return parsed.version;
    } catch {
      // Try the next manifest location.
    }
  }
  return "0.0.0";
}

const service = await createKnowledgeService({ pluginRoot });
const manifest = { version: await readPluginVersion() };

const TOOL_DEFINITIONS = [
  {
    name: "knowledge_context",
    title: "Load Personal Knowledge Context",
    description:
      "Load the smallest relevant context pack from the user's Obsidian vault by matching a repository path and task topic. Call before non-trivial work involving the user's projects, preferences, stack, infrastructure, or prior decisions.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Current repository or working-directory path." },
        topic: { type: "string", description: "Short task topic, including relevant aliases, domains, or IPs." },
        maxChars: { type: "integer", minimum: 4000, maximum: 100000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "knowledge_search",
    title: "Search Personal Knowledge",
    description:
      "Search Markdown notes and Obsidian Bases in the local knowledge vault with exact, deterministic term matching and safe snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        scope: { type: "string", description: "Optional vault-relative folder scope." },
        mode: {
          type: "string",
          enum: ["ranked", "all", "any"],
          default: "ranked",
          description: "ranked fuses BM25F, local vectors, and the link graph (default); all/any keep exact literal matching.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "knowledge_read",
    title: "Read a Personal Knowledge Note",
    description:
      "Read one exact or uniquely named knowledge note, returning its content, metadata, and SHA-256 for guarded write-back. Optionally limit the read to one heading section and return the outline.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", minLength: 1, description: "Vault-relative path, basename, or unique note name." },
        maxChars: { type: "integer", minimum: 1000, maximum: 100000 },
        section: {
          type: "string",
          description: "Heading text or 'H2 > H3' path; the read returns that section only.",
        },
        outline: { type: "boolean", description: "Include the heading outline." },
      },
      required: ["note"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "knowledge_stale",
    title: "Find Stale Personal Knowledge",
    description:
      "List notes whose verified date is missing or older than their monthly or quarterly review window.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        includeUnverified: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "knowledge_links",
    title: "Inspect Personal Knowledge Links",
    description: "Return outgoing wikilinks and backlinks for one knowledge note.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", minLength: 1 },
      },
      required: ["note"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "knowledge_write",
    title: "Safely Write Personal Knowledge",
    description:
      "Create or edit one Markdown note inside the vault. Operations: full replace (default), section replace or append, and frontmatter patch. Defaults to dry-run, requires the current SHA-256 for updates, rejects likely credentials and unsafe paths, writes atomically, and backs up changed notes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Vault-relative .md path." },
        content: {
          type: "string",
          description:
            "For replace: the complete note with title and type frontmatter. For replaceSection: the section including its heading line. For appendToSection: the text to append.",
        },
        operation: {
          type: "string",
          enum: ["replace", "replaceSection", "appendToSection", "patchFrontmatter"],
          default: "replace",
          description: "replace rewrites the whole note; the others edit one part and keep the rest byte-identical.",
        },
        section: { type: "string", description: "Heading text or 'H2 > H3' path; required for section operations." },
        frontmatter: {
          type: "object",
          description: "For patchFrontmatter: keys to set; a null value removes the key. Other keys keep their order and formatting.",
        },
        expectedSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        dryRun: { type: "boolean", default: true },
        create: { type: "boolean", default: false },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// Boolean settings arrive as strings from MCP env injection; accept every
// truthy spelling so a plugin-settings toggle is honored (0.1.1).
function isReadOnlyMode() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.PERSONAL_KNOWLEDGE_READ_ONLY ?? "").trim().toLowerCase(),
  );
}

const handlers = {
  knowledge_context: (args) => service.context(args),
  knowledge_search: (args) => service.search(args),
  knowledge_read: (args) => service.read(args),
  knowledge_stale: (args) => service.stale(args),
  knowledge_links: (args) => service.links(args),
  knowledge_write: (args) => {
    if (isReadOnlyMode() && args?.dryRun === false) {
      throw new Error("knowledge_write is read-only because PERSONAL_KNOWLEDGE_READ_ONLY=1.");
    }
    return service.write(args);
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function renderToolResult(name, value) {
  if (name === "knowledge_read") {
    return `# ${value.title}\nPath: ${value.path}\nSHA-256: ${value.sha256}\nTruncated: ${value.truncated}\n\n${value.content}`;
  }
  if (name === "knowledge_context") {
    const heading = [
      `Matched projects: ${value.matchedProjects.join(", ") || "none"}`,
      `Matched routes: ${value.matchedRoutes.join(", ") || "none"}`,
    ].join("\n");
    const notes = value.notes
      .map((note) => `\n## ${note.title}\nPath: ${note.path}\nVerified: ${note.metadata.verified || "unverified"}\n\n${note.content}`)
      .join("\n");
    return `${heading}${notes}`;
  }
  if (name === "knowledge_search") {
    return value.results.length
      ? value.results.map((item) => `${item.path} | score=${item.score}\n${item.snippet}`).join("\n\n")
      : "No matching knowledge notes found.";
  }
  if (name === "knowledge_stale") {
    return value.due.length
      ? value.due.map((item) => `${item.path} | ${item.reason} | verified=${item.verified || "none"}`).join("\n")
      : "No stale knowledge found for the configured review windows.";
  }
  return JSON.stringify(value, null, 2);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "Personal Knowledge", version: manifest.version },
      instructions:
        "Call knowledge_context before relevant work. Use knowledge_write only for durable confirmed facts; dry-run first and never store secrets.",
    });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/list") {
    result(id, { tools: TOOL_DEFINITIONS });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const handler = handlers[name];
    if (!handler) {
      error(id, -32602, `Unknown tool: ${name ?? ""}`);
      return;
    }
    try {
      const value = await handler(params?.arguments ?? {});
      result(id, {
        content: [{ type: "text", text: renderToolResult(name, value) }],
        structuredContent: value,
      });
    } catch (caught) {
      result(id, {
        isError: true,
        content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }],
      });
    }
    return;
  }
  if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    error(null, -32700, "Parse error");
    return;
  }
  try {
    await handleRequest(message);
  } catch (caught) {
    if (message.id !== undefined) error(message.id, -32603, caught instanceof Error ? caught.message : String(caught));
  }
});
