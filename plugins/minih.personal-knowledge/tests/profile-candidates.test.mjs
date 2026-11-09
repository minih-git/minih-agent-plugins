import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import {
  CANDIDATE_INTERVAL_MS,
  candidateDue,
  profileSettingsPath,
  readProfileSettings,
  runProfileCandidate,
} from "../lib/profile-candidates.mjs";
import { isolatedHome } from "./helpers/home.mjs";

await isolatedHome();

const NOW = new Date("2026-11-09T08:00:00Z");

async function fixture() {
  // Each fixture owns its sandbox: `isolatedHome()` pins the env paths, but a
  // different Node process may have rewritten HOME in between.
  const sandbox = await isolatedHome();
  const root = sandbox;
  const vault = path.join(root, "Knowledge");
  const project = path.join(vault, "09 Conversations", "Demo");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(vault, "08 Standards"), { recursive: true });
  await mkdir(path.join(vault, "00 Inbox"), { recursive: true });
  await writeFile(
    path.join(vault, "08 Standards", "个人画像.md"),
    `---\ntitle: 个人画像\ntype: reference\nstatus: active\n---\n# 个人画像\n\n- 偏好证据驱动的结论。\n`,
  );
  await writeFile(
    path.join(project, "2026-11-08 Deploy pipeline 11111111.md"),
    `---\ntitle: "Deploy pipeline"\ntype: conversation\nsession_id: "11111111"\nproject: "Demo"\ndevice: "mac-a"\ncreated: 2026-11-08\nupdated: 2026-11-08\n---\n# Deploy pipeline\n\n## Goal\n\nShip the deploy pipeline.\n\n## Decisions\n\n- Reuse the ci-hub runner\n`,
  );
  const service = await new KnowledgeService({ vaultPath: vault, config: { backupRetentionDays: 0 }, now: () => NOW }).initialize();
  return { root, vault, service };
}

function fakePi({ text = "- 偏好：先出方案再实施（依据 2026-11-08）", memory = [] } = {}) {
  const calls = { complete: [], memory: [] };
  return {
    calls,
    agent: {
      async complete(input) {
        calls.complete.push(input);
        return { text, modelKey: input.modelKey };
      },
    },
    memory: {
      async list(input) {
        calls.memory.push(input);
        return { readEnabled: true, entries: memory, nextOffset: null };
      },
    },
  };
}

test("profile candidates are off by default and need a model key", async () => {
  assert.equal(candidateDue({}, NOW).reason, "DISABLED");
  assert.equal(candidateDue({ enabled: false, modelKey: "m" }, NOW).reason, "DISABLED");
  assert.equal(candidateDue({ enabled: true }, NOW).reason, "MODEL_REQUIRED");
  assert.equal(candidateDue({ enabled: true, modelKey: "m" }, NOW).due, true);
});

test("at most one candidate a week, counted from the last attempt", async () => {
  const settings = { enabled: true, modelKey: "m", lastRunAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() };
  const early = candidateDue(settings, NOW);
  assert.equal(early.due, false);
  assert.equal(early.reason, "TOO_SOON");
  assert.ok(Date.parse(early.nextEligibleAt) > NOW.getTime());
  const weekLater = candidateDue(settings, new Date(NOW.getTime() + CANDIDATE_INTERVAL_MS));
  assert.equal(weekLater.due, true);
});

test("a candidate note lands in 00 Inbox and the profile note is untouched", async () => {
  const { root, vault, service } = await fixture();
  const before = await readFile(path.join(vault, "08 Standards", "个人画像.md"), "utf8");
  const home = path.join(root, "home");
  const pi = fakePi({ memory: [{ id: "m1", kind: "preference", content: "偏好先出方案" }] });
  const result = await runProfileCandidate({
    service,
    pi,
    settings: { enabled: true, modelKey: "test-model" },
    now: NOW,
    home,
    env: {},
  });
  assert.equal(result.written, true, JSON.stringify(result));
  assert.equal(result.path.normalize("NFC"), "00 Inbox/画像候选 2026-11-09.md");

  // macOS stores file names in NFD, so resolve the file through the directory
  // listing instead of comparing the raw string.
  const written = (await readdir(path.join(vault, "00 Inbox"), "utf8").catch(() => []))
    .filter((name) => name.endsWith(".md"));
  assert.equal(written.length, 1);
  assert.equal(written[0].normalize("NFC"), "画像候选 2026-11-09.md");
  const candidate = await readFile(path.join(vault, "00 Inbox", written[0]), "utf8");
  assert.match(candidate, /先出方案再实施/);
  assert.match(candidate, /08 Standards\/个人画像\.md/, "the candidate names the note the user merges into");
  assert.match(candidate, /session 11111111/, "the evidence sessions are listed");
  assert.equal(await readFile(path.join(vault, "08 Standards", "个人画像.md"), "utf8"), before);

  assert.equal(pi.calls.complete.length, 1);
  assert.equal(pi.calls.complete[0].modelKey, "test-model");
  assert.equal(pi.calls.complete[0].includeSessionContext, false);
  assert.match(pi.calls.complete[0].messages[0].content, /Ship the deploy pipeline/);
  assert.match(pi.calls.complete[0].messages[0].content, /偏好先出方案/);

  const stored = await readProfileSettings(profileSettingsPath({ home, env: {} }));
  assert.equal(stored.lastRunAt, NOW.toISOString());
  assert.equal(stored.lastCandidate, result.path);
});

test("the weekly limit stops a second run and records nothing new", async () => {
  const { root, vault, service } = await fixture();
  const home = path.join(root, "home");
  const pi = fakePi();
  await writeFile(
    profileSettingsPath({ home, env: {} }),
    JSON.stringify({ enabled: true, modelKey: "m", lastRunAt: NOW.toISOString() }),
    { encoding: "utf8" },
  ).catch(async () => {
    await mkdir(path.join(home, ".personal-knowledge"), { recursive: true });
    await writeFile(profileSettingsPath({ home, env: {} }), JSON.stringify({ enabled: true, modelKey: "m", lastRunAt: NOW.toISOString() }));
  });
  const second = await runProfileCandidate({ service, pi, now: NOW, home, env: {} });
  assert.equal(second.written, false);
  assert.equal(second.reason, "TOO_SOON");
  assert.equal(pi.calls.complete.length, 0);
  assert.deepEqual(await readdir(path.join(vault, "00 Inbox")), []);
});

test("a failed model call records the attempt so it does not retry in a loop", async () => {
  const { root, service } = await fixture();
  const home = path.join(root, "home");
  const pi = {
    agent: {
      async complete() {
        throw Object.assign(new Error("upstream failed"), { code: "MODEL_ERROR" });
      },
    },
  };
  const result = await runProfileCandidate({
    service,
    pi,
    settings: { enabled: true, modelKey: "m" },
    now: NOW,
    home,
    env: {},
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, "MODEL_FAILED");
  const stored = await readProfileSettings(profileSettingsPath({ home, env: {} }));
  assert.equal(stored.lastError, "MODEL_ERROR");
  assert.equal(candidateDue(stored, NOW).reason, "TOO_SOON");
});

test("a manual run ignores the weekly window, while the scheduled path still waits", async () => {
  const { root, vault, service } = await fixture();
  const home = path.join(root, "home");
  const env = {};
  const pi = fakePi();
  const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

  // An attempt two days ago: automatic is blocked, the user's click is not.
  const settings = { enabled: true, modelKey: "test-model", lastRunAt: daysAgo(2) };
  const automatic = await runProfileCandidate({ service, pi, settings, now: NOW, home, env });
  assert.equal(automatic.written, false);
  assert.equal(automatic.reason, "TOO_SOON");
  assert.equal(pi.calls.complete.length, 0, "the schedule does not call the model inside the week");

  const manual = await runProfileCandidate({ service, pi, settings, manual: true, now: NOW, home, env });
  assert.equal(manual.written, true, JSON.stringify(manual));
  assert.equal(pi.calls.complete.length, 1, "a manual run does call the model");
  const written = (await readdir(path.join(vault, "00 Inbox"))).filter((name) => name.endsWith(".md"));
  assert.equal(written.length, 1);

  // The attempt is recorded, so the schedule restarts its week from here.
  const stored = await readProfileSettings(profileSettingsPath({ home, env }));
  assert.equal(stored.lastRunAt, NOW.toISOString());
  assert.equal(candidateDue(stored, new Date(NOW.getTime() + 86_400_000)).reason, "TOO_SOON");
  const nextWeek = await runProfileCandidate({ service, pi, settings: stored, now: new Date(NOW.getTime() + 7 * 86_400_000), home, env });
  assert.equal(nextWeek.written, true, "a week later the automatic path runs again");
});

test("a manual run still needs the switch and a model, and records failures", async () => {
  const { root, vault, service } = await fixture();
  const home = path.join(root, "home");
  const env = {};
  const longAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();

  const off = await runProfileCandidate({
    service,
    pi: fakePi(),
    settings: { enabled: false, modelKey: "test-model", lastRunAt: longAgo },
    manual: true,
    now: NOW,
    home,
    env,
  });
  assert.equal(off.written, false);
  assert.equal(off.reason, "DISABLED");

  const noModel = await runProfileCandidate({
    service,
    pi: fakePi(),
    settings: { enabled: true, lastRunAt: longAgo },
    manual: true,
    now: NOW,
    home,
    env,
  });
  assert.equal(noModel.written, false);
  assert.equal(noModel.reason, "MODEL_REQUIRED");
  assert.deepEqual(await readdir(path.join(vault, "00 Inbox")), [], "nothing is written when it refuses");

  // A failing manual run counts as the week's attempt too.
  const failing = {
    agent: {
      async complete() {
        throw Object.assign(new Error("upstream"), { code: "MODEL_ERROR" });
      },
    },
  };
  const failed = await runProfileCandidate({
    service,
    pi: failing,
    settings: { enabled: true, modelKey: "m", lastRunAt: longAgo },
    manual: true,
    now: NOW,
    home,
    env,
  });
  assert.equal(failed.reason, "MODEL_FAILED");
  const stored = await readProfileSettings(profileSettingsPath({ home, env }));
  assert.equal(stored.lastRunAt, NOW.toISOString());
  assert.equal(candidateDue(stored, NOW).reason, "TOO_SOON");
});
