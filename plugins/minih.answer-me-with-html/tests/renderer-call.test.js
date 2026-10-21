"use strict";

/**
 * Offline tests for the card's channels (`onRendererCall`).
 *
 *   node --test tests/
 *
 * The card is the one channel that takes a path from the conversation instead of
 * from this plugin's own listing, so the rules it enforces are worth pinning
 * down: an absolute path, a plain `.html` name, a regular file, and the folder
 * it really lives in. `spawn` is replaced before `main.js` loads, so a test
 * never opens anything on this machine.
 */

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const childProcess = require("node:child_process");

/** Every `spawn` this test run caused: { file, args }. */
const spawned = [];

class FakeChild extends EventEmitter {
  unref() {}
}

childProcess.spawn = (file, args) => {
  spawned.push({ file, args });
  const child = new FakeChild();
  setImmediate(() => child.emit("spawn"));
  return child;
};

const clipboard = [];

globalThis.pi = {
  app: { getLocale: async () => "zh-CN" },
  plugin: { getId: () => "minih.answer-me-with-html", getSettings: async () => ({}), getDataPath: async () => home },
  ui: { showToast: () => {}, openPanel: async () => {}, closePanel: async () => {} },
  clipboard: { writeText: async (text) => clipboard.push(text) },
  commands: { register: async () => {}, unregister: async () => {} },
};

const { onRendererCall } = require("../main.js");

let home;
let outside;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "am-card-home-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "am-card-outside-"));
  process.env.AM_HOME = home;
  fs.mkdirSync(path.join(home, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "pages", "Topic-20261021-095532.html"),
    "<!doctype html><html><head><title>TCP 三次握手</title></head><body></body></html>\n",
  );
  fs.writeFileSync(path.join(home, "pages", "notes.txt"), "not a page");
  fs.mkdirSync(path.join(home, "pages", "folder.html"));
  fs.symlinkSync(
    path.join(home, "pages", "Topic-20261021-095532.html"),
    path.join(home, "pages", "link.html"),
  );
  fs.writeFileSync(path.join(outside, "elsewhere.html"), "<title>Elsewhere</title>");
});

after(() => {
  delete process.env.AM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const page = () => path.join(home, "pages", "Topic-20261021-095532.html");

test("pageInfo describes a page in the library", async () => {
  const info = await onRendererCall("pageInfo", { path: page() });
  assert.equal(info.ok, true);
  assert.equal(info.title, "TCP 三次握手");
  assert.equal(info.name, "Topic-20261021-095532.html");
  assert.equal(info.folder, "home", "a page under AM_HOME/pages is the library root");
  assert.ok(info.bytes > 0);
  assert.match(info.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("pageInfo labels a page outside the plugin's folders as elsewhere", async () => {
  const info = await onRendererCall("pageInfo", { path: path.join(outside, "elsewhere.html") });
  assert.equal(info.ok, true);
  assert.equal(info.folder, "other", "a page the Agent wrote elsewhere is still shown, and labelled");
  assert.equal(info.title, "Elsewhere");
});

test("pageInfo answers instead of throwing when the path is unusable", async () => {
  const cases = [
    [{}, "path"],
    [{ path: "" }, "path"],
    [{ path: "pages/Topic-20261021-095532.html" }, "absolute"],
    [{ path: path.join(home, "pages", "notes.txt") }, ".html"],
    [{ path: path.join(home, "pages", "missing.html") }, "page not found"],
    [{ path: path.join(home, "pages", "folder.html") }, "regular page file"],
    [{ path: path.join(home, "pages", "link.html") }, "regular page file"],
  ];
  for (const [args, expected] of cases) {
    const info = await onRendererCall("pageInfo", args);
    assert.equal(info.ok, false, `${JSON.stringify(args)} must be refused`);
    assert.match(info.error, new RegExp(expected, "i"), `${JSON.stringify(args)} → ${info.error}`);
  }
});

test("openPage falls back to the operating system when there is no browser API", async () => {
  spawned.length = 0;
  const result = await onRendererCall("openPage", { path: page() });
  assert.equal(result.ok, true);
  assert.equal(result.path, fs.realpathSync(page()));
  assert.equal(spawned.length, 1, "exactly one process is started");
  assert.equal(spawned[0].args.at(-1), fs.realpathSync(page()), "the page is the last argument");
});

test("openPage refuses before starting anything", async () => {
  spawned.length = 0;
  await assert.rejects(() => onRendererCall("openPage", { path: path.join(home, "pages", "missing.html") }), /page not found/);
  await assert.rejects(() => onRendererCall("openPage", { path: path.join(home, "pages", "notes.txt") }), /\.html/);
  await assert.rejects(() => onRendererCall("openPage", {}), /path/);
  assert.equal(spawned.length, 0, "a refused path never reaches the operating system");
});

test("copyPath copies the resolved path", async () => {
  clipboard.length = 0;
  const result = await onRendererCall("copyPath", { path: page() });
  assert.equal(result.ok, true);
  assert.deepEqual(clipboard, [fs.realpathSync(page())]);
  await assert.rejects(() => onRendererCall("copyPath", { path: "relative.html" }), /absolute/);
});

test("an unknown method is refused", async () => {
  await assert.rejects(() => onRendererCall("deleteEverything", {}), (error) => error.code === "UNSUPPORTED");
});

test("openPage prefers the app's browser panel when the host accepts the page", async () => {
  const navigated = [];
  globalThis.pi.browser = {
    navigate: async ({ path: target }) => {
      navigated.push(target);
      return { url: `file://${target}`, title: "TCP 三次握手", isLoading: false, canGoBack: false, canGoForward: false };
    },
  };
  spawned.length = 0;
  const result = await onRendererCall("openPage", { path: page() });
  assert.equal(result.ok, true);
  assert.equal(result.where, "app", "the in-app browser is tried first");
  assert.deepEqual(navigated, [fs.realpathSync(page())]);
  assert.equal(spawned.length, 0, "the operating system is not touched when the app accepted it");
  delete globalThis.pi.browser;
});

test("openPage falls back to the operating system when the app refuses", async () => {
  const cases = [
    async () => {
      throw Object.assign(new Error("Browser view must be visible"), { code: "UNAVAILABLE" });
    },
    async () => null,
    async () => ({ url: "file:///x", loadError: { message: "LOCAL_FILE_NOT_ALLOWED" } }),
  ];
  for (const navigate of cases) {
    globalThis.pi.browser = { navigate };
    spawned.length = 0;
    const result = await onRendererCall("openPage", { path: page() });
    assert.equal(result.ok, true, "a refusal in the app is not an error for the reader");
    assert.equal(result.where, "system");
    assert.equal(spawned.length, 1, "the page still opens, in the system browser");
  }
  delete globalThis.pi.browser;
});

test("the panel's own open channel uses the same two surfaces", async () => {
  const { onPanelInvoke } = require("../main.js");
  globalThis.pi.browser = { navigate: async ({ path: target }) => ({ url: `file://${target}`, title: "", isLoading: false }) };
  const inApp = await onPanelInvoke("am.openPage", { root: "home", name: "Topic-20261021-095532.html" });
  assert.equal(inApp.where, "app");

  globalThis.pi.browser = {
    navigate: async () => {
      throw new Error("browser unavailable");
    },
  };
  spawned.length = 0;
  const fallback = await onPanelInvoke("am.openPage", { root: "home", name: "Topic-20261021-095532.html" });
  assert.equal(fallback.where, "system");
  assert.equal(spawned.length, 1);
  delete globalThis.pi.browser;
});

/**
 * `main.js` remembers a refused browser permission for the life of its module.
 * A test that provokes PERMISSION_DENIED therefore loads a fresh copy instead of
 * leaving the latch closed for the tests after it.
 */
function freshMain() {
  const entry = require.resolve("../main.js");
  delete require.cache[entry];
  return require("../main.js");
}

test("a refused in-app open reports the host's own reason code", async () => {
  // The card turns `code` into one short sentence. Guessing the cause instead
  // (for example always saying "the panel is closed") would mislead the reader,
  // so each refusal keeps the code that produced it.
  const cases = [
    [async () => { throw Object.assign(new Error("Browser view must be visible"), { code: "UNAVAILABLE" }); }, "UNAVAILABLE"],
    [async () => null, "OTHER_SESSION"],
    [async () => ({ url: "file:///x", loadError: { message: "LOCAL_FILE_NOT_ALLOWED" } }), "LOAD_FAILED"],
    // Last: this one closes the latch for the module it runs in.
    [async () => { throw Object.assign(new Error("PERMISSION_DENIED"), { code: "PERMISSION_DENIED" }); }, "PERMISSION_DENIED"],
  ];
  for (const [navigate, expected] of cases) {
    globalThis.pi.browser = { navigate };
    const { onRendererCall: call } = freshMain();
    const result = await call("openPage", { path: page() });
    assert.equal(result.where, "system");
    assert.equal(result.code, expected, `expected ${expected}, got ${result.code}`);
    assert.ok(result.reason, "the host's message is passed through too");
  }
  delete globalThis.pi.browser;
});

test("a refused browser permission is remembered, so later clicks go straight to the system", async () => {
  const { onRendererCall: call } = freshMain();
  // The host answers PERMISSION_DENIED when the plugin was never granted
  // browser.cdp; asking again on every click would write one audit line per
  // click for a call that cannot succeed.
  let calls = 0;
  globalThis.pi.browser = {
    navigate: async () => {
      calls += 1;
      throw Object.assign(new Error("PERMISSION_DENIED"), { code: "PERMISSION_DENIED" });
    },
  };
  spawned.length = 0;
  const first = await call("openPage", { path: page() });
  const second = await call("openPage", { path: page() });
  assert.equal(first.where, "system");
  assert.equal(second.where, "system");
  assert.equal(calls, 1, "the refused API is not asked a second time");
  assert.equal(spawned.length, 2, "both clicks still open the page");
  delete globalThis.pi.browser;
});
