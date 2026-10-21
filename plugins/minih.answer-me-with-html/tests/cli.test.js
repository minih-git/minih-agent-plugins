"use strict";

/**
 * End-to-end check of the one thing the panel cannot work without: the `am`
 * CLI shipped inside this plugin writes a page into the data directory, and
 * `lib/pages.js` finds it there.
 *
 *   node --test tests/
 *
 * It runs the bundled CLI with `AM_HOME` pointing at a temporary directory, so
 * nothing lands in the user's own pages folder.
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const pages = require("../lib/pages");

const AM_SCRIPT = path.join(__dirname, "..", "skills", "answer-me-with-html", "scripts", "am.mjs");

let home;

function runAm(args, input) {
  return spawnSync(process.execPath, [AM_SCRIPT, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, AM_HOME: home },
    timeout: 60000,
  });
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "am-cli-test-"));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test("the bundled CLI is present and reports a version", () => {
  assert.ok(fs.existsSync(AM_SCRIPT), "the bundled am CLI is missing from the plugin");
  const result = runAm(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("a rendered page is listed by the panel's own library", () => {
  const draft = [
    "---",
    "title: Plugin smoke page",
    "---",
    "## A Why",
    "```flow",
    "A -> B: one step",
    "```",
    "",
  ].join("\n");
  const rendered = runAm(["render", "--no-open", "-"], draft);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  assert.match(rendered.stdout, /^✓ /m, "the CLI reports the page it wrote");

  const listed = pages.listPages(home);
  assert.equal(listed.total, 1);
  assert.equal(listed.pages[0].title, "Plugin smoke page");
  assert.equal(listed.pages[0].name, path.basename(listed.pages[0].name));
  assert.equal(pages.pagePath(home, listed.pages[0].name) !== null, true);
});

test("am clean is what the panel's clean-up button runs", () => {
  const before = pages.listPages(home).total;
  assert.ok(before > 0, "the previous case wrote a page");
  const cleaned = runAm(["clean", "--all"]);
  assert.equal(cleaned.status, 0, cleaned.stderr || cleaned.stdout);
  assert.equal(pages.listPages(home).total, 0, "am clean --all leaves no pages behind");
});
