import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";
import { waitFor } from "./helpers/harness.mjs";

const require = createRequire(import.meta.url);

/**
 * The plugin process against a fake host.
 *
 * `lib/` is tested on its own elsewhere; this file is about the wiring that only
 * exists between the plugin and `pi` — the credential slot, the notification
 * centre call, the command registration, the schedule listener and the teardown.
 * That seam is where a plugin usually breaks in a released app while every unit
 * test stays green, so it is exercised through `onLoad()` the way the host calls
 * it: `globalThis.pi` set, no argument.
 */

const MAIN = require.resolve("../main.js");

function freshPlugin() {
  delete require.cache[MAIN];
  delete globalThis.pi;
  return require(MAIN);
}

/**
 * A host that hands the plugin an already-authenticated connection: `connect`
 * resolves without any greeting or login exchange, exactly like the real host.
 */
function fakeHost({ server, configured, settings = {}, locale = "en" }) {
  const dataPath = mkdtempSync(join(tmpdir(), "inbox-mail-"));
  const listeners = new Map();
  const notifications = [];
  const toasts = [];
  const commands = new Map();
  const state = { closed: 0, refused: 0 };
  const connectionId = "conn-1";

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      setImmediate(() => {
        try {
          handler(payload);
        } catch {
          // A throwing listener is the plugin's problem, not the test's.
        }
      });
    }
  };

  const pi = {
    plugin: {
      getDataPath: async () => dataPath,
      getSettings: async () => ({ ...settings }),
      setSettings: async () => undefined,
    },
    app: { getLocale: async () => locale },
    credentials: {
      list: async () => [{ id: "mailbox", configured }],
    },
    net: {
      tcp: {
        connect: async ({ endpoint }) => {
          if (!configured) throw Object.assign(new Error("not configured"), { code: "CREDENTIAL_NOT_CONFIGURED" });
          assert.equal(endpoint.port, 993);
          const transport = server.accept();
          transport.onData((bytes) => emit("net:tcp:data", { type: "data", connectionId, data: bytes }));
          transport.onClose((error) =>
            emit("net:tcp:close", { type: "close", connectionId, hadError: Boolean(error) }),
          );
          state.connected = { ...endpoint };
          return { connectionId, authenticated: true };
        },
        send: async ({ connectionId: id, data }) => {
          assert.equal(id, connectionId);
          await server.transport.send(data);
        },
        close: async () => {
          state.closed += 1;
          await server.transport.close();
        },
      },
    },
    events: {
      on: (event, handler) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      },
      off: (event, handler) => {
        listeners.get(event)?.delete(handler);
      },
    },
    notify: {
      center: async (input) => {
        notifications.push(input);
        return { id: `row-${notifications.length}` };
      },
    },
    commands: {
      register: async (command) => {
        commands.set(command.id, command);
      },
    },
    ui: { showToast: async (text) => toasts.push(text) },
  };

  return { pi, dataPath, notifications, toasts, commands, listeners, state, emit };
}

test("a plugin load registers its command, its timer and its checks", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ server, configured: true });
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    assert.deepEqual([...host.commands.keys()], ["check-now"]);
    assert.equal(host.listeners.get("schedule:fire")?.size, 1);
    assert.equal(host.listeners.get("plugin:settingsChanged")?.size, 1);
    // The socket listeners exist only while a connection does.
    await waitFor(() => host.state.connected, { label: "a connection" });
    await waitFor(() => host.listeners.get("net:tcp:data")?.size === 1, { label: "the socket listener" });
    assert.deepEqual(host.state.connected, { host: "imap.qq.com", port: 993 });
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an empty credential slot produces one explanation, not silence", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ server, configured: false });
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    await waitFor(() => host.notifications.length === 1, { label: "the setup notice" });
    const [notice] = host.notifications;
    assert.equal(notice.kind, "alert");
    assert.equal(notice.title, "Mailbox not connected");
    assert.match(notice.body, /credential/);
    // The same row is updated, so a retry cannot fill the notification list.
    assert.equal(notice.dedupeKey, "minih.inbox-mail:credentials");
    assert.deepEqual(notice.link, { command: "check-now" });
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a new important message becomes one alert row keyed by Message-ID", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    server,
    configured: true,
    settings: { provider: "qq", importantSenders: "boss@example.com", digestMinutes: 30 },
    locale: "zh-CN",
  });
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    await waitFor(() => server.idling, { label: "IDLE" });
    server.deliver(
      message({
        uid: 1,
        from: { name: "Boss", address: "boss@example.com" },
        subject: "预算复核",
        messageId: "<budget@example.com>",
      }),
    );
    await waitFor(() => host.notifications.length === 1, { label: "the alert" });
    const [row] = host.notifications;
    assert.equal(row.kind, "alert");
    assert.equal(row.title, "预算复核");
    assert.match(row.body, /Boss/);
    assert.equal(row.dedupeKey, "<budget@example.com>");
    assert.deepEqual(row.link, { command: "check-now" });
    // The body of the mail is never fetched, so it cannot leak into the row.
    assert.equal(server.sentLines.some((line) => line.includes("BODY[") && !line.includes("BODY.PEEK")), false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("the queue for the next digest is on disk, and nothing else is", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    server,
    configured: true,
    settings: { provider: "qq", importantSenders: "", keywords: "", digestMinutes: 30 },
    locale: "en",
  });
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    await waitFor(() => server.idling, { label: "IDLE" });
    server.deliver(message({ uid: 1, subject: "Weekly", messageId: "<weekly@example.com>" }));
    const file = join(host.dataPath, "inbox-mail.json");
    await waitFor(
      () => {
        try {
          return JSON.parse(readFileSync(file, "utf8")).pending.length === 1;
        } catch {
          return false;
        }
      },
      { label: "the persisted digest queue" },
    );
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.cursor, { uidValidity: 7, maxUid: 1 });
    assert.equal(saved.pending[0].messageId, "<weekly@example.com>");
    // The file holds the cursor and the envelope facts, never a body.
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes("bodyText"), false);
    assert.equal(host.notifications.length, 0, "30 minutes have not passed");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("unloading closes the connection and unsubscribes everything", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ server, configured: true });
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    await waitFor(() => server.idling, { label: "IDLE" });
    await plugin.onUnload();
    assert.ok(host.state.closed >= 1, "the socket was closed");
    for (const event of ["schedule:fire", "plugin:settingsChanged", "net:tcp:data", "net:tcp:close", "net:tcp:error"]) {
      assert.equal(host.listeners.get(event)?.size ?? 0, 0, `${event} is still subscribed`);
    }
    // A late tick after unload must not resurrect the watcher.
    host.emit("schedule:fire", { scheduleId: "poll", firedAt: Date.now(), missed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.connectCount, 1);
  } finally {
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("the command reports what it did through a toast", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ server, configured: true, settings: { provider: "qq" }, locale: "en" });
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    await waitFor(() => server.idling, { label: "IDLE" });
    await host.commands.get("check-now").run();
    await waitFor(() => host.toasts.length === 1, { label: "a toast" });
    assert.match(host.toasts[0], /Checked/);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});
