import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ConversationSyncer, archiveConfig, defaultDeviceName } from "../lib/conversation-sync.mjs";
import {
  conflictCopyOf,
  dailyPathFor,
  isRawPath,
  isSearchableConversationPath,
  projectFolderFor,
  rawPathFor,
  splitParts,
  summaryPathFor,
} from "../lib/conversation-layout.mjs";
import { parseFrontmatter } from "../lib/frontmatter.mjs";
import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

const DEVICE = "test-mac";
const NOW = new Date("2026-11-09T04:00:00Z");

async function vault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pk-conversations-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "pk-conversations-home-"));
  const vaultRoot = path.join(root, "Knowledge");
  await mkdir(vaultRoot, { recursive: true });
  return { root, vaultRoot, home, statePath: path.join(home, "conversation-sync.json") };
}

function change(overrides = {}) {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    title: "Fix the archive",
    createdAt: Date.parse("2026-11-08T10:12:00Z"),
    updatedAt: Date.parse("2026-11-08T11:00:00Z"),
    project: { name: "minih-agent-plugins", path: "/Users/dev/minih-agent-plugins", gitRemote: "gitea.hungraim.com/minih/minih-agent-plugins" },
    lastSeq: 12,
    summaryRevision: 1,
    removed: false,
    ...overrides,
  };
}

const SUMMARY = {
  goal: "Archive conversations into the vault",
  decisions: ["Keep one writer per file"],
  outcomes: ["Syncer writes L2 and L3"],
  files: ["lib/conversation-sync.mjs"],
  openItems: ["P5 tools"],
  tags: ["archive"],
};

function transcriptFor(turns) {
  return { turns, nextTurn: null, lastSeq: 12 };
}

/** A fake `pi` that serves one feed page and one session. */
function fakePi({ pages, summary = SUMMARY, transcript = null, enabled = true } = {}) {
  const calls = { changes: [], summary: [], transcript: [] };
  let served = 0;
  return {
    calls,
    conversations: {
      async changes(input) {
        calls.changes.push(input ?? {});
        if (!enabled) return { enabled: false, items: [], nextCursor: null };
        // One page per pass: a full pass ends where the feed says it ends.
        const index = Math.min(served, pages.length - 1);
        served += 1;
        return pages[index];
      },
      async summary(input) {
        calls.summary.push(input);
        return summary === null ? null : { revision: 1, coveredSeq: 10, summary };
      },
      async transcript(input) {
        calls.transcript.push(input);
        return typeof transcript === "function" ? transcript(input) : transcript ?? transcriptFor([]);
      },
    },
  };
}

function syncerFor({ pi, vaultRoot, statePath, config = {}, locale = "en", ...rest }) {
  return new ConversationSyncer({
    pi,
    vaultRoot,
    statePath,
    device: DEVICE,
    now: () => NOW,
    config,
    locale,
    ...rest,
  });
}

// ---------------------------------------------------------------- layout

test("project folder order: repo-map name, git remote owner-repo, directory name, _无项目", () => {
  const config = { projects: [{ name: "Plugins", repoPrefixes: ["/Users/dev/minih-agent-plugins"] }] };
  assert.equal(projectFolderFor({ name: "x", path: "/Users/dev/minih-agent-plugins/sub" }, config), "Plugins");
  assert.equal(
    projectFolderFor({ name: "x", path: "/Users/other/plugins", gitRemote: "gitea.hungraim.com/minih/minih-agent-plugins" }, config),
    "minih-minih-agent-plugins",
  );
  assert.equal(projectFolderFor({ name: "x", path: "/Users/dev/Demo Repo/" }, config), "Demo Repo");
  assert.equal(projectFolderFor(null, config), "_无项目");
  assert.equal(
    projectFolderFor({ name: "", path: "", gitRemote: "" }, config),
    "_无项目",
  );
});

test("L2 and L3 paths use the conversation date, the project folder and the session prefix", () => {
  const row = change();
  assert.equal(
    summaryPathFor(row),
    "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md",
  );
  assert.equal(rawPathFor(row), "09 Conversations/_raw/minih-minih-agent-plugins/2026-11/11111111.md");
  assert.equal(rawPathFor(row, { part: 3 }), "09 Conversations/_raw/minih-minih-agent-plugins/2026-11/11111111.p3.md");
  assert.equal(dailyPathFor("2026-11-08", DEVICE), "09 Conversations/_daily/2026-11-08 test-mac.md");
});

test("titles are sanitized for Obsidian and the filesystem", () => {
  const row = change({ title: 'a/b: c? "d" | e' });
  const summary = summaryPathFor(row);
  assert.ok(!/[/\\:*?"<>|]/.test(summary.split("/").slice(3).join("/")));
  assert.match(summary, /a-b- c- -d- - e 11111111\.md$/);
});

test("iCloud conflict copies are recognized, Obsidian's (1) form is left alone", () => {
  assert.equal(conflictCopyOf("09 Conversations/A/2026-11/x 2.md"), "09 Conversations/A/2026-11/x.md");
  assert.equal(conflictCopyOf("09 Conversations/A/2026-11/x 2 2.md"), "09 Conversations/A/2026-11/x 2.md");
  assert.equal(conflictCopyOf("09 Conversations/A/2026-11/x (1).md"), null);
  assert.equal(conflictCopyOf("09 Conversations/A/2026-11/x.md"), null);
});

test("splitParts keeps parts under the byte ceiling and prefers turn boundaries", () => {
  const turns = Array.from({ length: 6 }, (_, index) => `## T00${index}\n\n${"x".repeat(460)}\n`);
  const parts = splitParts(turns, { maxBytes: 1000 });
  assert.ok(parts.length >= 3, `expected several parts, got ${parts.length}`);
  for (const part of parts) assert.ok(Buffer.byteLength(part, "utf8") <= 1000);
  assert.ok(parts.every((part) => part.startsWith("## T00")), "each part starts on a turn boundary");
  assert.equal(parts.join(""), turns.join(""));
  const big = splitParts([`${"y".repeat(500)}\n`], { maxBytes: 120 });
  assert.ok(big.every((part) => Buffer.byteLength(part, "utf8") <= 120));
  assert.equal(big.join(""), `${"y".repeat(500)}\n`);
});

test("device names are filesystem-safe", () => {
  assert.equal(defaultDeviceName("Minihs-Mac-mini.local"), "Minihs-Mac-mini");
  assert.equal(defaultDeviceName("weird host/name"), "weird-host-name");
});

test("archiveConfig only adds the two private conversation folders", () => {
  const config = archiveConfig({ ignoreFolders: ["Templates"], backupRetentionDays: 30 });
  assert.deepEqual(config.ignoreFolders, ["Templates", "09 Conversations/_raw", "09 Conversations/_daily"]);
  assert.equal(config.backupRetentionDays, 30);
  const again = archiveConfig(config);
  assert.deepEqual(again.ignoreFolders, ["Templates", "09 Conversations/_raw", "09 Conversations/_daily"], "idempotent");
  assert.deepEqual(archiveConfig({}).ignoreFolders, ["09 Conversations/_raw", "09 Conversations/_daily"]);
});

test("the transcript and daily folders are private by their leading underscore", () => {
  assert.equal(isRawPath("09 Conversations/_raw/demo/2026-11/11111111.md"), true);
  assert.equal(isRawPath("09 Conversations/_daily/2026-11-08 mac-a.md"), true);
  assert.equal(isRawPath("09 Conversations/demo/2026-11/2026-11-08 Title 11111111.md"), false);
  assert.equal(isSearchableConversationPath("09 Conversations/demo/2026-11/x.md"), true);
});

// ---------------------------------------------------------------- syncer

test("first sync writes L2, L3 and the daily page with this computer's device", async () => {
  const { vaultRoot, statePath } = await vault();
  const pi = fakePi({
    pages: [{ enabled: true, items: [change()], nextCursor: "cursor-1" }],
    transcript: transcriptFor([
      { index: 0, startedAt: Date.parse("2026-11-08T10:12:00Z"), user: "hello", assistant: "hi", tools: [{ name: "Bash", line: "Bash git status --short", isError: false }] },
    ]),
  });
  const syncer = syncerFor({ pi, vaultRoot, statePath });
  const status = await syncer.syncOnce({ reason: "test" });
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(status.written, 1);

  const summaryPath = path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md");
  const summary = await readFile(summaryPath, "utf8");
  const metadata = parseFrontmatter(summary).data;
  assert.equal(metadata.type, "conversation");
  assert.equal(metadata.device, DEVICE);
  assert.equal(metadata.session_id, change().sessionId);
  assert.equal(metadata.summary_revision, 1);
  assert.match(summary, /## Goal\n\nArchive conversations into the vault/);
  assert.match(summary, /## Decisions\n\n- Keep one writer per file/);
  assert.match(summary, /Source: \[\[09 Conversations\/_raw\/minih-minih-agent-plugins\/2026-11\/11111111\|Transcript\]\]/);

  const rawPath = path.join(vaultRoot, "09 Conversations/_raw/minih-minih-agent-plugins/2026-11/11111111.md");
  const raw = await readFile(rawPath, "utf8");
  assert.match(raw, /## T000 · 2026-11-08/);
  assert.match(raw, /- Bash `git status --short`/);
  assert.equal(parseFrontmatter(raw).data.device, DEVICE);

  const daily = await readFile(path.join(vaultRoot, "09 Conversations/_daily/2026-11-08 test-mac.md"), "utf8");
  assert.match(daily, /# 2026-11-08 conversations/);
  assert.match(daily, /Generated by test-mac/);
  assert.match(daily, /Fix the archive/);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.cursor, "cursor-1");
});

test("a session without a summary still writes L3 and leaves L2 without one", async () => {
  const { vaultRoot, statePath } = await vault();
  const pi = fakePi({
    pages: [{ enabled: true, items: [change({ summaryRevision: null })], nextCursor: "c1" }],
    summary: null,
    transcript: transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]),
  });
  const syncer = syncerFor({ pi, vaultRoot, statePath });
  await syncer.syncOnce({ reason: "test" });
  const rawDir = path.join(vaultRoot, "09 Conversations/_raw/minih-minih-agent-plugins/2026-11");
  assert.deepEqual(await readdir(rawDir), ["11111111.md"]);
  assert.equal(pi.calls.summary.length, 0, "no summary request while the revision is null");
  const summary = await readFile(
    path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md"),
    "utf8",
  );
  assert.match(summary, /No summary yet/);
  assert.equal(parseFrontmatter(summary).data.summary_revision, null);
});

test("the revision appearing later rewrites L2 with the stored summary", async () => {
  const { vaultRoot, statePath } = await vault();
  const pages = [
    { enabled: true, items: [change({ summaryRevision: null })], nextCursor: "c1" },
  ];
  const pi = fakePi({
    pages,
    transcript: transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]),
  });
  const syncer = syncerFor({ pi, vaultRoot, statePath });
  await syncer.syncOnce({ reason: "test" });
  const summaryFile = path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md");
  assert.match(await readFile(summaryFile, "utf8"), /No summary yet/);

  // Second pass: the cursor moved, and the host now reports a revision.
  pi.calls.changes.length = 0;
  const second = fakePi({
    pages: [{ enabled: true, items: [change({ summaryRevision: 2 })], nextCursor: "c2" }],
    transcript: transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]),
  });
  const next = syncerFor({ pi: second, vaultRoot, statePath });
  await next.syncOnce({ reason: "test" });
  const updated = await readFile(summaryFile, "utf8");
  assert.match(updated, /Archive conversations into the vault/);
  assert.equal(parseFrontmatter(updated).data.summary_revision, 2);
});

test("an unchanged session is not rewritten", async () => {
  const { vaultRoot, statePath } = await vault();
  const payload = {
    enabled: true,
    items: [change()],
    nextCursor: "c1",
  };
  const transcript = transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]);
  const first = syncerFor({ pi: fakePi({ pages: [payload], transcript }), vaultRoot, statePath });
  await first.syncOnce({ reason: "test" });
  const summaryFile = path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md");
  const before = await readFile(summaryFile, "utf8");

  const second = syncerFor({ pi: fakePi({ pages: [payload], transcript }), vaultRoot, statePath });
  const status = await second.syncOnce({ reason: "test" });
  assert.equal(status.state, "ok");
  assert.equal(await readFile(summaryFile, "utf8"), before);
  assert.equal(second.pi.calls.transcript.length, 0, "L3 is not re-read when lastSeq did not change");
});

test("removals are idempotent and the cursor only advances after they are handled", async () => {
  const { vaultRoot, statePath } = await vault();
  const row = change();
  const transcript = transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]);
  await syncerFor({ pi: fakePi({ pages: [{ enabled: true, items: [row], nextCursor: "c1" }], transcript }), vaultRoot, statePath }).syncOnce({ reason: "test" });
  const summaryFile = path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md");
  assert.ok(await readFile(summaryFile, "utf8"));

  const removalPage = { enabled: true, items: [{ ...row, removed: true }], nextCursor: "c2" };
  const removing = syncerFor({ pi: fakePi({ pages: [removalPage] }), vaultRoot, statePath });
  // Nothing to conflict with here: the fixture's only conversation is this one.
  const status = await removing.syncOnce({ reason: "test" });
  assert.ok(status.removed >= 1);
  await assert.rejects(readFile(summaryFile, "utf8"), /ENOENT/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).cursor, "c2");

  // The same notice again (at-least-once delivery): nothing to delete, no error.
  const again = syncerFor({ pi: fakePi({ pages: [removalPage] }), vaultRoot, statePath });
  const second = await again.syncOnce({ reason: "test" });
  assert.equal(second.state, "ok");
  // The notice is delivered again (at-least-once) and handled without error.
  assert.equal(second.removed, 50, "the same at-least-once notice is delivered again on every pass");
  await assert.rejects(readFile(summaryFile, "utf8"), /ENOENT/);
});

test("a failing delete keeps the cursor so the removal is retried", async () => {
  const { vaultRoot, statePath } = await vault();
  const row = change();
  const transcript = transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]);
  await syncerFor({ pi: fakePi({ pages: [{ enabled: true, items: [row], nextCursor: "c1" }], transcript }), vaultRoot, statePath }).syncOnce({ reason: "test" });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).cursor, "c1");

  const failing = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [{ ...row, removed: true }], nextCursor: "c2" }] }),
    vaultRoot,
    statePath,
  });
  // Simulate a filesystem failure during deletion.
  const original = failing.vaultRoot;
  Object.defineProperty(failing, "vaultRoot", {
    value: "/proc/nonexistent-vault",
    writable: true,
    configurable: true,
  });
  const status = await failing.syncOnce({ reason: "test" });
  assert.equal(status.state, "error");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).cursor, "c1", "the cursor did not advance past a failed delete");
  failing.vaultRoot = original;
  const retried = await failing.syncOnce({ reason: "test" });
  assert.equal(retried.state, "ok", JSON.stringify(retried));
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).cursor, "c2");
});

test("with the archive switch off the syncer stays idle and deletes nothing", async () => {
  const { vaultRoot, statePath } = await vault();
  const row = change();
  const transcript = transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]);
  await syncerFor({ pi: fakePi({ pages: [{ enabled: true, items: [row], nextCursor: "c1" }], transcript }), vaultRoot, statePath }).syncOnce({ reason: "test" });
  const summaryFile = path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md");
  assert.ok(await readFile(summaryFile, "utf8"));

  const off = syncerFor({ pi: fakePi({ enabled: false, pages: [{ enabled: false, items: [], nextCursor: null }] }), vaultRoot, statePath });
  const status = await off.syncOnce({ reason: "test" });
  assert.equal(status.state, "disabled");
  assert.ok(await readFile(summaryFile, "utf8"), "switching off does not delete archived notes");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).cursor, "c1", "the cursor is preserved");
});

test("another computer's files are never rewritten or deleted", async () => {
  const { vaultRoot, statePath } = await vault();
  const row = change();
  const summaryRelative = "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md";
  await mkdir(path.dirname(path.join(vaultRoot, summaryRelative)), { recursive: true });
  await writeFile(
    path.join(vaultRoot, summaryRelative),
    `---\ntitle: "Fix the archive"\ntype: conversation\nsession_id: "${row.sessionId}"\ndevice: "other-mac"\ncreated: 2026-11-08\nupdated: 2026-11-08\n---\n# owned elsewhere\n`,
  );
  const syncer = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [row], nextCursor: "c1" }], transcript: transcriptFor([]) }),
    vaultRoot,
    statePath,
  });
  const status = await syncer.syncOnce({ reason: "test" });
  assert.equal(status.state, "ok");
  assert.match(await readFile(path.join(vaultRoot, summaryRelative), "utf8"), /owned elsewhere/);

  const removing = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [{ ...row, removed: true }], nextCursor: "c2" }] }),
    vaultRoot,
    statePath,
  });
  await removing.syncOnce({ reason: "test" });
  assert.match(await readFile(path.join(vaultRoot, summaryRelative), "utf8"), /owned elsewhere/);
});

test("a 3 MiB transcript is split into parts under the ceiling", async () => {
  const { vaultRoot, statePath } = await vault();
  const big = "z".repeat(64 * 1024);
  const turns = Array.from({ length: 50 }, (_, index) => ({
    index,
    startedAt: NOW.getTime(),
    user: `turn ${index}`,
    assistant: big,
    tools: [{ name: "Read", line: "Read lib/x.mjs", isError: false }],
  }));
  const pi = fakePi({
    pages: [{ enabled: true, items: [change({ lastSeq: 50 })], nextCursor: "c1" }],
    transcript: transcriptFor(turns),
  });
  const syncer = syncerFor({ pi, vaultRoot, statePath });
  await syncer.syncOnce({ reason: "test" });
  const dir = path.join(vaultRoot, "09 Conversations/_raw/minih-minih-agent-plugins/2026-11");
  const files = (await readdir(dir)).sort();
  assert.ok(files.length > 1, `expected several parts, got ${files.join(",")}`);
  assert.equal(files[0], "11111111.md");
  assert.equal(files[1], "11111111.p2.md");
  for (const file of files) {
    const content = await readFile(path.join(dir, file), "utf8");
    assert.ok(Buffer.byteLength(content, "utf8") <= 512 * 1024, `${file} exceeds 512 KiB`);
  }
  const summary = await readFile(
    path.join(vaultRoot, "09 Conversations/minih-minih-agent-plugins/2026-11/2026-11-08 Fix the archive 11111111.md"),
    "utf8",
  );
  assert.match(summary, /transcript:\n {2}- "09 Conversations\/_raw\/minih-minih-agent-plugins\/2026-11\/11111111"/);
  assert.match(summary, /11111111\.p2/);
});

test("the daily page is written per computer and keeps the day's sessions", async () => {
  const { vaultRoot, statePath } = await vault();
  const pi = fakePi({
    pages: [
      {
        enabled: true,
        items: [change(), change({ sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "Second task", createdAt: Date.parse("2026-11-08T15:00:00Z") })],
        nextCursor: "c1",
      },
    ],
    transcript: transcriptFor([{ index: 0, startedAt: NOW.getTime(), user: "u", assistant: "a", tools: [] }]),
  });
  const syncer = syncerFor({ pi, vaultRoot, statePath });
  await syncer.syncOnce({ reason: "test" });
  const daily = await readFile(path.join(vaultRoot, "09 Conversations/_daily/2026-11-08 test-mac.md"), "utf8");
  assert.match(daily, /Fix the archive/);
  assert.match(daily, /Second task/);
  assert.equal(parseFrontmatter(daily).data.device, DEVICE);

  const other = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [], nextCursor: "c9" }] }),
    vaultRoot,
    statePath: path.join(path.dirname(statePath), "other.json"),
    device: "other-mac",
  });
  await other.syncOnce({ reason: "test" });
  const files = (await readdir(path.join(vaultRoot, "09 Conversations/_daily"))).sort();
  assert.deepEqual(files, ["2026-11-08 test-mac.md"], "a computer writes only its own daily page");
  assert.match(await readFile(path.join(vaultRoot, "09 Conversations/_daily/2026-11-08 test-mac.md"), "utf8"), /Fix the archive/);
});

test("content passes the plugin redactor before it is written", async () => {
  const { vaultRoot, statePath } = await vault();
  const pi = fakePi({
    pages: [{ enabled: true, items: [change()], nextCursor: "c1" }],
    transcript: transcriptFor([
      { index: 0, startedAt: NOW.getTime(), user: "token: sk-abcdefghijklmnopqrstuvwx", assistant: "ok", tools: [] },
    ]),
  });
  const syncer = syncerFor({ pi, vaultRoot, statePath });
  await syncer.syncOnce({ reason: "test" });
  const raw = await readFile(
    path.join(vaultRoot, "09 Conversations/_raw/minih-minih-agent-plugins/2026-11/11111111.md"),
    "utf8",
  );
  assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwx"));
  assert.match(raw, /\[REDACTED TOKEN\]/);
});

test("iCloud conflict copies of this computer's files keep the newer one", async () => {
  const { vaultRoot, statePath } = await vault();
  const folder = "09 Conversations/minih-minih-agent-plugins/2026-11";
  await mkdir(path.join(vaultRoot, folder), { recursive: true });
  await writeFile(path.join(vaultRoot, folder, "keep.md"), `---\ndevice: "${DEVICE}"\nupdated: 2026-11-01\n---\ncanonical\n`);
  await writeFile(path.join(vaultRoot, folder, "keep 2.md"), `---\ndevice: "${DEVICE}"\nupdated: 2026-11-05\n---\nnewer copy\n`);
  await writeFile(path.join(vaultRoot, folder, "stale.md"), `---\ndevice: "${DEVICE}"\nupdated: 2026-11-09\n---\ncanonical newer\n`);
  await writeFile(path.join(vaultRoot, folder, "stale 2.md"), `---\ndevice: "${DEVICE}"\nupdated: 2026-11-02\n---\nold copy\n`);
  await writeFile(path.join(vaultRoot, folder, "foreign 2.md"), `---\ndevice: "other-mac"\nupdated: 2026-11-05\n---\nforeign\n`);
  // A canonical session file whose name ends in digits is not a conflict copy.
  await writeFile(path.join(vaultRoot, folder, "2026-11-08 Title 11111111.md"), `---\ndevice: "${DEVICE}"\nupdated: 2026-11-03\n---\ncanonical session\n`);
  const syncer = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [], nextCursor: "c1" }] }),
    vaultRoot,
    statePath,
  });
  const status = await syncer.syncOnce({ reason: "test" });
  assert.deepEqual(
    status.conflicts.map((entry) => [entry.path.split("/").pop(), entry.action]).sort(),
    [["foreign 2.md", "skipped"], ["keep 2.md", "promoted"], ["stale 2.md", "removed"]],
  );
  const files = (await readdir(path.join(vaultRoot, folder))).sort();
  assert.deepEqual(files, ["2026-11-08 Title 11111111.md", "foreign 2.md", "keep.md", "stale.md"]);
  assert.match(await readFile(path.join(vaultRoot, folder, "keep.md"), "utf8"), /newer copy/);
  assert.match(await readFile(path.join(vaultRoot, folder, "stale.md"), "utf8"), /canonical newer/);
});

test("start() runs once immediately and stop() clears the timer", async () => {
  const { vaultRoot, statePath } = await vault();
  const pi = fakePi({ pages: [{ enabled: true, items: [], nextCursor: "c1" }] });
  const syncer = syncerFor({ pi, vaultRoot, statePath, intervalMs: 20 });
  syncer.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await syncer.stop();
  assert.equal(syncer.timer, null);
  const calls = pi.calls.changes.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(pi.calls.changes.length, calls, "no further passes after stop()");
});

test("Obsidian's ignore filter gets the transcript folder appended, nothing else", async () => {
  const { vaultRoot, statePath } = await vault();
  await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  const appJson = {
    alwaysUpdateLinks: true,
    userIgnoreFilters: ["Templates/"],
    newLinkFormat: "shortest",
  };
  await writeFile(path.join(vaultRoot, ".obsidian", "app.json"), JSON.stringify(appJson, null, 2));

  const first = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [], nextCursor: "c1" }] }),
    vaultRoot,
    statePath,
  });
  await first.syncOnce({ reason: "test" });
  const once = JSON.parse(await readFile(path.join(vaultRoot, ".obsidian", "app.json"), "utf8"));
  assert.deepEqual(once.userIgnoreFilters, ["Templates/", "09 Conversations/_raw"]);
  assert.equal(once.alwaysUpdateLinks, true, "other settings are untouched");
  assert.equal(once.newLinkFormat, "shortest");

  // A second pass does not duplicate the entry.
  const second = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [], nextCursor: "c1" }] }),
    vaultRoot,
    statePath,
  });
  await second.syncOnce({ reason: "test" });
  const twice = JSON.parse(await readFile(path.join(vaultRoot, ".obsidian", "app.json"), "utf8"));
  assert.deepEqual(twice.userIgnoreFilters, ["Templates/", "09 Conversations/_raw"]);
});

test("no Obsidian config means no .obsidian folder is created", async () => {
  const { vaultRoot, statePath } = await vault();
  const syncer = syncerFor({
    pi: fakePi({ pages: [{ enabled: true, items: [], nextCursor: "c1" }] }),
    vaultRoot,
    statePath,
  });
  await syncer.syncOnce({ reason: "test" });
  const entries = await readdir(vaultRoot);
  assert.ok(!entries.includes(".obsidian"));
});
