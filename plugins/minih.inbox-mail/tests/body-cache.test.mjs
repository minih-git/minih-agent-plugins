import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { DEFAULT_MAX_BYTES, DIR_NAME, MAX_AGE_MS, createBodyCache } = require("../lib/body-cache.js");

/**
 * The body cache on its own: one directory, one index, one clock.
 *
 * Every rule the panel relies on is checked here against a directory the test owns
 * and a clock it moves by hand — no sleeping, no real 200 MB, no real month. What is
 * *not* checked here is where a body comes from: that is
 * `tests/plugin.test.mjs`, against a fake mailbox, because "the second open does
 * not download again" is a fact about the protocol traffic rather than about a
 * file.
 */

const raw = (text) => Buffer.from(`Subject: cached\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`);

function freshDir() {
  return mkdtempSync(join(tmpdir(), "inbox-body-cache-"));
}

function indexOf(dir) {
  const file = join(dir, "index.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function bodiesOf(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".eml")).sort() : [];
}

test("the cache keeps plain bytes under a hashed name, with a small index beside them", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    const body = raw("first open");
    assert.equal(await cache.write("acc_1", "uid:7:1", body, { size: body.length, truncated: false }), true);

    const read = await cache.read("acc_1", "uid:7:1");
    assert.equal(Buffer.compare(read.body, body), 0, "the bytes come back unchanged");
    assert.equal(read.size, body.length);
    assert.equal(read.truncated, false);

    // One file, named by a hash and nothing else: the message key never reaches the
    // filesystem.
    const files = bodiesOf(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{64}\.eml$/);
    assert.equal(readFileSync(join(dir, files[0]), "utf8"), body.toString("utf8"));

    // The index records what the panel reports: the key, the account, how big it is
    // and when it was last opened. It is what makes the size cheap to show.
    const index = indexOf(dir);
    assert.equal(index.version, 1);
    assert.equal(index.entries.length, 1);
    assert.deepEqual(
      { accountId: index.entries[0].accountId, key: index.entries[0].key, bytes: index.entries[0].bytes },
      { accountId: "acc_1", key: "uid:7:1", bytes: body.length },
    );
    assert.equal(index.entries[0].openedAt, 1000);
    assert.deepEqual(cache.stats(), { bytes: body.length, entries: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ceiling is 200 MB and the age limit is 30 days, not 'a while'", () => {
  assert.equal(DEFAULT_MAX_BYTES, 200 * 1024 * 1024);
  assert.equal(MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(DIR_NAME, "body-cache");
});

test("a body nobody opened for 30 days is dropped, and one opened yesterday is not", async () => {
  const dir = freshDir();
  try {
    let clock = 1_000_000;
    const cache = createBodyCache({ dir, now: () => clock });
    await cache.load();
    await cache.write("acc_1", "uid:7:1", raw("old"), { size: 10 });
    await cache.write("acc_1", "uid:7:2", raw("fresh"), { size: 10 });

    // A day short of the limit the second body still opens — and opening it is what
    // keeps it, which is the whole point of counting from the last open.
    clock += MAX_AGE_MS - 1;
    assert.notEqual(await cache.read("acc_1", "uid:7:2"), null, "a day short of 30 is still a hit");

    clock += 2;
    assert.equal(await cache.read("acc_1", "uid:7:1"), null, "past 30 days the unused entry is gone");
    assert.notEqual(await cache.read("acc_1", "uid:7:2"), null, "the one opened a moment ago stays");
    assert.equal(indexOf(dir).entries.length, 1, "the index no longer lists the expired one");
    assert.equal(bodiesOf(dir).length, 1, "and its bytes were deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write sweeps expired entries, so the directory cannot grow without bound", async () => {
  const dir = freshDir();
  try {
    let clock = 1_000_000;
    const cache = createBodyCache({ dir, now: () => clock });
    await cache.load();
    await cache.write("acc_1", "uid:7:1", raw("one"), { size: 3 });
    await cache.write("acc_1", "uid:7:2", raw("two"), { size: 3 });
    clock += MAX_AGE_MS + 1;
    await cache.write("acc_1", "uid:7:3", raw("three"), { size: 5 });
    const index = indexOf(dir);
    assert.deepEqual(index.entries.map((entry) => entry.key), ["uid:7:3"]);
    assert.equal(bodiesOf(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over the budget the least recently opened body goes first", async () => {
  const dir = freshDir();
  try {
    let clock = 1_000_000;
    const cache = createBodyCache({ dir, now: () => clock, maxBytes: 1000 });
    await cache.load();
    const chunk = Buffer.alloc(400, "a");
    await cache.write("acc_1", "m1", chunk, { size: 400 });
    clock += 10;
    await cache.write("acc_1", "m2", chunk, { size: 400 });
    clock += 10;
    // Opening m1 again makes m2 the oldest, even though it was stored later.
    assert.notEqual(await cache.read("acc_1", "m1"), null);
    clock += 10;
    await cache.write("acc_1", "m3", chunk, { size: 400 });

    assert.equal(await cache.read("acc_1", "m2"), null, "the least recently opened one was evicted");
    assert.notEqual(await cache.read("acc_1", "m1"), null);
    assert.notEqual(await cache.read("acc_1", "m3"), null);
    const stats = cache.stats();
    assert.equal(stats.entries, 2);
    assert.ok(stats.bytes <= 1000, `the budget holds, saw ${stats.bytes}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged file is a miss, and the entry that pointed at it is forgotten", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    const body = raw("intact");
    await cache.write("acc_1", "uid:7:1", body, { size: body.length });
    const [file] = bodiesOf(dir);

    // A half-written or truncated file is what a crash leaves behind.
    writeFileSync(join(dir, file), "Subject: c");
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
    assert.equal(await cache.read("acc_1", "uid:7:1"), null, "and it stays a miss instead of throwing");
    assert.deepEqual(indexOf(dir).entries, []);
    assert.deepEqual(bodiesOf(dir), [], "the broken bytes were removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged index means an empty cache, never an error", async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, "index.json"), "{ this is not json");
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0 });
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
    // And it recovers: the next write produces a readable index again.
    const body = raw("after damage");
    assert.equal(await cache.write("acc_1", "uid:7:1", body, { size: body.length }), true);
    assert.equal(indexOf(dir).entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unordered files left by a crash are removed at load", async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, `${"a".repeat(64)}.eml`), "orphan");
    writeFileSync(join(dir, `${"b".repeat(64)}.eml.tmp`), "half a write");
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    assert.deepEqual(bodiesOf(dir), []);
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a message key cannot choose a path outside the cache directory", async () => {
  const root = freshDir();
  const dir = join(root, "body-cache");
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    const body = raw("traversal");
    assert.equal(await cache.write("../evil", "../../etc/passwd", body, { size: body.length }), true);
    // Whatever the key said, the only thing beside the cache directory is nothing.
    assert.deepEqual(readdirSync(root).sort(), ["body-cache"]);
    assert.equal(bodiesOf(dir).length, 1, "the body is inside the cache, under a hash");
    assert.deepEqual((await cache.read("../evil", "../../etc/passwd")).body, body);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearing one mailbox keeps every other mailbox's bodies", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    await cache.write("acc_1", "uid:7:1", raw("one"), { size: 3 });
    await cache.write("acc_2", "uid:7:1", raw("two"), { size: 3 });
    await cache.clearAccount("acc_1");
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
    assert.notEqual(await cache.read("acc_2", "uid:7:1"), null);
    assert.equal(cache.stats().entries, 1);
    assert.equal(bodiesOf(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one message can be forgotten without touching its neighbours", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    await cache.write("acc_1", "uid:7:1", raw("one"), { size: 3 });
    await cache.write("acc_1", "uid:7:2", raw("two"), { size: 3 });
    await cache.remove("acc_1", "uid:7:1");
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
    assert.notEqual(await cache.read("acc_1", "uid:7:2"), null);
    assert.deepEqual(bodiesOf(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing everything leaves no body behind", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    await cache.write("acc_1", "uid:7:1", raw("one"), { size: 3 });
    await cache.write("acc_2", "uid:7:1", raw("two"), { size: 3 });
    await cache.clear();
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0 });
    assert.deepEqual(bodiesOf(dir), []);
    assert.deepEqual(indexOf(dir).entries, []);
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two opens of the same message at once leave one readable body", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    const first = raw("first download");
    const second = raw("second download, longer than the first");
    await Promise.all([
      cache.write("acc_1", "uid:7:1", first, { size: first.length }),
      cache.write("acc_1", "uid:7:1", second, { size: second.length }),
    ]);
    const read = await cache.read("acc_1", "uid:7:1");
    assert.ok(
      Buffer.compare(read.body, first) === 0 || Buffer.compare(read.body, second) === 0,
      "the file is one whole answer, never two halves",
    );
    assert.equal(read.size, read.body.length);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
      "no temporary file is left behind",
    );
    assert.equal(indexOf(dir).entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory that cannot be written is a cache that stores nothing, quietly", async () => {
  const dir = freshDir();
  try {
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "a file where the cache wants a directory");
    const cache = createBodyCache({ dir: join(blocked, "body-cache"), now: () => 1000 });
    await cache.load();
    assert.equal(await cache.write("acc_1", "uid:7:1", raw("nope"), { size: 4 }), false);
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty body is not a message, so nothing is stored for it", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    assert.equal(await cache.write("acc_1", "uid:7:1", Buffer.alloc(0), { size: 0 }), false);
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated body keeps saying it was truncated on every later open", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    const body = raw("first megabyte only");
    await cache.write("acc_1", "uid:7:1", body, { size: 5 * 1024 * 1024, truncated: true });
    const read = await cache.read("acc_1", "uid:7:1");
    assert.equal(read.truncated, true);
    assert.equal(read.size, 5 * 1024 * 1024, "the size the server reported is what the panel shows");
    assert.equal(read.body.length, body.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the panel's size question is also when a long-running app drops expired bodies", async () => {
  const dir = freshDir();
  try {
    let clock = 1_000_000;
    const cache = createBodyCache({ dir, now: () => clock });
    await cache.load();
    await cache.write("acc_1", "uid:7:1", raw("stale"), { size: 5 });
    clock += MAX_AGE_MS + 1;
    // Nothing was written for a month, so no write will ever sweep: the panel's
    // regular question about the size is the only clock this plugin has.
    cache.stats();
    await cache.flush();
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0 });
    assert.deepEqual(bodiesOf(dir), [], "the expired body left the disk without waiting for a write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a body still being written is removed when its message is deleted meanwhile", async () => {
  const dir = freshDir();
  try {
    const cache = createBodyCache({ dir, now: () => 1000 });
    await cache.load();
    const body = raw("racy");
    // A delete that lands while the body is still on its way to disk must not lose
    // to that write: the entry it left behind would be a body no message owns.
    const stored = cache.write("acc_1", "uid:7:1", body, { size: body.length });
    const removed = cache.remove("acc_1", "uid:7:1");
    await Promise.all([stored, removed]);
    assert.equal(await cache.read("acc_1", "uid:7:1"), null);
    assert.deepEqual(indexOf(dir).entries, []);
    assert.deepEqual(bodiesOf(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
