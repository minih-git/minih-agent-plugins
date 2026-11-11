import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { VaultIndex } from "../lib/vault-index.mjs";
import { isolatedHome } from "./helpers/home.mjs";

const home = await isolatedHome();
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await fs.mkdtemp(path.join(home, "parallel-scan-"));
  for (let i = 0; i < 18; i += 1) await fs.writeFile(path.join(root, `Note-${i}.md`), `# Note ${i}\n`);
  return root;
}

test("slow reads use a bounded parallel batch and report complete progress", async () => {
  const root = await fixture();
  const original = fs.readFile;
  const release = deferred();
  const fullBatch = deferred();
  let active = 0;
  let peak = 0;
  fs.readFile = async function (file, options) {
    if (!String(file).startsWith(root)) return original(file, options);
    active += 1;
    peak = Math.max(peak, active);
    if (active === 8) fullBatch.resolve();
    try { await release.promise; return await original(file, options); }
    finally { active -= 1; }
  };
  syncBuiltinESMExports();
  const index = new VaultIndex({ root });
  const progress = [];
  const pending = index.refresh({ onProgress: (value) => progress.push(value) });
  let deadline;
  try {
    await Promise.race([
      fullBatch.promise,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("slow reads are serialized")), 1000); }),
    ]);
    assert.equal(peak, 8);
    release.resolve();
    await pending;
    assert.equal(active, 0);
    assert.equal(index.paths().length, 18);
    assert.deepEqual(progress.at(-1), { phase: "read", completed: 18, total: 18 });
    assert.ok(progress.every((value) => value.completed <= value.total));
  } finally {
    clearTimeout(deadline);
    release.resolve();
    await pending;
    fs.readFile = original;
    syncBuiltinESMExports();
  }
});

test("one failed read cancels and drains other readers before retry", async () => {
  const root = await fixture();
  const original = fs.readFile;
  const batch = deferred();
  let active = 0;
  let entered = 0;
  fs.readFile = async function (file, options) {
    if (!String(file).startsWith(root)) return original(file, options);
    const first = entered++ === 0;
    active += 1;
    if (entered === 8) batch.resolve();
    try {
      await batch.promise;
      if (first) throw Object.assign(new Error("fixture read failed"), { code: "EIO" });
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    } finally { active -= 1; }
  };
  syncBuiltinESMExports();
  const index = new VaultIndex({ root });
  try {
    await assert.rejects(index.refresh(), /fixture read failed/);
    assert.equal(active, 0, "failure does not leave detached readers");
  } finally {
    fs.readFile = original;
    syncBuiltinESMExports();
  }
  await index.refresh({ force: true });
  assert.equal(index.paths().length, 18);
});

test("refresh throttle starts at completion, including a slow first scan", async () => {
  const root = await fixture();
  let clock = 10000;
  const index = new VaultIndex({ root, now: () => new Date(clock) });
  const progress = [];
  await index.refresh({ onProgress: (value) => { progress.push(value); clock += 2000; } });
  const version = index.version;
  await index.refresh();
  assert.equal(index.version, version, "the completed scan is not immediately repeated");
});
