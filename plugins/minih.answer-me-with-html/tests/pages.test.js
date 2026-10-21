"use strict";

/**
 * Offline tests for the page library. They need no app and no network:
 *
 *   node --test tests/
 *
 * `lib/pages.js` holds every decision the panel depends on — which names count
 * as pages, what is listed, what the summary counts — so these cases are the
 * contract the panel and the delete channel both rely on.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const pages = require("../lib/pages");

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "am-pages-test-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function home(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  return dir;
}

function writePage(dir, name, title, { at } = {}) {
  const full = path.join(dir, "pages", name);
  fs.writeFileSync(full, `<!doctype html><html><head><title>${title}</title></head><body></body></html>\n`);
  if (at) fs.utimesSync(full, at, at);
  return full;
}

test("amHome mirrors the CLI: AM_HOME wins, otherwise ~/.answer-me-with-html", () => {
  assert.equal(pages.amHome({}, "/home/pi"), path.join("/home/pi", ".answer-me-with-html"));
  assert.equal(pages.amHome({ AM_HOME: "/data/am" }, "/home/pi"), "/data/am");
  assert.equal(pages.amHome({ AM_HOME: "  " }, "/home/pi"), path.join("/home/pi", ".answer-me-with-html"));
  assert.equal(pages.amHome({ AM_HOME: "/data/am/../am2" }, "/home/pi"), path.resolve("/data/am2"));
});

test("isPageName accepts one html file name and nothing else", () => {
  assert.equal(pages.isPageName("Topic-20261021-101333.html"), true);
  assert.equal(pages.isPageName("Topic.HTML"), true);
  for (const bad of [
    "",
    ".",
    "..",
    "page.htm",
    "page.html.txt",
    "dir/page.html",
    "../page.html",
    "..\\page.html",
    "/etc/passwd.html",
    "page\0.html",
  ]) {
    assert.equal(pages.isPageName(bad), false, `${bad} must be refused`);
  }
});

test("pagePath stays directly inside pages/", () => {
  const dir = home("page-path");
  assert.equal(pages.pagePath(dir, "a.html"), path.join(dir, "pages", "a.html"));
  assert.equal(pages.pagePath(dir, "../a.html"), null);
  assert.equal(pages.pagePath(dir, "nested/a.html"), null);
  assert.equal(pages.pagePath(dir, "a.htm"), null);
});

test("titleOf reads the page title, decodes entities and falls back", () => {
  assert.equal(pages.titleOf("<title>TCP 三次握手</title>", "x"), "TCP 三次握手");
  assert.equal(pages.titleOf('<title>A &amp; B &quot;q&quot;</title>', "x"), 'A & B "q"');
  assert.equal(pages.titleOf("<title>\n  spread\n  out\n</title>", "x"), "spread out");
  assert.equal(pages.titleOf("<html></html>", "fallback"), "fallback");
  assert.equal(pages.titleOf("", "fallback"), "fallback");
});

test("listPages lists newest first and ignores everything that is not a page", () => {
  const dir = home("list");
  const older = new Date("2026-10-01T10:00:00Z");
  const newer = new Date("2026-10-20T10:00:00Z");
  writePage(dir, "Old-20261001-100000.html", "Old", { at: older });
  writePage(dir, "New-20261020-100000.html", "New", { at: newer });
  writePage(dir, "no-title.html", "", { at: new Date("2026-10-15T10:00:00Z") });
  fs.writeFileSync(path.join(dir, "pages", "notes.txt"), "not a page");
  fs.mkdirSync(path.join(dir, "pages", "sub.html"), { recursive: true });
  fs.symlinkSync(path.join(dir, "pages", "New-20261020-100000.html"), path.join(dir, "pages", "link.html"));

  const listed = pages.listPages(dir, { tmpdir: path.join(root, "no-such-tmp") });
  assert.deepEqual(
    listed.pages.map((page) => page.name),
    ["New-20261020-100000.html", "no-title.html", "Old-20261001-100000.html"],
  );
  assert.equal(listed.total, 3, "the directory, the .txt file and the symlink are not pages");
  assert.equal(listed.truncated, false);
  assert.equal(listed.pages[0].title, "New");
  assert.equal(listed.pages[1].title, "no-title.html", "a page without a title falls back to its file name");
  assert.ok(listed.pages[0].bytes > 0);
  assert.ok(listed.bytes >= listed.pages.reduce((sum, page) => sum + page.bytes, 0));
});

test("listPages reports a missing directory instead of throwing", () => {
  const dir = path.join(root, "does-not-exist");
  const listed = pages.listPages(dir, { tmpdir: path.join(root, "no-such-tmp") });
  assert.deepEqual(listed.pages, []);
  assert.equal(listed.total, 0);
  assert.equal(listed.bytes, 0);
  assert.deepEqual(
    listed.roots.map((entry) => [entry.id, entry.pagesDir, entry.count]),
    [["home", path.join(dir, "pages"), 0]],
  );
});

test("listPages honours the display limit and says it truncated", () => {
  const dir = home("limit");
  for (let index = 0; index < 5; index += 1) {
    writePage(dir, `Page-${index}.html`, `Page ${index}`, { at: new Date(Date.UTC(2026, 9, 1 + index)) });
  }
  const listed = pages.listPages(dir, { limit: 2, tmpdir: path.join(root, "no-such-tmp") });
  assert.equal(listed.pages.length, 2);
  assert.equal(listed.total, 5);
  assert.equal(listed.truncated, true);
  assert.equal(listed.pages[0].title, "Page 4");
});

test("usage counts pages, videos and cache, including nested files", () => {
  const dir = home("usage");
  writePage(dir, "a.html", "A");
  fs.mkdirSync(path.join(dir, "videos", "nested"), { recursive: true });
  fs.writeFileSync(path.join(dir, "videos", "one.webm"), "x".repeat(100));

test("dataRoots adds the CLI's fallback folder only when it is private", () => {
  const home = path.join(root, "roots-home");
  const tmp = path.join(root, "roots-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  assert.deepEqual(
    pages.dataRoots(home, { tmpdir: tmp }).map((entry) => entry.id),
    ["home"],
    "a fallback folder that does not exist is not a page location",
  );

  const spare = path.join(tmp, `answer-me-with-html-${process.getuid?.() ?? "u"}`);
  fs.mkdirSync(path.join(spare, "pages"), { recursive: true, mode: 0o700 });
  const ids = pages.dataRoots(home, { tmpdir: tmp }).map((entry) => entry.id);
  assert.deepEqual(ids, ["home", "temp"], "a private fallback folder is listed");

  fs.chmodSync(spare, 0o755);
  assert.deepEqual(
    pages.dataRoots(home, { tmpdir: tmp }).map((entry) => entry.id),
    ["home"],
    "a folder other users can enter is not read",
  );
});

test("listPages merges both folders and labels each row with its root", () => {
  const home = path.join(root, "merge-home");
  const tmp = path.join(root, "merge-tmp");
  const spare = path.join(tmp, `answer-me-with-html-${process.getuid?.() ?? "u"}`);
  fs.mkdirSync(path.join(home, "pages"), { recursive: true });
  fs.mkdirSync(path.join(spare, "pages"), { recursive: true, mode: 0o700 });
  fs.chmodSync(spare, 0o700);
  writePage(home, "Home-20261020-100000.html", "Home page", { at: new Date("2026-10-20T10:00:00Z") });
  fs.writeFileSync(
    path.join(spare, "pages", "Spare-20261021-100000.html"),
    "<title>Spare page</title>",
  );

  const listed = pages.listPages(home, { tmpdir: tmp });
  assert.deepEqual(
    listed.pages.map((page) => [page.root, page.title]),
    [
      ["temp", "Spare page"],
      ["home", "Home page"],
    ],
    "the newest page wins regardless of the folder it is in",
  );
  assert.equal(listed.total, 2);
  assert.deepEqual(
    listed.roots.map((entry) => [entry.id, entry.count]),
    [
      ["home", 1],
      ["temp", 1],
    ],
  );
  assert.equal(
    listed.bytes,
    listed.roots.reduce((sum, entry) => sum + entry.bytes, 0),
    "the total adds up the two folders",
  );
});

test("rootById resolves a folder id and refuses an unknown one", () => {
  const home = path.join(root, "root-by-id");
  const tmp = path.join(root, "root-by-id-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  assert.equal(pages.rootById(home, "home", { tmpdir: tmp })?.dir, home);
  assert.equal(pages.rootById(home, undefined, { tmpdir: tmp })?.id, "home", "the default is home");
  assert.equal(pages.rootById(home, "temp", { tmpdir: tmp }), null, "no fallback folder, no temp root");
  assert.equal(pages.rootById(home, "../etc", { tmpdir: tmp }), null);
});

test("usage counts pages and videos in both folders, cache only in home", () => {
  const home = path.join(root, "usage-both");
  const tmp = path.join(root, "usage-both-tmp");
  const spare = path.join(tmp, `answer-me-with-html-${process.getuid?.() ?? "u"}`);
  fs.mkdirSync(path.join(home, "pages"), { recursive: true });
  fs.mkdirSync(path.join(home, "videos"), { recursive: true });
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  fs.mkdirSync(path.join(spare, "videos"), { recursive: true, mode: 0o700 });
  fs.chmodSync(spare, 0o700);
  writePage(home, "a.html", "A");
  fs.writeFileSync(path.join(home, "videos", "one.webm"), "x".repeat(100));
  fs.writeFileSync(path.join(spare, "videos", "two.webm"), "x".repeat(50));
  fs.writeFileSync(path.join(home, "cache", "voice.bin"), "x".repeat(10));

  const used = pages.usage(home, { tmpdir: tmp });
  assert.equal(used.pages.count, 1);
  assert.equal(used.videos.count, 2);
  assert.equal(used.videos.bytes, 150, "videos from both folders count, as am clean walks them");
  assert.equal(used.cache.bytes, 10);
  assert.equal(used.total, used.pages.bytes + used.videos.bytes + used.cache.bytes);
});
  fs.writeFileSync(path.join(dir, "videos", "nested", "two.webm"), "x".repeat(50));
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cache", "voice.bin"), "x".repeat(10));

  const used = pages.usage(dir);
  assert.equal(used.pages.count, 1);
  assert.equal(used.videos.count, 2);
  assert.equal(used.videos.bytes, 150);
  assert.equal(used.cache.bytes, 10);
  assert.equal(used.total, used.pages.bytes + used.videos.bytes + used.cache.bytes);
});

test("formatBytes stays short", () => {
  assert.equal(pages.formatBytes(0), "0 B");
  assert.equal(pages.formatBytes(512), "512 B");
  assert.equal(pages.formatBytes(2048), "2 KB");
  assert.equal(pages.formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(pages.formatBytes(24 * 1024 * 1024), "24 MB");
  assert.equal(pages.formatBytes(undefined), "0 B");
});
