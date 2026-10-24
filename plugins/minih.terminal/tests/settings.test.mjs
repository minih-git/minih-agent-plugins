import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { openRequest, terminalDefaults } = require("../lib/settings.js");

test("a fresh install opens a terminal on the machine's first shell", () => {
  assert.deepEqual(terminalDefaults(), {
    profileId: null,
    directory: null,
    openOnView: true,
  });
  assert.deepEqual(terminalDefaults({}), {
    profileId: null,
    directory: null,
    openOnView: true,
  });
});

test("a chosen shell and directory reach the engine", () => {
  assert.deepEqual(
    terminalDefaults({ defaultShell: "bash", defaultDirectory: "/work/app" }),
    { profileId: "bash", directory: "/work/app", openOnView: true },
  );
});

test("auto means the machine decides, whatever case or padding it arrives in", () => {
  for (const value of ["auto", " AUTO ", ""]) {
    assert.equal(terminalDefaults({ defaultShell: value }).profileId, null, value);
  }
  assert.equal(terminalDefaults({ defaultShell: "  zsh " }).profileId, "zsh");
});

test("only an explicit false turns auto-open off", () => {
  assert.equal(terminalDefaults({ openOnView: false }).openOnView, false);
  // A settings file written by an older version has no such key.
  assert.equal(terminalDefaults({ openOnView: undefined }).openOnView, true);
  assert.equal(terminalDefaults({ openOnView: "false" }).openOnView, true);
});

test("a hand-edited settings file cannot crash the plugin", () => {
  assert.deepEqual(terminalDefaults(null), { profileId: null, directory: null, openOnView: true });
  assert.deepEqual(terminalDefaults("nonsense"), {
    profileId: null,
    directory: null,
    openOnView: true,
  });
  // Non-string values are ignored rather than stringified into a bad path.
  assert.deepEqual(terminalDefaults({ defaultShell: 7, defaultDirectory: ["/tmp"] }), {
    profileId: null,
    directory: null,
    openOnView: true,
  });
});

test("the dialog's choice wins over the configured default", () => {
  const defaults = terminalDefaults({ defaultShell: "bash", defaultDirectory: "/work" });
  assert.deepEqual(openRequest({ cwd: "/tmp/x", profileId: "zsh", cols: 100, rows: 30 }, defaults), {
    cwd: "/tmp/x",
    profileId: "zsh",
    cols: 100,
    rows: 30,
  });
});

test("auto-open sends nothing and gets the configured default", () => {
  const defaults = terminalDefaults({ defaultShell: "bash", defaultDirectory: "/work" });
  const auto = openRequest({ cwd: "", profileId: "", cols: 100, rows: 30 }, defaults);
  assert.deepEqual(auto, { cwd: "/work", profileId: "bash", cols: 100, rows: 30 });
  // No payload at all is the same request: the backend answers with settings.
  assert.deepEqual(openRequest(undefined, defaults), {
    cwd: "/work",
    profileId: "bash",
    cols: undefined,
    rows: undefined,
  });
});

test("with no configured default the engine picks, not the page", () => {
  // `undefined` is the engine's "use the first shell here / the home directory";
  // an empty string would be read as a missing directory instead.
  assert.deepEqual(openRequest({}, terminalDefaults()), {
    cwd: undefined,
    profileId: undefined,
    cols: undefined,
    rows: undefined,
  });
});