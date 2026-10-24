import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** Build a fixture vault, stub `globalThis.pi`, and load the plugin backend. */
async function loadBackend({ memory } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p4-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "00 Inbox"), { recursive: true });
  await writeFile(
    path.join(vault, "Project - Demo.md"),
    `---
title: Project - Demo
type: project
status: active
repo: /repo/demo
---
# Demo
`,
  );
  const indexDir = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-p4-vec-"));
  const emptyConfig = path.join(root, "repo-map.json");
  await writeFile(emptyConfig, "{}\n");
  process.env.PERSONAL_KNOWLEDGE_VAULT = vault;
  process.env.PERSONAL_KNOWLEDGE_CONFIG = emptyConfig;
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = path.join(root, "embedding.json");
  await writeFile(process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG, '{"enabled": false}\n');
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = indexDir;
  delete process.env.PERSONAL_KNOWLEDGE_READ_ONLY;
  globalThis.pi = { memory: memory ?? {} };
  // main.js keeps per-process state; each test gets a fresh module instance.
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  const backend = require(path.join(ROOT, "main.js"));
  return { root, vault, backend };
}

const memoryEntry = {
  id: "m-1",
  scope: "project",
  kind: "fact",
  content: "Router 生产网关运行在 rc.hmini.org",
  rationale: "来自会话确认",
  origin: "explicit",
  evidence: "verified",
  createdAt: Date.parse("2026-10-20T00:00:00Z"),
  updatedAt: Date.parse("2026-10-22T00:00:00Z"),
};

test("kg.graph with includeMemory attaches memory satellites to project and Me center", async () => {
  const { backend } = await loadBackend({
    memory: {
      list: async (input) => {
        if (input.scope === "project" && input.path === "/repo/demo") {
          return { readEnabled: true, entries: [memoryEntry], nextOffset: null };
        }
        if (input.scope === "user") {
          return {
            readEnabled: true,
            entries: [{ ...memoryEntry, id: "m-user", scope: "user", kind: "preference" }],
            nextOffset: null,
          };
        }
        return { readEnabled: true, entries: [], nextOffset: null };
      },
    },
  });
  const payload = await backend.onPanelInvoke("kg.graph", { includeMemory: true });
  assert.equal(payload.memory.status, "ok");
  assert.equal(payload.memory.count, 2);
  const memoryNodes = payload.nodes.filter((node) => node.family === "memory");
  assert.equal(memoryNodes.length, 3, "two entries plus the Me center");
  const attached = memoryNodes.find((node) => node.id === "memory:m-1");
  assert.equal(attached.project, "Project - Demo.md");
  assert.equal(attached.memoryKind, "fact");
  assert.equal(attached.updated, "2026-10-22");
  assert.ok(memoryNodes.some((node) => node.id === "memory:user-center"));
  const centerLink = payload.links.find(
    (link) => link.predicate === "memory" && link.source === "memory:m-user",
  );
  assert.equal(centerLink.target, "memory:user-center");

  // Promotion preview: dry-run only, draft under 00 Inbox/ with provenance.
  const preview = await backend.onPanelInvoke("kg.promote.preview", { memoryId: "m-1" });
  assert.equal(preview.summary.dryRun, true);
  assert.match(preview.draft.path, /^00 Inbox\/Memory - .+\.md$/);
  assert.match(preview.draft.content, /source: "memory:m-1"/);
  assert.match(preview.draft.content, /type: reference/);
  // The preview must not have written anything.
  await assert.rejects(readFile(path.join(process.env.PERSONAL_KNOWLEDGE_VAULT, preview.draft.path), "utf8"));
});

test("memory status reflects disabled, unsupported, and permission-missing", async () => {
  const disabled = await loadBackend({
    memory: { list: async () => ({ readEnabled: false, entries: [], nextOffset: null }) },
  });
  const disabledPayload = await disabled.backend.onPanelInvoke("kg.graph", { includeMemory: true });
  assert.equal(disabledPayload.memory.status, "disabled");
  assert.equal(disabledPayload.memory.count, 0);

  const unsupported = await loadBackend({});
  const unsupportedPayload = await unsupported.backend.onPanelInvoke("kg.graph", { includeMemory: true });
  assert.equal(unsupportedPayload.memory.status, "unsupported");

  const denied = await loadBackend({
    memory: {
      list: async () => {
        const error = new Error("permission denied");
        error.code = "PERMISSION_DENIED";
        throw error;
      },
    },
  });
  const deniedPayload = await denied.backend.onPanelInvoke("kg.graph", { includeMemory: true });
  assert.equal(deniedPayload.memory.status, "permission-missing");
});

test("promotion applies after confirmation and is refused in read-only mode", async () => {
  const { backend, vault } = await loadBackend({
    memory: { list: async () => ({ readEnabled: true, entries: [memoryEntry], nextOffset: null }) },
  });
  await backend.onPanelInvoke("kg.graph", { includeMemory: true });
  const preview = await backend.onPanelInvoke("kg.promote.preview", { memoryId: "m-1" });
  const applied = await backend.onPanelInvoke("kg.promote.apply", preview.draft);
  assert.equal(applied.promoted, true);
  const written = await readFile(path.join(vault, preview.draft.path), "utf8");
  assert.match(written, /type: reference/);
  assert.match(written, /Router 生产网关运行在 rc\.hmini\.org/);

  // Read-only mode refuses the write but the preview still works.
  process.env.PERSONAL_KNOWLEDGE_READ_ONLY = "1";
  await assert.rejects(
    backend.onPanelInvoke("kg.promote.apply", preview.draft),
    /PERSONAL_KNOWLEDGE_READ_ONLY=1/,
  );
  delete process.env.PERSONAL_KNOWLEDGE_READ_ONLY;

  // The apply path refuses targets outside 00 Inbox/.
  await assert.rejects(
    backend.onPanelInvoke("kg.promote.apply", { ...preview.draft, path: "01 Projects/Evil.md" }),
    /00 Inbox/,
  );
});
