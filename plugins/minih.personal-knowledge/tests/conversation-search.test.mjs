import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import { parseTurns } from "../lib/conversation-search.mjs";
import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

const fixedNow = () => new Date("2026-11-09T00:00:00Z");
const SESSION_A = "11111111-2222-3333-4444-555555555555";
const SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function fixture({ transcript = true, daily = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pk-conversation-search-"));
  const vault = path.join(root, "Knowledge");
  const project = path.join(vault, "09 Conversations", "Demo");
  await mkdir(path.join(vault, "01 Projects"), { recursive: true });
  await mkdir(path.join(vault, "09 Conversations", "_raw", "Demo", "2026-11"), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(path.join(vault, "09 Conversations", "Other"), { recursive: true });
  await writeFile(
    path.join(vault, "01 Projects", "Project - Demo.md"),
    `---\ntitle: Project - Demo\ntype: project\nstatus: active\nrepo: /workspace/demo\n---\n# Demo\n`,
  );
  await writeFile(
    path.join(project, "2026-11-08 Deploy pipeline 11111111.md"),
    `---\ntitle: "Deploy pipeline"\ntype: conversation\nsession_id: "${SESSION_A}"\nproject: "Demo"\ndevice: "mac-a"\ncreated: 2026-11-08\nupdated: 2026-11-08\nsummary_revision: 1\n${transcript ? 'transcript: "09 Conversations/_raw/Demo/2026-11/11111111"\n' : ""}---\n# Deploy pipeline\n\n## Goal\n\nShip the deploy pipeline before Friday.\n\n## Decisions\n\n- Reuse the ci-hub runner\n\n## Outcomes\n\n- Pipeline merged\n`,
  );
  await writeFile(
    path.join(project, "2026-11-05 Remote control aaaaaaaa.md"),
    `---\ntitle: "Remote control"\ntype: conversation\nsession_id: "${SESSION_B}"\nproject: "Demo"\ndevice: "mac-a"\ncreated: 2026-11-05\nupdated: 2026-11-05\nsummary_revision: 1\n---\n# Remote control\n\n## Goal\n\nFix remote pairing.\n`,
  );
  await writeFile(
    path.join(vault, "09 Conversations", "Other", "2026-11-01 Other task 99999999.md"),
    `---\ntitle: "Other task"\ntype: conversation\nsession_id: "99999999-0000"\nproject: "Other"\ndevice: "mac-b"\ncreated: 2026-11-01\nupdated: 2026-11-01\nsummary_revision: 1\n---\n# Other task\n\n## Goal\n\nDeploy something else.\n`,
  );
  if (transcript) {
    await writeFile(
      path.join(vault, "09 Conversations", "_raw", "Demo", "2026-11", "11111111.md"),
      `---\ntitle: "Deploy pipeline · 11111111"\ntype: conversation-transcript\nsession_id: "${SESSION_A}"\ndevice: "mac-a"\ncreated: 2026-11-08\nupdated: 2026-11-08\npart: 1\nparts: 1\n---\n# Deploy pipeline\n\n## T000 · 2026-11-08 10:00\n\n**User**\n\n让部署先跑起来\n\n**Assistant**\n\n先看 ci-hub 的 runner\n\n- Bash \`git status --short\`\n\n## T001 · 2026-11-08 10:05\n\n**User**\n\n换个话题，讲一下配色\n\n**Assistant**\n\n配色用暖灰\n\n## T002 · 2026-11-08 10:10\n\n**User**\n\n回到部署，runner 标签写什么\n\n**Assistant**\n\n写 node24-company\n`,
    );
  }
  if (daily) {
    await mkdir(path.join(vault, "09 Conversations", "_daily"), { recursive: true });
    await writeFile(
      path.join(vault, "09 Conversations", "_daily", "2026-11-08 mac-a.md"),
      `---\ntitle: "2026-11-08 conversations"\ntype: conversation-daily\ndevice: "mac-a"\ncreated: 2026-11-08\nupdated: 2026-11-08\n---\n# 2026-11-08 conversations\n\n- 18:00 · Demo · [[09 Conversations/Demo/2026-11/2026-11-08 Deploy pipeline 11111111|Deploy pipeline]] — Ship the deploy pipeline\n`,
    );
  }
  const config = {
    defaultNotes: [],
    projects: [{ name: "Demo", repoPrefixes: ["/workspace/demo"], notes: ["01 Projects/Project - Demo.md"] }],
    ignoreFolders: ["Templates", "09 Conversations/_raw", "09 Conversations/_daily"],
    backupRetentionDays: 0,
  };
  const service = await new KnowledgeService({ vaultPath: vault, config, now: fixedNow }).initialize();
  return { root, vault, service };
}

test("L3 is never indexed and knowledge_search leaves conversations out by default", async () => {
  const { service } = await fixture();
  const l3 = service.index.paths().filter((relative) => relative.includes("/_raw/"));
  assert.deepEqual(l3, [], "the transcript subtree is skipped by the index (leading underscore)");
  const daily = service.index.paths().filter((relative) => relative.includes("/_daily/"));
  assert.deepEqual(daily, [], "the daily roll-up is skipped too: it duplicates the summaries");

  const excluded = await service.search({ query: "deploy", mode: "any" });
  assert.ok(excluded.results.every((item) => !item.path.startsWith("09 Conversations/")));
  const excerpt = await service.search({ query: "deploy", mode: "ranked" });
  assert.ok(excerpt.results.every((item) => !item.path.startsWith("09 Conversations/")));

  const included = await service.search({ query: "deploy", mode: "any", include: ["conversations"] });
  assert.ok(included.results.some((item) => item.path.startsWith("09 Conversations/")));
});

test("conversation_search defaults to the current project and reports the goal", async () => {
  const { service } = await fixture();
  const scoped = await service.conversationSearch({ query: "deploy", cwd: "/workspace/demo/src" });
  assert.equal(scoped.scope, "project");
  assert.equal(scoped.project, "Demo");
  assert.ok(scoped.results.length >= 1);
  assert.ok(scoped.results.every((item) => item.sessionId !== "99999999-0000"), "another project is out of scope");
  assert.equal(scoped.results[0].sessionId, SESSION_A);
  assert.equal(scoped.results[0].goal, "Ship the deploy pipeline before Friday.");
  assert.match(scoped.caveat, /may be outdated/);

  const all = await service.conversationSearch({ query: "deploy", scope: "all" });
  assert.ok(all.results.some((item) => item.sessionId === "99999999-0000"));
});

test("conversation_search caps the result count at eight", async () => {
  const { service } = await fixture();
  await assert.rejects(service.conversationSearch({ query: "deploy", limit: 9 }), /limit must be an integer/);
  const many = await service.conversationSearch({ query: "deploy", scope: "all", limit: 8 });
  assert.ok(many.count <= 8);
});

test("conversation_read returns the summary, and refuses an unknown session", async () => {
  const { service } = await fixture();
  const summary = await service.conversationRead({ sessionId: SESSION_A });
  assert.equal(summary.part, "summary");
  assert.equal(summary.title, "Deploy pipeline");
  assert.match(summary.content, /Ship the deploy pipeline/);
  assert.match(summary.caveat, /historical/);
  await assert.rejects(service.conversationRead({ sessionId: "nope" }), /No archived conversation/);
  await assert.rejects(service.conversationRead({ sessionId: SESSION_A, part: "everything" }), /part must be/);
});

test("conversation_read pages the transcript by turn range and honours maxChars", async () => {
  const { service } = await fixture();
  const page = await service.conversationRead({ sessionId: SESSION_A, part: "transcript", fromTurn: 1, toTurn: 1 });
  assert.deepEqual(page.turns, [1]);
  assert.match(page.content, /配色用暖灰/);
  assert.ok(!page.content.includes("node24-company"));

  const full = await service.conversationRead({ sessionId: SESSION_A, part: "transcript" });
  const capped = await service.conversationRead({ sessionId: SESSION_A, part: "transcript", maxChars: 500 });
  assert.ok(capped.content.length <= 500);
  assert.equal(capped.content, full.content.slice(0, 500));
  assert.equal(capped.truncated, full.content.length > 500);
  await assert.rejects(
    service.conversationRead({ sessionId: SESSION_A, part: "transcript", maxChars: 100 }),
    /maxChars must be an integer/,
  );
});

test("conversation_read by keyword returns the matching turns with one neighbour each", async () => {
  const { service } = await fixture();
  const hit = await service.conversationRead({ sessionId: SESSION_A, part: "transcript", query: "配色" });
  assert.deepEqual(hit.turns, [0, 1, 2], "the match and one turn on each side");
  assert.match(hit.content, /配色用暖灰/);

  const last = await service.conversationRead({ sessionId: SESSION_A, part: "transcript", query: "node24-company" });
  assert.deepEqual(last.turns, [1, 2]);

  const none = await service.conversationRead({ sessionId: SESSION_A, part: "transcript", query: "nothing-matches" });
  assert.deepEqual(none.turns, []);
});

test("conversation_read prefers the host transcript and keeps the archive switch in force", async () => {
  const { service } = await fixture();
  const calls = [];
  service.pi = {
    conversations: {
      async transcript(input) {
        calls.push(input);
        return {
          turns: [
            { index: 0, startedAt: Date.parse("2026-11-08T10:00:00Z"), user: "from host", assistant: "ok", tools: [{ name: "Bash", line: "Bash ls", isError: true }] },
          ],
          nextTurn: null,
          lastSeq: 9,
        };
      },
    },
  };
  const hosted = await service.conversationRead({ sessionId: SESSION_A, part: "transcript" });
  assert.equal(hosted.source, "host");
  assert.equal(calls.length, 1);
  assert.match(hosted.content, /from host/);
  assert.match(hosted.content, /Bash `ls` ✗/);

  service.archiveEnabled = false;
  await assert.rejects(
    service.conversationRead({ sessionId: SESSION_A, part: "transcript" }),
    /ARCHIVE_DISABLED/,
  );
});

test("knowledge_context appends the three newest conversations of the project as links", async () => {
  const { service } = await fixture();
  const context = await service.context({ cwd: "/workspace/demo", topic: "", maxChars: 20_000 });
  assert.equal(context.conversations.project, "Demo");
  assert.equal(context.conversations.count, 2);
  assert.deepEqual(
    context.conversations.items.map((item) => item.sessionId),
    [SESSION_A, SESSION_B],
    "newest first",
  );
  assert.match(context.conversationCaveat, /historical/);
  const rendered = context.conversations.items.map((item) => item.goal);
  assert.ok(rendered.includes("Ship the deploy pipeline before Friday."));
});

test("parseTurns splits an L3 note on its turn headings", () => {
  const turns = parseTurns(`---\ntitle: x\n---\n# T\n\n## T000 · 2026-11-08 10:00\n\nbody a\n\n## T001 · 2026-11-08 10:05\n\nbody b\n`);
  assert.deepEqual(turns.map((turn) => turn.index), [0, 1]);
  assert.match(turns[1].text, /body b/);
});
