import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";
import { createFakePop3Server, popMessage } from "./helpers/fake-pop3.mjs";
import { waitFor } from "./helpers/harness.mjs";

const require = createRequire(import.meta.url);
const MAIN = require.resolve("../main.js");

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
  const state = { closed: 0, connects: [] };
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

test("an alert names its account, and de-duplication is per account", async () => {
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
    await waitFor(() => host.notifications.length === 2, { label: "one alert per account" });
    const keys = host.notifications.map((row) => row.dedupeKey);
    assert.equal(new Set(keys).size, 2, "the same Message-ID in two mailboxes is two rows");
    assert.ok(keys.every((key) => key.includes("<same@example.com>")));
    const bodies = host.notifications.map((row) => row.body);
    assert.ok(bodies.some((body) => body.includes("owner@qq.com")));
    assert.ok(bodies.some((body) => body.includes("someone@163.com")));
    assert.equal(host.notifications.every((row) => row.kind === "alert"), true);
    assert.deepEqual(host.notifications[0].link, { command: "check-now" });
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

test("a company domain waits for a provider pick, and says so once", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const host = fakeHost({
    instances: [oneAccount("ceo@example.com")],
    servers: { "mailbox#acc_1": server },
  });
  const plugin = await loadWith(host);
  try {
    await waitFor(() => host.notifications.length >= 1, { label: "the provider notice" });
    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(snapshot.accounts[0].provider, null);
    assert.equal(snapshot.accounts[0].status.phase, "needs-provider");
    const notice = host.notifications.find((row) => row.dedupeKey.includes(":provider:"));
    assert.ok(notice, "a mailbox that cannot connect has to say why");
    assert.match(notice.body, /ceo@example\.com/);
    assert.equal(host.state.connects.length, 0, "nothing is dialled on a guess");

    const picked = await panel(plugin, "inbox.setProvider", { instanceId: "acc_1", providerId: "tencentExmail" });
    assert.equal(picked.ok, true);
    await waitForPolls(host);
    assert.equal(host.state.connects[0].host, "imap.exmail.qq.com");
    const after = (await panel(plugin, "inbox.snapshot")).snapshot;
    assert.equal(after.accounts[0].provider.id, "tencentExmail");
    // The choice is remembered in the plugin's own file, not in the credential.
    assert.equal(readState(host).providers.acc_1, "tencentExmail");
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
  const plugin = await loadWith(host);
  try {
    const result = await panel(plugin, "inbox.setProvider", { instanceId: "acc_1", providerId: "outlook" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PROVIDER_NEEDS_OAUTH");
    assert.equal(host.state.connects.length, 0);
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
    assert.deepEqual(readState(host).accounts.acc_1.cursor, { uidValidity: 7, maxUid: 0 });
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
    // After that it is the ordinary IMAP session — opened, used, logged out.
    assert.equal(server.sentLines[0], "A1 CAPABILITY");
    assert.equal(server.sentLines.some((line) => line.endsWith("LOGOUT")), true);
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
    assert.equal(picked.code, "CUSTOM_SERVER_ACCOUNT");
    assert.equal(host.state.connects.length, 1, "nothing was dialled for a provider the account does not use");
  } finally {
    await plugin.onUnload();
    rmSync(host.dataPath, { recursive: true, force: true });
  }
});

test("a POP3 mailbox is polled, announced once, and offers no read or star state", async () => {
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
    await waitFor(() => host.notifications.length === 1, { label: "the alert" });
    const alert = host.notifications[0];
    assert.equal(alert.kind, "alert");
    assert.match(alert.body, /Boss/);
    assert.ok(alert.dedupeKey.includes("pop3:BBB"), "the UIDL is what makes a replay impossible");

    const snapshot = (await panel(plugin, "inbox.snapshot")).snapshot;
    const account = snapshot.accounts[0];
    assert.equal(account.protocol, "pop3");
    assert.equal(account.flagsSupported, false);
    assert.match(account.provider.title, /POP3/);
    const listed = snapshot.messages[0];
    assert.equal(listed.key, "pop3:BBB");
    assert.equal(listed.unread, null, "POP3 reports no read state, so none is invented");
    assert.equal(listed.starred, null);

    const opened = await panel(plugin, "inbox.openMessage", { accountId: "acc_1", key: "pop3:BBB" });
    assert.equal(opened.ok, true);
    assert.match(opened.message.text ?? "", /Hello from the test maildrop/);
    assert.equal(opened.message.flagsSupported, false);
    assert.ok(server.sentLines.includes("RETR 2"), server.sentLines.join(" | "));
    assert.equal(server.sentLines.some((line) => /^DELE\b/.test(line)), false, "nothing is deleted");

    const flagged = await panel(plugin, "inbox.setFlag", { accountId: "acc_1", key: "pop3:BBB", flag: "seen" });
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
