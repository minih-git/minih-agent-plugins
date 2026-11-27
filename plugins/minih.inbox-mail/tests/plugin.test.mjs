import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";
import { createFakePop3Server, popMessage } from "./helpers/fake-pop3.mjs";
import { waitFor } from "./helpers/harness.mjs";

const require = createRequire(import.meta.url);
const MAIN = require.resolve("../main.js");
const PLUGIN_ROOT = dirname(MAIN);

/**
 * The plugin process against a fake host that behaves like Desktop 1.9.0.
 *
 * `lib/` is tested on its own elsewhere; this file is about the wiring that only
 * exists between the plugin and `pi` — the multi-instance credential slot, the
 * panel channels that cross the bridge, the notification centre, the command, the
 * `credentials:changed` subscription and the teardown. That seam is where a
 * plugin breaks while every unit test stays green, so it runs through `onLoad()`
 * the way the host calls it: `globalThis.pi` set, no argument.
 */

function freshPlugin() {
  delete require.cache[MAIN];
  delete globalThis.pi;
  return require(MAIN);
}

function coded(code, text) {
  return Object.assign(new Error(text), { code });
}

/** One full RFC 822 message, for the body the reading pane asks for. */
function rawMessage({ subject = "Subject", text = "hello", html } = {}) {
  if (!html) {
    return [
      `Subject: ${subject}`,
      "From: Boss <boss@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      "",
    ].join("\r\n");
  }
  const boundary = "B0";
  return [
    `Subject: ${subject}`,
    "From: Boss <boss@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * A host with one `multiple` credential slot.
 *
 * `servers` is keyed by `mailbox#<instanceId>`, which is exactly the reference the
 * plugin must send: a host that receives a bare `mailbox` for a multi-instance
 * slot refuses the connection, and this fake refuses it the same way.
 */
function fakeHost({ instances = [], settings = {}, locale = "en", servers = {}, addAccount } = {}) {
  const dataPath = mkdtempSync(join(tmpdir(), "inbox-mail-"));
  const listeners = new Map();
  const notifications = [];
  const toasts = [];
  const opened = [];
  const commands = new Map();
  const connections = new Map();
  const accounts = instances.map((entry) => ({ ...entry }));
  const state = {
    closed: 0,
    connects: [],
    /** Every `pi.mail.send` request, in order. */
    sends: [],
    /** Every `pi.fs.saveAs` call: what was suggested, and the bytes handed over. */
    saves: [],
    /** What the fake save dialog does next: `save`, `cancel` or `busy`. */
    saveBehaviour: "save",
    /** What `mail.send` answers with, or the coded refusal it throws. */
    sendAnswer: null,
    sendError: null,
    /** The agent tools the plugin registered, by name — what the host would list. */
    tools: new Map(),
  };
  let connectionSeq = 0;
  let instanceSeq = 100;

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

  const slot = () => ({
    id: "mailbox",
    configured: accounts.length > 0,
    multiple: true,
    max: 5,
    instances: accounts.map((entry) => ({
      instanceId: entry.instanceId,
      label: entry.username,
      // `fields` carries the four non-secret fields of an account whose server
      // the user typed, which a 1.10.0 host publishes here.
      publicFields: { username: entry.username, ...entry.fields },
      configured: true,
    })),
  });

  const pi = {
    plugin: {
      getDataPath: async () => dataPath,
      getSettings: async () => ({ ...settings }),
      setSettings: async () => undefined,
    },
    app: { getLocale: async () => locale },
    credentials: {
      list: async () => [slot()],
      requestAdd: async (slotId) => {
        assert.equal(slotId, "mailbox");
        if (addAccount) return addAccount({ accounts, emit });
        instanceSeq += 1;
        const username = `added${instanceSeq}@gmail.com`;
        accounts.push({ instanceId: `acc_${instanceSeq}`, username });
        emit("credentials:changed", { slotId });
        return { instanceId: `acc_${instanceSeq}` };
      },
      requestRemove: async (slotId, instanceId) => {
        assert.equal(slotId, "mailbox");
        const index = accounts.findIndex((entry) => entry.instanceId === instanceId);
        if (index < 0) throw coded("CREDENTIAL_NOT_CONFIGURED", "not configured");
        accounts.splice(index, 1);
        emit("credentials:changed", { slotId });
        return { removed: true };
      },
    },
    // `mail.send`: the host's own submission session. It records exactly what the
    // plugin asked for — the endpoint it named or the fact that it named none —
    // and answers with the outcome the host would.
    mail: {
      send: async (request) => {
        state.sends.push(request);
        if (state.sendError) throw state.sendError;
        return state.sendAnswer ?? { accepted: [...request.envelope.to], rejected: [] };
      },
    },
    // `fs.saveAs`: the host's own save dialog. A test decides whether it writes,
    // returns nothing (a cancelled dialog) or answers `SAVE_AS_BUSY`.
    fs: {
      saveAs: async ({ suggestedName, data, mimeType }) => {
        state.saves.push({
          name: suggestedName,
          mimeType,
          bytes: Buffer.from(data),
        });
        if (state.saveBehaviour === "busy") throw coded("SAVE_AS_BUSY", "a save dialog is already open");
        if (state.saveBehaviour === "cancel") return null;
        return { path: `${dataPath}/${suggestedName}`, name: suggestedName };
      },
    },
    net: {
      tcp: {
        connect: async ({ endpoint, credentialRef }) => {
          // An account whose server the user typed passes no endpoint at all: the
          // host reads it from the instance. A preset one names it, and 993 is
          // the only IMAP port this plugin's providers use.
          if (endpoint === undefined) {
            assert.match(String(credentialRef), /^mailbox#/, "an instance is what binds the endpoint");
          } else {
            assert.equal(endpoint.port, 993);
          }
          if (!String(credentialRef).includes("#")) {
            throw coded("CREDENTIAL_INSTANCE_REQUIRED", "name an instance of the slot");
          }
          const server = servers[credentialRef];
          if (!server) throw coded("CREDENTIAL_NOT_CONFIGURED", "the mailbox credential slot is empty");
          connectionSeq += 1;
          const connectionId = `conn-${connectionSeq}`;
          const transport = server.accept();
          transport.onData((bytes) => emit("net:tcp:data", { type: "data", connectionId, data: bytes }));
          transport.onClose((error) =>
            emit("net:tcp:close", { type: "close", connectionId, hadError: Boolean(error) }),
          );
          connections.set(connectionId, { transport, credentialRef });
          state.connects.push({ credentialRef, endpoint: endpoint ?? null, host: endpoint?.host ?? null });
          return { connectionId, authenticated: true };
        },
        send: async ({ connectionId, data }) => {
          const entry = connections.get(connectionId);
          if (!entry) throw coded("NOT_FOUND", "no such connection");
          await entry.transport.send(data);
        },
        close: async ({ connectionId }) => {
          state.closed += 1;
          const entry = connections.get(connectionId);
          connections.delete(connectionId);
          await entry?.transport.close();
        },
      },
    },
    // `pi.agent`: the surface behind `agent.tool.register`. It records the tools
    // exactly as the broker would, so a test can call one the way the agent does.
    agent: {
      registerTool: async (tool) => {
        state.tools.set(tool.name, tool);
      },
      unregisterTool: async (name) => {
        state.tools.delete(name);
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
    shell: {
      openExternal: async ({ url }) => {
        opened.push(url);
        return { ok: true };
      },
    },
    commands: {
      register: async (command) => {
        commands.set(command.id, command);
      },
    },
    ui: { showToast: async (text) => toasts.push(text) },
  };

  return {
    pi,
    dataPath,
    notifications,
    toasts,
    opened,
    commands,
    listeners,
    state,
    accounts,
    connections,
    emit,
  };
}

/** A single-account host with the address the tests use. */
function oneAccount(address = "owner@qq.com", extra = {}) {
  return { instanceId: "acc_1", username: address, ...extra };
}

async function loadWith(host) {
  const plugin = freshPlugin();
  globalThis.pi = host.pi;
  await plugin.onLoad();
  return plugin;
}

async function panel(plugin, channel, payload) {
  return plugin.onPanelInvoke(channel, payload);
}

function readState(host) {
  const file = join(host.dataPath, "accounts.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A poll saves the whole file atomically enough for the app, but a test can
    // catch it mid-write; "not yet" is the honest answer.
    return null;
  }
}

/**
 * Wait until each instance has completed one poll.
 *
 * There is no long-lived connection any more, so "the mailbox is being watched"
 * is no longer the same as "the server is idling": what proves a poll happened is
 * the cursor (IMAP) or the baseline (POP3) in the plugin's own file.
 */
async function waitForPolls(host, instanceIds = ["acc_1"]) {
  await waitFor(
    () => {
      const saved = readState(host);
      return instanceIds.every((id) => {
        const account = saved?.accounts?.[id];
        return Boolean(account?.cursor || account?.pop3?.baselined);
      });
    },
    { label: `the first poll of ${instanceIds.join(", ")}` },
  );
}

test("two mailboxes are watched on one connection each and listed together", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const work = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com"), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": work },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    assert.equal(snapshot.accounts.length, 2);
    assert.deepEqual(
      snapshot.accounts.map((account) => account.provider.id).sort(),
      ["netease163", "qq"],
      "the provider is inferred per account",
    );
    assert.equal(snapshot.accounts.every((account) => account.status.phase !== "needs-provider"), true);
    // Each account dialled its own instance, not the bare slot.
    assert.deepEqual(
      host.state.connects.map((entry) => entry.credentialRef).sort(),
      ["mailbox#acc_1", "mailbox#acc_2"],
    );
    assert.equal(host.state.connects.find((entry) => entry.credentialRef === "mailbox#acc_2").host, "imap.163.com");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("important mail reaches both inboxes without notification centre entries", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const work = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com"), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": work },
    settings: { importantSenders: "boss@example.com" },
    locale: "zh-CN",
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    const entry = {
      uid: 1,
      from: { name: "Boss", address: "boss@example.com" },
      subject: "预算",
      messageId: "<same@example.com>",
    };
    personal.deliver(message(entry));
    work.deliver(message(entry));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 2, {
      label: "mail from both accounts",
    });
    assert.deepEqual(host.notifications, [], "even important mail stays out of the notification centre");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("opening a message downloads that one body, capped, and writes none of it", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(
      message({
        uid: 1,
        subject: "季度报告",
        messageId: "<q@example.com>",
        raw: rawMessage({ subject: "季度报告", text: "见附件", html: "<p>见<b>附件</b></p>" }),
      }),
    );
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    const result = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<q@example.com>" });
    assert.equal(result.ok, true);
    assert.equal(result.message.subject, "季度报告");
    assert.equal(result.message.text.trim(), "见附件");
    assert.equal(result.message.html, "<p>见<b>附件</b></p>");
    assert.equal(result.message.truncated, false);
    // Exactly one body fetch, and it was a peek with the 1 MiB cap.
    assert.equal(server.bodyFetches.length, 1);
    assert.equal(server.bodyFetches[0].uid, 1);
    const fetchLine = server.sentLines.find((line) => line.includes("BODY.PEEK[]"));
    assert.match(fetchLine, /BODY\.PEEK\[\]<0\.1048576>/);
    const plainBodyFetch = server.sentLines.filter((line) => /[^.]BODY\[\]/.test(line));
    assert.equal(plainBodyFetch.length, 0, "a plain BODY[] would set \\Seen");
    // Nothing of the body reached the data file.
    const saved = JSON.stringify(readState(host));
    assert.equal(saved.includes("见附件"), false);
    assert.equal(saved.includes("附件"), false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a body larger than the cap is reported as truncated", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.sizeOverride = 2 * 1024 * 1024;
    server.deliver(
      message({
        uid: 1,
        messageId: "<big@example.com>",
        raw: "Subject: big\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody",
      }),
    );
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    const result = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<big@example.com>" });
    assert.equal(result.ok, true);
    assert.equal(result.message.truncated, true, "a capped fetch must say so instead of pretending it has the whole mail");
    assert.equal(result.message.size, 2 * 1024 * 1024);
    assert.equal(result.message.text.trim(), "body");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("marking read sends exactly one STORE, and the panel list follows", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<m@example.com>" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, true);

    const seen = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "<m@example.com>", flag: "seen" });
    assert.equal(seen.ok, true);
    assert.deepEqual(seen.flags, ["\\Seen"]);
    assert.equal(server.stores.length, 1);
    assert.equal(server.stores[0], "UID STORE 1 +FLAGS (\\Seen)");
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, false);

    const starred = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "<m@example.com>", flag: "flagged" });
    assert.equal(starred.ok, true);
    assert.equal(server.stores[1], "UID STORE 1 +FLAGS (\\Flagged)");
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].starred, true);

    await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "<m@example.com>", flag: "unseen" });
    assert.equal(server.stores[2], "UID STORE 1 -FLAGS (\\Seen)");
    // The file follows the mailbox, so a restart shows the same list.
    const saved = readState(host);
    assert.deepEqual(saved.accounts.acc_1.messages[0].flags, ["\\Flagged"]);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("opening a message marks it read with one STORE, and the list follows", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<read@example.com>", raw: rawMessage({ text: "hello" }) }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, true);

    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<read@example.com>" });
    assert.equal(opened.ok, true);
    assert.equal(opened.message.readError, null);
    // Exactly one STORE, on that message, and it is the Seen flag.
    assert.deepEqual(server.stores, ["UID STORE 1 +FLAGS (\\Seen)"]);
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, false);
    // The body fetch is still a peek: the STORE is what marks it read.
    const fetchLine = server.sentLines.find((line) => line.includes("BODY.PEEK[]"));
    assert.match(fetchLine, /BODY\.PEEK\[\]<0\.1048576>/);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a message that is already read is not stored again", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(
      message({
        uid: 1,
        messageId: "<seen@example.com>",
        flags: ["\\Seen"],
        raw: rawMessage({ text: "already read" }),
      }),
    );
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, false);

    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<seen@example.com>" });
    assert.equal(opened.ok, true);
    assert.equal(server.stores.length, 0, "a second STORE would only be noise on the server");
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("no mailbox and a mailbox with no provider stay out of the notification centre", async () => {
  for (const instances of [[], [oneAccount("ceo@example.com")]]) {
    const host = fakeHost({ instances });
    const plugin = await loadWith(host);
    try {
      assert.deepEqual(host.notifications, []);
      assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.accounts.length, instances.length);
    } finally {
      await plugin.onUnload();
      rmSync(host.dataPath, { recursive: true, force: true });
    }
  }
});

test("a body that failed to arrive is not marked read", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<broken@example.com>" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    server.failFetch = true;
    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<broken@example.com>" });
    assert.equal(opened.ok, false);
    assert.equal(server.stores.length, 0, "no body, no read mark");
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, true);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a flag the panel invents is refused, and nothing is sent", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const result = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "<x>", flag: "deleted" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_ARGUMENT");
    assert.equal(server.stores.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a body the server refuses comes back as a coded error, not an empty message", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<bad@example.com>" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "the message list",
    });
    server.failFetch = true;
    const result = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<bad@example.com>" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "IMAP_NO");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an account with no provider says so once, and the panel cannot pick one", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("ceo@example.com")],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts[0].provider, null);
    assert.equal(snapshot.accounts[0].status.phase, "needs-provider");
    assert.deepEqual(host.notifications, []);
    assert.equal(host.state.connects.length, 0, "nothing is dialled on a guess");

    // The old panel channel is gone on purpose: the choice belongs to the host's
    // account form, and a plugin that kept a second picker would fight it.
    const picked = await panel(plugin, "inbox.setProvider", { instanceId: "acc_1", providerId: "tencentExmail" });
    assert.equal(picked.ok, false);
    assert.equal(picked.code, "UNSUPPORTED");
    assert.equal(host.state.connects.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an account whose provider is set to a custom server but has no server waits for one", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [{ instanceId: "acc_1", username: "ceo@example.com", fields: { provider: "custom" } }],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts[0].missingServer, true);
    assert.equal(snapshot.accounts[0].status.phase, "needs-server");
    assert.equal(host.state.connects.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a provider that needs OAuth2 is refused instead of connected", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("ceo@example.com")],
    servers: { "mailbox#acc_1": server },
  });
  // A 0.2.0 account could have Outlook stored; the field no longer offers it, but
  // the stored value still reaches the connect path, which refuses it.
  writeFileSync(
    join(host.dataPath, "accounts.json"),
    JSON.stringify({ version: 2, accounts: { acc_1: {} }, providers: { acc_1: "outlook" } }),
    "utf8",
  );
  const plugin = await loadWith(host);
  try {
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.accounts[0]?.status?.lastError?.includes("PROVIDER_NEEDS_OAUTH"), {
      label: "the account error",
    });
    assert.deepEqual(host.notifications, []);
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts[0].provider.id, "outlook");
    assert.equal(snapshot.accounts[0].provider.available, false);
    assert.equal(host.state.connects.length, 0, "OAuth2 is not attempted with a password");
    assert.match(snapshot.accounts[0].status.lastError, /PROVIDER_NEEDS_OAUTH/);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("adding a mailbox asks the host and starts watching the new instance", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const added = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount()],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_101": added },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const result = await panel(plugin, "inbox.addAccount");
    assert.equal(result.ok, true);
    assert.equal(result.instanceId, "acc_101");
    await waitForPolls(host, ["acc_1", "acc_101"]);
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.accounts.find((account) => account.instanceId === "acc_101").provider.id, "gmail");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a refused add carries the host's code to the panel", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount()],
    servers: { "mailbox#acc_1": server },
    addAccount: async () => {
      throw coded("CREDENTIAL_LIMIT", "the credential slot holds as many instances as its manifest allows");
    },
  });
  const plugin = await loadWith(host);
  try {
    const result = await panel(plugin, "inbox.addAccount");
    assert.equal(result.ok, false);
    assert.equal(result.code, "CREDENTIAL_LIMIT", "the panel needs the code, not a translated string");
    assert.equal(result.message.includes("as many instances"), true);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("removing a mailbox closes its connection and forgets only its state", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const work = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com"), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": work },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    personal.deliver(message({ uid: 1, messageId: "<keep@example.com>" }));
    work.deliver(message({ uid: 1, messageId: "<drop@example.com>" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(() => readState(host)?.accounts?.acc_2?.messages?.length === 1, { label: "both lists" });

    const result = await panel(plugin, "inbox.removeAccount", { instanceId: "acc_2" });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    await waitFor(() => !readState(host).accounts.acc_2, { label: "the removed account's state" });
    const saved = readState(host);
    assert.equal(saved.accounts.acc_1.messages.length, 1, "the other mailbox is untouched");
    assert.equal(saved.providers.acc_2, undefined);
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.deepEqual(snapshot.accounts.map((account) => account.instanceId), ["acc_1"]);
    assert.deepEqual(snapshot.messages.map((entry) => entry.key), ["<keep@example.com>"]);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a mailbox added in Settings is picked up from credentials:changed", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const added = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount()],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": added },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    // The host is what added this one; the plugin only hears about it.
    host.accounts.push({ instanceId: "acc_2", username: "someone@126.com" });
    host.emit("credentials:changed", { slotId: "mailbox" });
    await waitForPolls(host, ["acc_1", "acc_2"]);
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.accounts.find((account) => account.instanceId === "acc_2").provider.id, "netease126");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("the 0.1.0 state is adopted once, then the old file is gone", async () => {
  const server = createFakeServer({ uidNext: 60 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com")],
    servers: { "mailbox#acc_1": server },
    // The old sheet's provider is still in the host's store.
    settings: { provider: "netease163", digestMinutes: 30 },
  });
  writeFileSync(
    join(host.dataPath, "inbox-mail.json"),
    JSON.stringify({
      version: 1,
      cursor: { uidValidity: 7, maxUid: 42 },
      seen: ["<old@example.com>"],
      pending: [{ uid: 42, uidValidity: 7, messageId: "<old@example.com>", from: { address: "a@b.c" }, subject: "old" }],
      pendingSince: 1000,
      lastCheckAt: 2000,
      lastError: null,
    }),
    "utf8",
  );
  let plugin = await loadWith(host);
  try {
    await waitFor(() => readState(host)?.accounts?.acc_1?.cursor?.maxUid === 42, { label: "the adopted cursor" });
    const saved = readState(host);
    assert.deepEqual(saved.accounts.acc_1.seen, ["<old@example.com>"]);
    assert.equal(saved.accounts.acc_1.pending.length, 1);
    assert.equal(saved.providers.acc_1, "netease163", "the old global provider belongs to the one migrated account");
    assert.equal(existsSync(join(host.dataPath, "inbox-mail.json")), false, "the 0.1.0 file is removed after adoption");

    // Restart on the same data directory: the migration must not run again.
    await plugin.onUnload();
    plugin = await loadWith(host);
    await waitForPolls(host);
    const again = readState(host);
    assert.deepEqual(again.accounts.acc_1.cursor, { uidValidity: 7, maxUid: 42 });
    assert.equal(again.accounts.acc_1.seen.length, 1);
    assert.equal(existsSync(join(host.dataPath, "inbox-mail.json")), false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a 0.1.0 file is left alone when there are two accounts to choose from", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const work = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com"), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": work },
  });
  writeFileSync(join(host.dataPath, "inbox-mail.json"), JSON.stringify({ cursor: { uidValidity: 7, maxUid: 9 } }), "utf8");
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    // Guessing would silence one mailbox; leaving the file is the honest choice.
    assert.equal(existsSync(join(host.dataPath, "inbox-mail.json")), true);
    // Neither cursor is the legacy one: the watchers baseline from the server.
    assert.notEqual(readState(host).accounts.acc_1.cursor?.maxUid, 9);
    assert.notEqual(readState(host).accounts.acc_2.cursor?.maxUid, 9);
    assert.deepEqual(readState(host).accounts.acc_1.seen, []);
    assert.deepEqual(readState(host).accounts.acc_2.seen, []);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("the command checks every account and says how many it looked at", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const work = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com"), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": work },
    settings: { importantSenders: "boss@example.com" },
    locale: "en",
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    personal.add(message({ uid: 1, from: { name: "Boss", address: "boss@example.com" } }));
    await host.commands.get("check-now").run();
    await waitFor(() => host.toasts.length === 1, { label: "a toast" });
    assert.match(host.toasts[0], /^Checked 2 mailboxes: 1 new message/);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a panel channel the plugin does not have is refused, not guessed", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    const result = await panel(plugin, "inbox.deleteEverything");
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNSUPPORTED");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("web mailbox and message links are opened by the host, never inside the panel", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const webmail = await panel(plugin, "inbox.openWebmail", { instanceId: "acc_1" });
    assert.equal(webmail.ok, true);
    assert.equal(host.opened[0], "https://mail.qq.com/");
    const link = await panel(plugin, "inbox.openExternal", { url: "https://example.com/a?b=1" });
    assert.equal(link.ok, true);
    assert.equal(host.opened[1], "https://example.com/a?b=1");
    // Anything that is not a web or mail link is refused.
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", ""]) {
      const result = await panel(plugin, "inbox.openExternal", { url: bad });
      assert.equal(result.ok, false, `${bad} must not be opened`);
      assert.equal(result.code, "INVALID_ARGUMENT");
    }
    assert.equal(host.opened.length, 2);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("unloading closes every connection and unsubscribes everything", async () => {
  const personal = createFakeServer({ uidNext: 1 });
  const work = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("owner@qq.com"), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": personal, "mailbox#acc_2": work },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    await plugin.onUnload();
    assert.ok(host.state.closed >= 2, "both sockets were closed");
    for (const event of ["schedule:fire", "plugin:settingsChanged", "credentials:changed", "net:tcp:data", "net:tcp:close", "net:tcp:error"]) {
      assert.equal(host.listeners.get(event)?.size ?? 0, 0, `${event} is still subscribed`);
    }
    // A late tick after unload must not resurrect a watcher.
    const before = host.state.connects.length;
    host.emit("schedule:fire", { scheduleId: "poll", firedAt: Date.now(), missed: 0 });
    host.emit("credentials:changed", { slotId: "mailbox" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(host.state.connects.length, before);
    // And a panel call after unload answers instead of throwing.
    const result = await plugin.onPanelInvoke("inbox.snapshot", {});
    assert.equal(result.ok, false);
    assert.equal(result.code, "PLUGIN_NOT_LOADED");
  } finally {
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a settings change pokes the pollers instead of waiting for the interval", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const before = host.state.connects.length;
    host.emit("plugin:settingsChanged", {});
    await waitFor(() => host.state.connects.length > before, { label: "the poked poll" });
    // The poll is a session of its own, so the cursor is kept and nothing is lost.
    await waitFor(
      () => {
        const cursor = readState(host)?.accounts?.acc_1?.cursor;
        return Boolean(cursor && cursor.uidValidity === 7 && cursor.maxUid === 0);
      },
      { label: "the poked poll's cursor" },
    );
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a mailbox with its own server connects by credential instance only", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [
      {
        instanceId: "acc_1",
        username: "ceo@example.com",
        fields: { server: "mail.example.com", port: "993", protocol: "imap", security: "tls" },
      },
    ],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    const account = snapshot.accounts[0];
    assert.equal(account.provider.id, "custom");
    assert.match(account.provider.title, /mail\.example\.com:993 · IMAP · SSL/);
    assert.equal(account.provider.custom.protocol, "imap");
    assert.equal(account.protocol, "imap");
    assert.equal(account.flagsSupported, true, "custom IMAP is still IMAP");
    assert.equal(account.webmail, null, "no web page is guessed for a server we do not know");
    // The endpoint is not named by the plugin: the instance carries it, and the
    // host injects that instance's password into that endpoint alone.
    assert.ok(host.state.connects.length >= 1);
    assert.equal(host.state.connects[0].credentialRef, "mailbox#acc_1");
    assert.equal(host.state.connects[0].endpoint, null);
    // After that it is the ordinary IMAP session, and it is never an IDLE one.
    assert.equal(server.sentLines[0], "A1 CAPABILITY");
    assert.equal(server.sentLines.some((line) => /IDLE|DONE/.test(line)), false, "no IDLE any more");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a preset provider still names its endpoint, and a custom account cannot be re-pointed", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [
      {
        instanceId: "acc_1",
        username: "ceo@example.com",
        fields: { server: "mail.example.com", port: "993", protocol: "imap", security: "tls" },
      },
    ],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const picked = await panel(plugin, "inbox.setProvider", { instanceId: "acc_1", providerId: "tencentExmail" });
    assert.equal(picked.ok, false);
    assert.equal(picked.code, "UNSUPPORTED", "the panel has no provider picker any more");
    assert.equal(host.state.connects.length, 1, "nothing extra was dialled");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("editing an account keeps its baseline, and a protocol change starts a new one", async () => {
  const imap = createFakeServer({
    uidNext: 4,
    messages: [message({ uid: 1 }), message({ uid: 2 }), message({ uid: 3 })],
  });
  const servers = { "mailbox#acc_1": imap };
  const host = fakeHost({
    instances: [{ instanceId: "acc_1", username: "ceo@example.com", fields: { provider: "qq" } }],
    servers,
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    assert.deepEqual(readState(host).accounts.acc_1.cursor, { uidValidity: 7, maxUid: 3 });

    // Same protocol, another server: the edit is honoured at once…
    servers["mailbox#acc_1"] = createFakeServer({ uidNext: 1 });
    host.accounts[0].fields = { server: "mail.example.com", port: "993", protocol: "imap", security: "tls" };
    host.emit("credentials:changed", { slotId: "mailbox" });
    await waitFor(() => host.state.connects.some((entry) => entry.endpoint === null), {
      label: "the custom endpoint",
    });
    // …and the baseline is kept: it is the same mailbox behind another address.
    assert.deepEqual(readState(host).accounts.acc_1.cursor, { uidValidity: 7, maxUid: 3 });

    // Now the protocol changes. A POP3 UIDL set is not an IMAP UID cursor, so the
    // account is baselined again instead of reusing numbers that mean nothing.
    servers["mailbox#acc_1"] = createFakePop3Server({ messages: [] });
    host.accounts[0].fields = { server: "pop.example.com", port: "995", protocol: "pop3", security: "tls" };
    host.emit("credentials:changed", { slotId: "mailbox" });
    await waitFor(() => readState(host).accounts.acc_1?.pop3?.baselined === true, {
      label: "the POP3 baseline",
    });
    assert.equal(readState(host).accounts.acc_1.cursor, null, "the IMAP cursor is gone");
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts[0].protocol, "pop3");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an account's proxy is published, and a proxy failure is explained once", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [
      {
        instanceId: "acc_1",
        username: "me@gmail.com",
        // The host publishes the three non-secret fields; the proxy username and
        // password never appear here, and this plugin never asks for them.
        fields: { provider: "gmail", proxyType: "http", proxyHost: "127.0.0.1", proxyPort: "7897" },
      },
    ],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.deepEqual(snapshot.accounts[0].proxy, { type: "http", host: "127.0.0.1", port: 7897 });
    // The provider is still the endpoint; the proxy only changes how it is reached,
    // and the plugin still names no host of its own.
    assert.equal(snapshot.accounts[0].provider.id, "gmail");
    assert.equal(host.state.connects[0].host, "imap.gmail.com");
    assert.equal(host.state.connects[0].endpoint.port, 993);

    // The host refuses the proxy's credentials: one row, naming the proxy.
    host.pi.net.tcp.connect = async () => {
      throw coded("PROXY_AUTH_FAILED", "the proxy rejected the credentials");
    };
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.accounts[0]?.status?.lastError?.includes("PROXY_AUTH_FAILED"), {
      label: "the proxy account error",
    });
    assert.deepEqual(host.notifications, []);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a POP3 mailbox is polled without notifications and keeps local read state", async () => {
  const server = createFakePop3Server({ messages: [popMessage({ uidl: "AAA", subject: "already here" })] });
  const host = fakeHost({
    instances: [
      {
        instanceId: "acc_1",
        username: "owner@example.com",
        fields: { server: "pop.example.com", port: "995", protocol: "pop3", security: "tls" },
      },
    ],
    servers: { "mailbox#acc_1": server },
    settings: { importantSenders: "boss@example.com" },
  });
  const plugin = await loadWith(host);
  try {
    await waitFor(
      async () => (await panel(plugin, "inbox.snapshot")).snapshot.accounts[0]?.status?.phase === "connected",
      { label: "the baseline poll" },
    );
    assert.deepEqual(host.notifications, [], "mail that was already there is not announced");
    assert.equal(host.state.connects[0].endpoint, null);

    server.deliver(
      popMessage({ uidl: "BBB", from: { name: "Boss", address: "boss@example.com" }, subject: "新邮件" }),
    );
    const checked = await panel(plugin, "inbox.check", { instanceId: "acc_1" });
    assert.equal(checked.ok, true);
    assert.equal(checked.handled, 1);
    assert.deepEqual(host.notifications, [], "POP3 mail stays in the Inbox panel too");

    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    const account = snapshot.accounts[0];
    assert.equal(account.protocol, "pop3");
    assert.equal(account.flagsSupported, false);
    assert.match(account.provider.title, /POP3/);
    const listed = snapshot.messages[0];
    assert.equal(listed.key, "pop3:BBB");
    assert.equal(listed.unread, true, "POP3 keeps read state on this machine, so it starts unread");
    assert.equal(listed.readLocally, false);
    assert.equal(listed.starred, null);

    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "pop3:BBB" });
    assert.equal(opened.ok, true);
    assert.match(opened.message.text ?? "", /Hello from the test maildrop/);
    assert.equal(opened.message.flagsSupported, false);
    assert.ok(server.sentLines.includes("RETR 2"), server.sentLines.join(" | "));
    assert.equal(server.sentLines.some((line) => /^DELE\b/.test(line)), false, "nothing is deleted");

    // Opening it marked it read locally, and the list follows.
    const afterOpen = (await panel(plugin, "inbox.snapshot")).snapshot.messages[0];
    assert.equal(afterOpen.unread, false);
    assert.equal(afterOpen.readLocally, true);
    assert.equal(readState(host).accounts.acc_1.pop3.read.includes("pop3:BBB"), true);

    // "Mark unread" is the same local record, and a star is refused because POP3
    // has no flags at all.
    const unread = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "pop3:BBB", flag: "unseen" });
    assert.equal(unread.ok, true);
    assert.equal(unread.readLocally, false);
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, true);
    const flagged = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "pop3:BBB", flag: "flagged" });
    assert.equal(flagged.ok, false);
    assert.equal(flagged.code, "POP3_NO_FLAGS");

    const webmail = await panel(plugin, "inbox.openWebmail", { instanceId: "acc_1" });
    assert.equal(webmail.ok, false);
    assert.equal(webmail.code, "NO_WEBMAIL");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

/**
 * Check until the panel's list holds what the test just delivered.
 *
 * A poll that is still in flight swallows one `inbox.check` (its own search ran
 * before the message was added), so this retries instead of assuming the first
 * call saw the new mail — which is also how a real user experiences it.
 */
async function checkUntil(plugin, count, label = "the new mail") {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await panel(plugin, "inbox.check");
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    if ((snapshot?.messages ?? []).length >= count) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * 0.4.0's data: the list's preview, the recipients, and the attachment flag.
 */
test("a new message brings its preview, its recipients and its attachment flag", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(
      message({
        uid: 1,
        from: { name: "Boss", address: "boss@example.com" },
        to: [
          { name: "Me", address: "owner@qq.com" },
          { name: "Ann", address: "ann@example.com" },
        ],
        cc: [{ name: "Cara", address: "cara@example.com" }],
        subject: "Numbers",
        bodyText: "Here are the numbers you asked for.",
        attachment: true,
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const [entry] = snapshot.messages;
    assert.equal(entry.summary, "Here are the numbers you asked for.");
    assert.deepEqual(entry.to.map((one) => one.address), ["owner@qq.com", "ann@example.com"]);
    assert.deepEqual(entry.cc.map((one) => one.address), ["cara@example.com"]);
    assert.equal(entry.hasAttachments, true, "the BODYSTRUCTURE says there is one");
    assert.equal(
      server.sentLines.some((line) => line.includes("BODY.PEEK[TEXT]<0.4096>")),
      true,
      server.sentLines.join(" | "),
    );
    assert.equal(server.bodyFetches.length, 0, "no body was downloaded");
    assert.equal(server.stores.length, 0, "watching marked nothing as read");
    const saved = readState(host);
    assert.equal(saved.accounts.acc_1.messages[0].summary, "Here are the numbers you asked for.");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

/** A mailbox that can be deleted from: an inbox, a trash and an archive. */
function deletableServer(extra = {}) {
  return createFakeServer({
    uidNext: 1,
    capabilities: ["IMAP4rev1", "ID", "MOVE", "SPECIAL-USE"],
    mailboxes: [
      { name: "INBOX", flags: [] },
      { name: "Trash", flags: ["\\Trash"] },
      { name: "Archive", flags: ["\\Archive"] },
    ],
    ...extra,
  });
}

/** One message in the list, so a delete has something to act on. */
async function seedOneMessage(plugin, server, uid = 1) {
  server.add(message({ uid, subject: "Delete me", bodyText: "Body text." }));
  await checkUntil(plugin, 1, "the message to delete");
}

test("delete moves the one message to the trash with a single MOVE", async () => {
  const server = deletableServer();
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    await seedOneMessage(plugin, server);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    assert.equal(snapshot.accounts[0].canDelete, true);
    assert.equal(snapshot.accounts[0].canArchive, true, "the LIST found an archive");
    const result = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: snapshot.messages[0].key });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(result.final, false, "an IMAP delete is a move, not a removal");
    assert.equal(result.folder, "Trash");
    assert.deepEqual(server.moves, [{ uid: 1, mailbox: "Trash" }], "exactly one message, to the trash");
    assert.deepEqual(server.expunges, [], "no separate expunge was needed");
    assert.deepEqual(server.copies, []);
    const after = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(after.messages.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("without MOVE, delete copies, marks deleted and expunges exactly that UID", async () => {
  const server = deletableServer({ capabilities: ["IMAP4rev1", "ID", "UIDPLUS"] });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    await seedOneMessage(plugin, server);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    const result = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: snapshot.messages[0].key });
    assert.equal(result.how, "copy-expunge");
    assert.deepEqual(server.copies, [{ uid: 1, mailbox: "Trash" }]);
    assert.deepEqual(server.expunges.map((entry) => entry.uid), [1], "one UID, never the whole mailbox");
    assert.equal(server.expunges[0].command, "UID EXPUNGE 1");
    assert.equal(
      server.sentLines.some((line) => /^A\d+ EXPUNGE$/i.test(line)),
      false,
      "a bare EXPUNGE would remove other clients' deleted messages too",
    );
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a mailbox with no trash refuses the delete and sends nothing", async () => {
  const server = createFakeServer({
    uidNext: 1,
    capabilities: ["IMAP4rev1", "ID", "MOVE", "SPECIAL-USE"],
    mailboxes: [{ name: "INBOX", flags: [] }, { name: "Archive", flags: ["\\Archive"] }],
  });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    await seedOneMessage(plugin, server);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    const result = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: snapshot.messages[0].key });
    assert.equal(result.ok, false);
    assert.equal(result.code, "NO_TRASH_FOLDER");
    assert.deepEqual(server.moves, []);
    assert.deepEqual(server.expunges, []);
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages.length, 1);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a server that can neither move nor expunge one message is refused, not emptied", async () => {
  const server = deletableServer({ capabilities: ["IMAP4rev1", "ID"] });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    await seedOneMessage(plugin, server);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    const result = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: snapshot.messages[0].key });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MOVE_UNSUPPORTED");
    assert.equal(server.sentLines.some((line) => /EXPUNGE|MOVE|COPY/i.test(line)), false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("archive is offered only where a LIST found an archive, and moves there", async () => {
  const withArchive = deletableServer();
  const withoutArchive = createFakeServer({
    uidNext: 1,
    capabilities: ["IMAP4rev1", "ID", "MOVE"],
    mailboxes: [{ name: "INBOX", flags: [] }, { name: "Trash", flags: [] }],
  });
  const host = fakeHost({
    instances: [oneAccount(), { instanceId: "acc_2", username: "someone@163.com" }],
    servers: { "mailbox#acc_1": withArchive, "mailbox#acc_2": withoutArchive },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host, ["acc_1", "acc_2"]);
    withArchive.add(message({ uid: 1, subject: "Archive me" }));
    withoutArchive.add(message({ uid: 1, subject: "No archive here" }));
    const snapshot = await checkUntil(plugin, 2, "one message per mailbox");
    const first = snapshot.accounts.find((account) => account.instanceId === "acc_1");
    const second = snapshot.accounts.find((account) => account.instanceId === "acc_2");
    assert.equal(first.canArchive, true);
    assert.equal(second.canArchive, false, "no archive folder means no archive button");
    const target = snapshot.messages.find((entry) => entry.accountId === "acc_1");
    const result = await panel(plugin, "inbox.archive", { accountId: "acc_1", key: target.key });
    assert.equal(result.ok, true);
    assert.deepEqual(withArchive.moves, [{ uid: 1, mailbox: "Archive" }]);
    const refused = await panel(plugin, "inbox.archive", {
      accountId: "acc_2",
      key: snapshot.messages.find((entry) => entry.accountId === "acc_2").key,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "NO_ARCHIVE_FOLDER");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("deleting on POP3 sends DELE for that one message and forgets it locally", async () => {
  const server = createFakePop3Server({ messages: [popMessage({ uidl: "AAA" })] });
  const host = fakeHost({
    instances: [
      {
        instanceId: "acc_1",
        username: "owner@example.com",
        fields: { server: "pop.example.com", port: "995", protocol: "pop3", security: "tls" },
      },
    ],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(popMessage({ uidl: "BBB", subject: "Delete me on the server" }));
    const snapshot = await checkUntil(plugin, 1, "the new POP3 message");
    assert.equal(snapshot.accounts[0].canDelete, true);
    assert.equal(snapshot.accounts[0].canArchive, false, "POP3 has no folders to archive into");
    const [entry] = snapshot.messages;
    const result = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: entry.key });
    assert.equal(result.ok, true);
    assert.equal(result.final, true, "POP3 cannot undo a delete, and the panel says so");
    assert.deepEqual(server.deleteRequests, [2], "the second message in the maildrop");
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages.length, 0);
    const saved = readState(host);
    assert.equal(saved.accounts.acc_1.pop3.uidls.includes("BBB"), false, "the UIDL is forgotten with it");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("load older walks back through the mailbox and announces nothing", async () => {
  // `uidNext` is what the first poll baselines on: starting at 4 means the three
  // messages already in the mailbox are behind the cursor, which is exactly the
  // case "load older" exists for.
  const server = createFakeServer({ uidNext: 4 });
  server.add(message({ uid: 1, subject: "Older one" }));
  server.add(message({ uid: 2, subject: "Older two" }));
  server.add(message({ uid: 3, subject: "Older three" }));
  const host = fakeHost({
    instances: [oneAccount()],
    servers: { "mailbox#acc_1": server },
    settings: { importantSenders: "boss@example.com" },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    // The baseline is "watch from here": the three messages already there are
    // behind the cursor and are not in the list.
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages.length, 0);
    server.add(message({ uid: 4, subject: "Newest", bodyText: "The newest one." }));
    const before = await checkUntil(plugin, 1, "the newest message");
    const notified = host.notifications.length;
    const result = await panel(plugin, "inbox.loadOlder", { accountId: "acc_1" });
    assert.equal(result.ok, true);
    assert.equal(result.added, 3, "the three messages below the oldest UID the panel had");
    const after = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.deepEqual(
      after.messages.map((entry) => entry.subject),
      ["Newest", "Older three", "Older two", "Older one"],
    );
    assert.equal(host.notifications.length, notified, "browsing older mail is not news");
    assert.equal(readState(host).accounts.acc_1.cursor.maxUid, 4, "the cursor did not move");
    const again = await panel(plugin, "inbox.loadOlder", { accountId: "acc_1" });
    assert.equal(again.added, 0);
    assert.equal(again.atEnd, true);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

/**
 * A UID names a message only inside one `UIDVALIDITY`.
 *
 * When a server renumbers a mailbox, every UID it handed out before means a
 * different message. Anything the user clicks in that window must be refused, and
 * the envelopes from the old era must leave the list.
 */
test("a UIDVALIDITY change drops the old envelopes and refuses to delete one", async () => {
  const server = deletableServer();
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(message({ uid: 1, subject: "First" }));
    server.add(message({ uid: 2, subject: "Second" }));
    const before = await checkUntil(plugin, 2);
    assert.equal(before.messages.length, 2);

    // The server renumbers the mailbox. Nothing has polled yet, so the panel still
    // shows the old envelopes — and a click lands exactly here.
    server.uidValidity = 99;
    const stale = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: before.messages[0].key });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "MESSAGE_STALE");
    assert.deepEqual(server.moves, [], "nothing was moved");
    assert.deepEqual(server.copies, []);
    assert.deepEqual(server.expunges, []);

    // The session that refused also saw the new validity, so the old envelopes
    // are gone instead of pointing at whatever holds those numbers now.
    const after = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(after.messages.length, 0);
    assert.equal(readState(host).accounts.acc_1.messages.length, 0);
    assert.equal(readState(host).accounts.acc_1.cursor.uidValidity, 99);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a stale envelope cannot be marked, starred or opened either", async () => {
  const server = deletableServer();
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(message({ uid: 1, subject: "Marked later" }));
    const first = await checkUntil(plugin, 1);
    const target = first.messages[0];

    server.uidValidity = 42;
    const flagged = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: target.key, flag: "flagged" });
    assert.equal(flagged.ok, false);
    assert.equal(flagged.code, "MESSAGE_STALE");
    assert.equal(server.stores.length, 0, "no STORE was sent for a UID from another era");

    // A fresh message in the new era is listed and opens normally...
    server.add(message({ uid: 2, subject: "In the new era" }));
    const second = await checkUntil(plugin, 1, "the new-era message");
    const fresh = second.messages[0];
    assert.equal(fresh.subject, "In the new era");
    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: fresh.key });
    assert.equal(opened.ok, true);

    // ...and when the mailbox is renumbered again, opening the old one is refused
    // before any body is fetched.
    server.uidValidity = 77;
    const fetchedBefore = server.bodyFetches.length;
    const stale = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: fresh.key });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "MESSAGE_STALE");
    assert.equal(server.bodyFetches.length, fetchedBefore, "no body was downloaded for a stale UID");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a trash folder spelled in modified UTF-7 is where delete moves the message", async () => {
  const server = createFakeServer({
    uidNext: 1,
    capabilities: ["IMAP4rev1", "ID", "MOVE"],
    mailboxes: [
      { name: "INBOX", flags: [] },
      { name: "&XfJSIJZk-", flags: [] },
      { name: "&V4NXPpCuTvY-", flags: [] },
    ],
  });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    await seedOneMessage(plugin, server);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    const result = await panel(plugin, "inbox.delete", { accountId: "acc_1", key: snapshot.messages[0].key });
    assert.equal(result.ok, true);
    assert.deepEqual(
      server.moves,
      [{ uid: 1, mailbox: "&XfJSIJZk-" }],
      "the command sends the server's own spelling, not the decoded label",
    );
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});


/**
 * A server whose `LIST` reports a Sent mailbox, which is what filing a copy of a
 * sent message needs.
 */
function serverWithSent(options = {}) {
  return createFakeServer({
    uidNext: 1,
    mailboxes: [
      { name: "INBOX", flags: ["\\HasNoChildren"], delimiter: "/" },
      { name: "Sent", flags: ["\\Sent", "\\HasNoChildren"], delimiter: "/" },
    ],
    ...options,
  });
}

test("a preset account sends through its own submission endpoint, and files a copy", async () => {
  const server = serverWithSent();
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const result = await panel(plugin, "inbox.send", {
      accountId: "acc_1",
      to: ["ann@example.com"],
      bcc: ["blind@example.com"],
      subject: "第三季度的数字",
      text: "你好",
    });
    assert.equal(result.ok, true);
    assert.equal(host.state.sends.length, 1);
    const request = host.state.sends[0];
    // A preset account names the endpoint its provider publishes, and names its
    // own instance, never the bare slot.
    assert.deepEqual(request.credential, { slot: "mailbox", instanceId: "acc_1" });
    assert.deepEqual(request.endpoint, { host: "smtp.qq.com", port: 465 });
    assert.equal(request.envelope.from, "owner@qq.com");
    assert.deepEqual(request.envelope.to, ["ann@example.com"]);
    assert.deepEqual(request.envelope.bcc, ["blind@example.com"]);
    const mime = Buffer.from(request.mime);
    assert.match(mime.toString("latin1"), /^From: .*owner@qq\.com/m);
    assert.equal(/^Bcc:/im.test(mime.toString("latin1")), false);
    assert.ok([...mime].every((byte) => byte < 128), "the message is 7-bit");
    // The sender is the account's own address, and the display name is absent
    // because this account's label *is* its address.
    assert.match(mime.toString("latin1"), /^From: owner@qq\.com$/m);
    // The copy is filed in Sent, with the Seen flag, and it is the same bytes.
    assert.equal(server.appends.length, 1);
    assert.equal(server.appends[0].mailbox, "Sent");
    assert.deepEqual(server.appends[0].flags, ["\\Seen"]);
    assert.equal(server.appends[0].message.equals(mime), true);
    assert.deepEqual(result.filed, { filed: true, folder: "Sent", skipped: null });
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an account with its own incoming server cannot send until it stores an outgoing one", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [
      oneAccount("owner@example.com", {
        fields: { server: "mail.example.com", port: "993", protocol: "imap", security: "tls" },
      }),
    ],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    assert.equal(snapshot.accounts[0].canSend, false);
    assert.equal(snapshot.accounts[0].sendBlockedReason, "send-no-server");
    const result = await panel(plugin, "inbox.send", {
      accountId: "acc_1",
      to: ["ann@example.com"],
      subject: "Hi",
      text: "Body",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "send-no-server");
    // Nothing was delivered: the refusal happens before the host is asked.
    assert.equal(host.state.sends.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an account with its own outgoing server sends without naming an endpoint", async () => {
  const server = serverWithSent();
  const host = fakeHost({
    instances: [
      oneAccount("owner@example.com", {
        fields: {
          server: "mail.example.com",
          port: "993",
          protocol: "imap",
          security: "tls",
          sendServer: "smtp.example.com",
          sendPort: "465",
          sendSecurity: "tls",
        },
      }),
    ],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const { snapshot } = await panel(plugin, "inbox.snapshot");
    assert.equal(snapshot.accounts[0].canSend, true);
    assert.equal(snapshot.accounts[0].sendBlockedReason, null);
    const result = await panel(plugin, "inbox.send", {
      accountId: "acc_1",
      to: ["ann@example.com"],
      subject: "Hi",
      text: "Body",
    });
    assert.equal(result.ok, true);
    // The account already decided where it sends from; naming one is refused by
    // the host, so this must be absent rather than equal to the stored server.
    assert.equal("endpoint" in host.state.sends[0], false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("Gmail files its own copy, so a send appends nothing there", async () => {
  const server = serverWithSent();
  const host = fakeHost({ instances: [oneAccount("owner@gmail.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    const result = await panel(plugin, "inbox.send", {
      accountId: "acc_1",
      to: ["ann@example.com"],
      subject: "Hi",
      text: "Body",
    });
    assert.equal(result.ok, true);
    assert.equal(server.appends.length, 0);
    assert.deepEqual(result.filed, { filed: false, folder: null, skipped: "gmail" });
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a refusal from the host reaches the panel as its code, with nothing appended", async () => {
  const server = serverWithSent();
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    host.state.sendError = coded("MAIL_RATE_LIMITED", "as many messages as the host allows per hour");
    const result = await panel(plugin, "inbox.send", {
      accountId: "acc_1",
      to: ["ann@example.com"],
      subject: "Hi",
      text: "Body",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MAIL_RATE_LIMITED");
    // A refused send files nothing: there is no message to file.
    assert.equal(server.appends.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });

  }
});

test("a reply is drafted from the message the panel opened, with no second fetch", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(
      message({
        uid: 1,
        subject: "Quarterly numbers",
        messageId: "<orig@example.com>",
        from: { name: "Boss", address: "boss@example.com" },
        to: [{ name: "Me", address: "owner@qq.com" }],
        extraHeaders: ["Reply-To: Assistant <assistant@example.com>", "References: <root@example.com>"],
        bodyText: "The numbers are attached.",
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    // Before the message is opened there is nothing to reply to: the draft is
    // built from the body the panel already fetched, never from a new request.
    const tooEarly = await panel(plugin, "inbox.draft", { accountId: "acc_1", key: target.key, mode: "reply" });
    assert.equal(tooEarly.ok, false);
    assert.equal(tooEarly.code, "MESSAGE_NOT_OPEN");
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    const connectsBefore = host.state.connects.length;
    const result = await panel(plugin, "inbox.draft", { accountId: "acc_1", key: target.key, mode: "reply" });
    assert.equal(result.ok, true);
    const draft = result.draft;
    assert.deepEqual(draft.to, [{ name: "Assistant", address: "assistant@example.com" }]);
    assert.deepEqual(draft.cc, []);
    assert.equal(draft.subject, "Re: Quarterly numbers");
    assert.equal(draft.inReplyTo, "<orig@example.com>");
    assert.deepEqual(draft.references, ["<root@example.com>", "<orig@example.com>"]);
    assert.match(draft.text, /wrote:/);
    assert.match(draft.text, /> The numbers are attached\./);
    assert.equal(host.state.connects.length, connectsBefore, "a draft opens no connection of its own");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("reply-all keeps the other recipients and never answers the account itself", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(
      message({
        uid: 1,
        subject: "Planning",
        messageId: "<plan@example.com>",
        from: { name: "Ann", address: "ann@example.com" },
        to: [
          { name: "Me", address: "owner@qq.com" },
          { name: "Bob", address: "bob@example.com" },
        ],
        cc: [{ name: "Cara", address: "cara@example.com" }],
        bodyText: "Plan?",
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    const result = await panel(plugin, "inbox.draft", { accountId: "acc_1", key: target.key, mode: "replyAll" });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.draft.to.map((entry) => entry.address),
      ["ann@example.com", "bob@example.com"],
    );
    assert.deepEqual(result.draft.cc.map((entry) => entry.address), ["cara@example.com"]);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a forward lists the original's attachments and carries its headers in the body", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    // A raw message whose body really is multipart: the panel lists attachments
    // by parsing the bytes it fetched, so a structure-only fake would prove
    // nothing about the forward.
    const raw = [
      "From: Vendor <billing@vendor.example>",
      "Subject: Invoice",
      "Message-ID: <inv@example.com>",
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Invoice attached.",
      "--M",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF-1.4 fake attachment").toString("base64"),
      "--M--",
      "",
    ].join("\r\n");
    server.add(
      message({
        uid: 1,
        subject: "Invoice",
        messageId: "<inv@example.com>",
        from: { name: "Vendor", address: "billing@vendor.example" },
        raw,
        attachment: true,
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    const result = await panel(plugin, "inbox.draft", { accountId: "acc_1", key: target.key, mode: "forward" });
    assert.equal(result.ok, true);
    assert.equal(result.draft.subject, "Fwd: Invoice");
    assert.deepEqual(result.draft.to, [], "a forward names no recipient until the user does");
    assert.match(result.draft.text, /Forwarded message/);
    assert.match(result.draft.text, /From: Vendor <billing@vendor\.example>/);
    assert.deepEqual(
      result.draft.forwardOf.attachments.map((file) => [file.part, file.filename]),
      [["2", "report.pdf"]],
    );
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an attachment is saved from the one part the server numbers, decoded", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(
      message({ uid: 1, subject: "Invoice", raw: rawWithAttachment(), attachment: true }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    assert.equal(opened.message.attachments[0].part, "2");
    const storesBefore = server.stores.length;
    const result = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: opened.message.attachments[0].part,
      filename: "report.pdf",
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "report.pdf");
    // Only the one part was fetched, and fetching it marked nothing as read.
    assert.deepEqual(server.partFetches, [{ uid: 1, section: "2" }]);
    assert.equal(server.stores.length, storesBefore, "a download sends no STORE");
    assert.equal(host.state.saves[0].bytes.toString("utf8"), "%PDF-1.4 fake attachment");
    assert.equal(host.state.saves[0].mimeType, "application/pdf");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a cancelled save dialog writes nothing and is not an error", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(message({ uid: 1, subject: "Invoice", raw: rawWithAttachment(), attachment: true }));
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    host.state.saveBehaviour = "cancel";
    const result = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "2",
      filename: "report.pdf",
    });
    assert.equal(result.ok, true);
    assert.equal(result.cancelled, true);
    assert.equal("name" in result, false, "nothing was written, so nothing is named");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a save dialog that is already open is reported as a code", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(message({ uid: 1, subject: "Invoice", raw: rawWithAttachment(), attachment: true }));
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    host.state.saveBehaviour = "busy";
    const result = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "2",
      filename: "report.pdf",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SAVE_AS_BUSY");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an attachment above the save limit is refused before its bytes are fetched", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(
      message({
        uid: 1,
        subject: "Huge",
        raw: rawWithAttachment(),
        attachment: true,
        attachmentSize: 60 * 1024 * 1024,
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    const result = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "2",
      filename: "report.pdf",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ATTACHMENT_TOO_LARGE");
    assert.equal(server.partFetches.length, 0, "nothing was downloaded to find that out");
    assert.equal(host.state.saves.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

/** The bytes the fake server answers for each section of the repro message. */
const INLINE_PNG = "%PNG-1.0 inline image";
const INLINE_PDF = "%PDF-1.4 fake attachment";

/**
 * `BODYSTRUCTURE` for HTML with an inline `cid:` image, and a PDF beside it.
 *
 * The numbers are the whole point: `1.2` is the image inside the related body and
 * `2` is the PDF, while the panel's list is `0:image/png | 1:report.pdf`.
 */
const INLINE_IMAGE_STRUCTURE =
  '((("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 40 1 NIL NIL NIL)' +
  '("IMAGE" "PNG" NIL "<logo@example.com>" NIL "BASE64" 22 NIL ("INLINE" NIL))' +
  ' "RELATED" ("BOUNDARY" "R"))' +
  '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 4096 NIL' +
  ' ("ATTACHMENT" ("FILENAME" "report.pdf")))' +
  ' "MIXED" ("BOUNDARY" "M"))';

/** The same message as the server holds it: one raw MIME document. */
function rawWithInlineImage() {
  return [
    "From: Vendor <billing@vendor.example>",
    "Subject: Quarterly",
    "Message-ID: <quarterly@example.com>",
    'Content-Type: multipart/mixed; boundary="M"',
    "",
    "--M",
    'Content-Type: multipart/related; boundary="R"',
    "",
    "--R",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>quarterly <img src="cid:logo@example.com"></p>',
    "--R",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@example.com>",
    "Content-Disposition: inline",
    "",
    Buffer.from(INLINE_PNG).toString("base64"),
    "--R--",
    "--M",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(INLINE_PDF).toString("base64"),
    "--M--",
    "",
  ].join("\r\n");
}

test("an inline image and a PDF are saved and forwarded by part, not by list position", async () => {
  const server = serverWithSent();
  const host = fakeHost({ instances: [oneAccount("owner@qq.com")], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.add(
      message({
        uid: 1,
        subject: "Quarterly",
        messageId: "<quarterly@example.com>",
        raw: rawWithInlineImage(),
        structure: INLINE_IMAGE_STRUCTURE,
        // A different payload per section: saving the wrong part would show up in
        // the bytes the host was asked to write.
        parts: { "1.2": INLINE_PNG, "2": INLINE_PDF },
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    assert.deepEqual(
      opened.message.attachments.map((file) => [file.part, file.filename]),
      [
        ["1.2", "image/png"],
        ["2", "report.pdf"],
      ],
    );
    // Clicking the image saves the image.
    const image = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "1.2",
      filename: "image/png",
    });
    assert.equal(image.ok, true);
    assert.equal(image.part, "1.2");
    assert.equal(host.state.saves[0].bytes.toString("utf8"), INLINE_PNG);
    assert.equal(host.state.saves[0].mimeType, "image/png");
    // The pane calls an unnamed part `image/png`; a save dialog is offered a name.
    assert.equal(host.state.saves[0].name, "attachment.png");
    assert.deepEqual(server.partFetches, [{ uid: 1, section: "1.2" }]);
    // Clicking the PDF saves the PDF.
    const pdf = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "2",
      filename: "report.pdf",
    });
    assert.equal(pdf.ok, true);
    assert.equal(host.state.saves[1].bytes.toString("utf8"), INLINE_PDF);
    assert.equal(host.state.saves[1].name, "report.pdf");
    assert.deepEqual(server.partFetches.at(-1), { uid: 1, section: "2" });
    // A part number that belongs to another file is refused, not written.
    const mismatch = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "2",
      filename: "image/png",
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, "ATTACHMENT_MISMATCH");
    assert.equal(host.state.saves.length, 2, "a mismatched part writes nothing");
    // Anything that is not a section number never reaches a command.
    const invalid = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: "2;DELETE INBOX",
      filename: "report.pdf",
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "INVALID_ARGUMENT");
    // Forwarding the ticked image carries the image, and not the PDF beside it.
    const draft = await panel(plugin, "inbox.draft", { accountId: "acc_1", key: target.key, mode: "forward" });
    assert.deepEqual(
      draft.draft.forwardOf.attachments.map((file) => [file.part, file.filename]),
      [
        ["1.2", "image/png"],
        ["2", "report.pdf"],
      ],
    );
    const sent = await panel(plugin, "inbox.send", {
      accountId: "acc_1",
      to: ["ann@example.com"],
      subject: "Fwd: Quarterly",
      text: "see below",
      forwardOf: {
        accountId: draft.draft.forwardOf.accountId,
        key: draft.draft.forwardOf.key,
        attachments: [{ part: "1.2", filename: "image/png" }],
      },
    });
    assert.equal(sent.ok, true);
    const mime = Buffer.from(host.state.sends[0].mime).toString("latin1");
    assert.match(mime, /^Content-Type: image\/png/m);
    assert.ok(
      mime.replace(/\r\n/g, "").includes(Buffer.from(INLINE_PNG).toString("base64")),
      "the forwarded message carries the image's own bytes",
    );
    assert.equal(mime.includes("report.pdf"), false, "the unticked PDF is nowhere in the message");
    assert.deepEqual(server.partFetches.at(-1), { uid: 1, section: "1.2" });
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});


/**
 * One raw message whose body really is `multipart/mixed` with one attachment.
 *
 * The panel lists attachments by parsing the bytes it fetched, so a message that
 * only *declares* an attachment in `BODYSTRUCTURE` would prove nothing about the
 * reading pane or about a forward — this fake carries both halves.
 */
function rawWithAttachment(text = "Invoice attached.", payload = "%PDF-1.4 fake attachment") {
  return [
    "From: Vendor <billing@vendor.example>",
    "Subject: Invoice",
    "Message-ID: <inv@example.com>",
    'Content-Type: multipart/mixed; boundary="M"',
    "",
    "--M",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--M",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(payload).toString("base64"),
    "--M--",
    "",
  ].join("\r\n");
}

test("a POP3 attachment is taken out of the one message the server may RETR", async () => {
  const boundary = "PB";
  const pop = createFakePop3Server({ messages: [] });
  const host = fakeHost({
    instances: [
      oneAccount("owner@example.com", {
        fields: { server: "pop.example.com", port: "995", protocol: "pop3", security: "tls" },
      }),
    ],
    servers: { "mailbox#acc_1": pop },
  });
  const plugin = await loadWith(host);
  try {
    // The first POP3 poll is a baseline: mail that was already there is not
    // announced. The message therefore arrives after it, as new mail does.
    await waitForPolls(host);
    pop.deliver(
      popMessage({
        uidl: "uidl-1",
        subject: "Invoice",
        extraHeaders: ['Content-Type: multipart/mixed; boundary="PB"'],
        body: [
          `--${boundary}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Invoice attached.",
          `--${boundary}`,
          'Content-Type: application/pdf; name="report.pdf"',
          'Content-Disposition: attachment; filename="report.pdf"',
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from("%PDF pop3 attachment").toString("base64"),
          `--${boundary}--`,
          "",
        ].join("\r\n"),
      }),
    );
    const snapshot = await checkUntil(plugin, 1);
    const target = snapshot.messages[0];
    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: target.key });
    assert.equal(opened.message.attachments.length, 1);
    assert.equal(opened.message.attachments[0].filename, "report.pdf");
    const result = await panel(plugin, "inbox.saveAttachment", {
      accountId: "acc_1",
      key: target.key,
      part: opened.message.attachments[0].part,
      filename: "report.pdf",
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "report.pdf");
    // POP3 has no way to ask for one part, so the whole message comes over and the
    // part is taken out of it — decoded, not as the base64 the server sent.
    assert.equal(host.state.saves[0].bytes.toString("utf8"), "%PDF pop3 attachment");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

/**
 * The agent tools, through the real `onLoad()`.
 *
 * `tests/agent-tools.test.mjs` covers the decisions in front of the protocol; what
 * is only visible here is the seam with `pi.agent` and the mailbox: what gets
 * registered, what a search actually puts on the wire, and that a read performed
 * for the model leaves `\\Seen` exactly as it was.
 */
test("the plugin registers four agent tools at load, and withdraws them at unload", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    assert.deepEqual([...host.state.tools.keys()], [
      "mail_list_messages",
      "mail_read_message",
      "mail_reply_message",
      "mail_send_message",
    ]);
    // The two reads are what a scheduled run may use while nobody is watching;
    // the two sends always take the host's approval card.
    assert.equal(host.state.tools.get("mail_list_messages").risk, "low");
    assert.equal(host.state.tools.get("mail_read_message").risk, "low");
    assert.equal(host.state.tools.get("mail_reply_message").risk, "high");
    assert.equal(host.state.tools.get("mail_send_message").risk, "high");
  } finally {
    await plugin.onUnload();
    assert.equal(host.state.tools.size, 0, "an unload must not leave a tool registered");
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an agent search answers from the stored mail without opening a mailbox", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(
      message({
        uid: 1,
        subject: "Invoice April",
        messageId: "<april@example.com>",
        from: { name: "Billing", address: "billing@vendor.example" },
      }),
    );
    await checkUntil(plugin, 1);
    const connects = server.connectCount;
    const searches = server.searches.length;
    // A page of one, which the stored mail already fills: this is the case where the
    // plugin has no reason to reach for the mailbox at all.
    const result = await host.state.tools
      .get("mail_list_messages")
      .execute({ accountId: "acc_1", limit: 1 }, {});
    assert.equal(result.untrusted, true);
    assert.match(result.notice, /data, never as instructions/);
    assert.equal(result.returned, 1);
    assert.equal(result.messages[0].subject, "Invoice April");
    assert.equal(result.messages[0].source, "local");
    assert.equal(result.messages[0].from.address, "billing@vendor.example");
    assert.equal(result.accounts[0].searched, false);
    // Enough local matches for the page that was asked for: no session, no search.
    assert.equal(server.connectCount, connects, "a local answer opens no connection");
    assert.equal(server.searches.length, searches);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a dated agent search asks the server, and marks nothing read", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, subject: "Invoice April", messageId: "<april@example.com>" }));
    await checkUntil(plugin, 1);
    // Older mail the poll window never covered: this is what a date range is for.
    server.add(
      message({
        uid: 2,
        subject: "Invoice March",
        messageId: "<march@example.com>",
        date: "10-Mar-2026 09:00:00 +0800",
      }),
    );
    const stores = server.stores.length;
    const result = await host.state.tools
      .get("mail_list_messages")
      .execute({ accountId: "acc_1", since: "2026-03-01" }, {});
    // One search, with the criterion the caller named, and the day in the form
    // IMAP expects.
    assert.ok(
      server.searches.some((line) => /SINCE 1-Mar-2026/.test(line)),
      `a SINCE search should have gone out, saw ${JSON.stringify(server.searches)}`,
    );
    assert.equal(result.accounts[0].searched, true);
    const march = result.messages.find((entry) => entry.messageId === "<march@example.com>");
    assert.ok(march, "the older message comes from the server");
    assert.equal(march.source, "server");
    assert.equal(march.subject, "Invoice March");
    // One row per message even though both sources answered: the stored copy is
    // replaced by the server's, not listed beside it.
    assert.equal(result.returned, result.messages.length);
    assert.equal(result.messages.filter((entry) => entry.messageId === "<april@example.com>").length, 1);
    assert.equal(result.messages.find((entry) => entry.messageId === "<april@example.com>").source, "server");
    // A message the store never held is read by the key the same answer reported,
    // and its subject comes off the message's own headers. The key alone has to be
    // enough: a caller that read `key` from a row must not need to know `uid` too.
    assert.match(march.key, /^uid:\d+:\d+$/, "a server row is keyed by its own name");
    const body = await host.state.tools
      .get("mail_read_message")
      .execute({ accountId: "acc_1", key: march.key }, {});
    assert.equal(body.markedRead, false);
    assert.equal(body.subject, "Invoice March");
    assert.match(body.text, /Hello from the test mailbox/);
    assert.equal(server.stores.length, stores, "reading by that key sends no STORE either");
    // The fetch was a peek, and no flag was touched: a search is not a read.
    assert.equal(server.stores.length, stores, "a search sends no STORE");
    assert.equal(
      server.sentLines.filter((line) => /[^.]BODY\[\]/.test(line)).length,
      0,
      "a plain BODY[] would set \\Seen",
    );
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("reading a message through the agent leaves it unread, while the panel marks it", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(
      message({
        uid: 1,
        subject: "Invoice April",
        messageId: "<april@example.com>",
        raw: rawMessage({ subject: "Invoice April", text: "Total: 1200 CNY" }),
      }),
    );
    await checkUntil(plugin, 1);
    const read = await host.state.tools
      .get("mail_read_message")
      .execute({ accountId: "acc_1", key: "<april@example.com>" }, {});
    assert.equal(read.untrusted, true);
    assert.equal(read.markedRead, false);
    assert.match(read.text, /Total: 1200 CNY/);
    assert.equal(read.subject, "Invoice April");
    // The promise of a low-risk read: the mailbox is exactly as it was.
    assert.equal(server.stores.length, 0, "a tool read sends no STORE");
    const saved = readState(host);
    assert.equal(saved.accounts.acc_1.messages[0].flags.includes("\\Seen"), false);
    // And the panel, which *is* the user reading it, still marks it.
    await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "<april@example.com>" });
    assert.equal(server.stores.length, 1);
    assert.match(server.stores[0], /\\Seen/);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("an agent reply goes out threaded, quoting the original, and files a Sent copy", async () => {
  const server = createFakeServer({
    uidNext: 1,
    mailboxes: [{ name: "Sent", flags: ["\\Sent"] }],
  });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(
      message({
        uid: 1,
        subject: "Invoice April",
        messageId: "<april@example.com>",
        from: { name: "Billing", address: "billing@vendor.example" },
        raw: rawMessage({ subject: "Invoice April", text: "Total: 1200 CNY" }),
      }),
    );
    await checkUntil(plugin, 1);
    const reply = await host.state.tools
      .get("mail_reply_message")
      .execute({ accountId: "acc_1", key: "<april@example.com>", text: "Paid today, thanks." }, {});
    assert.equal(reply.sent, true);
    assert.equal(host.state.sends.length, 1);
    const request = host.state.sends[0];
    const mime = Buffer.from(request.mime).toString("utf8");
    // Threaded on the original, addressed to its sender, and quoting it.
    assert.match(mime, /In-Reply-To: <april@example\.com>/);
    assert.match(mime, /Subject: Re: Invoice April/);
    assert.match(mime, /Paid today, thanks\./);
    assert.match(mime, /Total: 1200 CNY/, "the original is quoted under the attribution line");
    assert.equal(request.envelope.from, "owner@qq.com");
    assert.deepEqual(request.envelope.to, ["billing@vendor.example"]);
    // The reply fetch was a peek too: answering a message does not read it.
    assert.equal(server.stores.length, 0);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

/**
 * A Chinese keyword, which is the case this search exists for.
 *
 * A quoted string is 7-bit, so `SUBJECT "发票"` is not a search a server has to
 * accept; the plugin sends a literal under `CHARSET UTF-8` instead, and this is the
 * wire evidence for it.
 */
test("a Chinese keyword reaches the server as a UTF-8 literal, not a quoted string", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, subject: "发票 2026-04", messageId: "<invoice@example.com>" }));
    await checkUntil(plugin, 1);
    // Older than the poll window, so only the server can answer this.
    server.add(
      message({
        uid: 2,
        subject: "发票 2026-03",
        messageId: "<invoice-march@example.com>",
        date: "10-Mar-2026 09:00:00 +0800",
      }),
    );
    const result = await host.state.tools
      .get("mail_list_messages")
      .execute({ accountId: "acc_1", subject: "发票", since: "2026-03-01" }, {});
    const wire = server.sent.join("");
    // One line up to the marker, the literal after the continuation, then the rest
    // of the command — the only shape a real server accepts.
    const literal = Buffer.from("发票", "utf8").toString("latin1");
    assert.ok(
      wire.includes(`UID SEARCH CHARSET UTF-8 SUBJECT {6}\r\n${literal} SINCE 1-Mar-2026\r\n`),
      `the wire was ${JSON.stringify(wire)}`,
    );
    assert.deepEqual(server.searchLiterals, ["发票"]);
    assert.equal(result.accounts[0].searched, true);
    const subjects = result.messages.map((entry) => entry.subject).sort();
    assert.deepEqual(subjects, ["发票 2026-03", "发票 2026-04"]);
    // The row the store never held is keyed by its server name, so it stays
    // addressable by whichever source answered.
    const march = result.messages.find((entry) => entry.subject === "发票 2026-03");
    assert.match(march.key, /^uid:\d+:2$/);
    assert.equal(march.messageId, "<invoice-march@example.com>");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a server that cannot search UTF-8 is named in the answer instead of failing silently", async () => {
  const server = createFakeServer({ uidNext: 1, refuseCharset: true });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, subject: "发票 2026-04", messageId: "<invoice@example.com>" }));
    await checkUntil(plugin, 1);
    const result = await host.state.tools
      .get("mail_list_messages")
      .execute({ accountId: "acc_1", subject: "发票", since: "2026-03-01" }, {});
    // The local answer survives, and the note says what the server refused — a
    // caller that reads "FAILED" learns nothing it can act on.
    assert.equal(result.accounts[0].searched, false);
    assert.match(result.accounts[0].note, /BADCHARSET/);
    assert.match(result.accounts[0].note, /what this computer already stored/);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].subject, "发票 2026-04");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});


test("mark all read includes uncached IMAP mail, preserves stars and persists the list", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<cached>", flags: ["\\Flagged"] }));
    await panel(plugin, "inbox.check");
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1, {
      label: "cached message",
    });
    server.deliver(message({ uid: 2, messageId: "<uncached>" }));
    const result = await panel(plugin, "inbox.markAllRead", { accountId: "acc_1" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [{ accountId: "acc_1", marked: 2 }]);
    assert.deepEqual(server.entries[0].flags, ["\\Flagged", "\\Seen"]);
    assert.deepEqual(server.entries[1].flags, ["\\Seen"]);
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, false);
    assert.ok(readState(host).accounts.acc_1.messages[0].flags.includes("\\Seen"));
    assert.deepEqual(host.notifications, []);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("mark all read reports per-account failure without changing failed local flags", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount(), { instanceId: "acc_2", username: "nobody@example.com" }],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<one>" }));
    await panel(plugin, "inbox.check", { instanceId: "acc_1" });
    const result = await panel(plugin, "inbox.markAllRead");
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      { accountId: "acc_1", marked: 1 },
      { accountId: "acc_2", marked: 0, code: "ACCOUNT_OFFLINE" },
    ]);
    const invalid = await panel(plugin, "inbox.markAllRead", { accountId: "missing" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "ACCOUNT_NOT_FOUND");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});


test("mark all read keeps POP3 read marks locally without a network mutation", async () => {
  const server = createFakePop3Server({ messages: [] });
  const host = fakeHost({
    instances: [{ instanceId: "acc_1", username: "owner@example.com",
      fields: { server: "pop.example.com", port: "995", protocol: "pop3", security: "tls" } }],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(popMessage({ uidl: "A", subject: "one" }));
    server.deliver(popMessage({ uidl: "B", subject: "two" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 2);
    const connects = host.state.connects.length;
    const result = await panel(plugin, "inbox.markAllRead", { accountId: "acc_1" });
    assert.deepEqual(result.results, [{ accountId: "acc_1", marked: 2 }]);
    assert.equal(host.state.connects.length, connects);
    assert.ok((await panel(plugin, "inbox.snapshot")).snapshot.messages.every((item) => !item.unread));
    assert.deepEqual(readState(host).accounts.acc_1.pop3.read.sort(), ["pop3:A", "pop3:B"]);
    assert.deepEqual((await panel(plugin, "inbox.markAllRead")).results, [{ accountId: "acc_1", marked: 0 }]);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("mark all read batches uncached mail and does not write for an empty inbox", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    assert.deepEqual((await panel(plugin, "inbox.markAllRead")).results, [{ accountId: "acc_1", marked: 0 }]);
    assert.equal(server.stores.length, 0);
    for (let uid = 1; uid <= 205; uid += 1) server.deliver(message({ uid, messageId: `<batch-${uid}>` }));
    const result = await panel(plugin, "inbox.markAllRead");
    assert.deepEqual(result.results, [{ accountId: "acc_1", marked: 205 }]);
    assert.deepEqual(server.stores.map((line) => line.split(" ")[2].split(",").length), [100, 100, 5]);
    assert.ok(server.entries.every((entry) => entry.flags.includes("\\Seen")));
    assert.deepEqual(host.notifications, []);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("mark all read rejects a changed UIDVALIDITY without changing server flags", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<stale-bulk>" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1);
    server.uidValidity += 1;
    const result = await panel(plugin, "inbox.markAllRead");
    assert.deepEqual(result.results, [{ accountId: "acc_1", marked: 0, code: "MESSAGE_STALE" }]);
    assert.equal(server.stores.length, 0);
    assert.deepEqual((await panel(plugin, "inbox.snapshot")).snapshot.messages, [], "stale envelopes are discarded");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});


test("a refused bulk STORE leaves server and local mail unread", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({ instances: [oneAccount()], servers: { "mailbox#acc_1": server } });
  const plugin = await loadWith(host);
  try {
    await waitForPolls(host);
    server.deliver(message({ uid: 1, messageId: "<refused-bulk>" }));
    host.emit("plugin:settingsChanged", {});
    await waitFor(async () => (await panel(plugin, "inbox.snapshot")).snapshot.messages.length === 1);
    server.failStore = true;
    const result = await panel(plugin, "inbox.markAllRead");
    assert.deepEqual(result.results, [{ accountId: "acc_1", marked: 0, code: "IMAP_NO" }]);
    assert.equal(server.entries[0].flags.includes("\\Seen"), false);
    assert.equal((await panel(plugin, "inbox.snapshot")).snapshot.messages[0].unread, true);
    assert.equal(readState(host).accounts.acc_1.messages[0].flags.includes("\\Seen"), false);
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});
