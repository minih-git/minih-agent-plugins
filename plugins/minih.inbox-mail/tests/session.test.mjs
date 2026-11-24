import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";

/**
 * The IMAP client on its own: the parts of it that the watcher's happy path does
 * not reach — a server that stops answering, two teardowns at once, and a
 * `BYE` in the middle of a conversation.
 */

const require = createRequire(import.meta.url);
const { createSession } = require("../lib/session.js");

function connect(server, options = {}) {
  return createSession(server.accept(), { timeoutMs: options.timeoutMs ?? 50, log: () => {} });
}

test("a command the server ignores rejects instead of waiting forever", async () => {
  const server = createFakeServer({ uidNext: 1, mute: ["UID SEARCH"] });
  const session = connect(server, { timeoutMs: 40 });
  await assert.rejects(() => session.searchNew({ afterUid: 0 }), (error) => error.code === "IMAP_TIMEOUT");
  assert.equal(session.closed, true, "a timed-out connection is not reused");
});

test("the session has no IDLE surface: a poll only needs commands", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const session = connect(server, { timeoutMs: 200 });
  await session.capabilities();
  // Polling replaced the connected design, so the IDLE half of the client is
  // gone rather than dormant: a mailbox that offers IDLE is still polled.
  assert.equal(typeof session.idleStart, "undefined");
  assert.equal(typeof session.idleStop, "undefined");
  assert.equal(typeof session.onExists, "undefined");
  assert.equal(session.idling, undefined);
  await session.close();
  assert.equal(server.sentLines.some((line) => /IDLE|DONE/.test(line)), false);
});

test("two closes at once perform one teardown", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const session = connect(server, { timeoutMs: 200 });
  await session.capabilities();
  await Promise.all([session.close(), session.close()]);
  assert.equal(server.sentLines.filter((line) => line.includes("LOGOUT")).length, 1);
  assert.equal(session.closed, true);
});

test("a BYE rejects whatever was waiting and closes the session", async () => {
  const server = createFakeServer({ uidNext: 1, mute: ["UID SEARCH"] });
  const session = connect(server, { timeoutMs: 500 });
  await session.capabilities();
  const pending = session.searchNew({ afterUid: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The server hangs up mid-command, which is what a proxy timeout looks like.
  server.drop("gone");
  await assert.rejects(() => pending, (error) => ["IMAP_BYE", "IMAP_CLOSED", "CONNECT_FAILED"].includes(error.code));
});

test("a fetch asks for headers only, never for the body", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.add(message({ uid: 1 }));
  const session = connect(server, { timeoutMs: 500 });
  await session.select("INBOX");
  const [item] = await session.fetch([1]);
  assert.equal(item.uid, 1);
  const fetchLine = server.sentLines.find((line) => line.includes("UID FETCH"));
  assert.match(fetchLine, /BODY\.PEEK\[HEADER\.FIELDS \(FROM SUBJECT DATE MESSAGE-ID IMPORTANCE X-PRIORITY X-MSMail-Priority\)\]/);
  await session.close();
});

test("search above the cursor never returns the mailbox's last message again", async () => {
  const server = createFakeServer({ uidNext: 3 });
  server.add(message({ uid: 1 }));
  server.add(message({ uid: 2 }));
  const session = connect(server, { timeoutMs: 500 });
  await session.select("INBOX");
  // `UID 5:*` on a mailbox whose last UID is 2 is the classic replay trap.
  assert.deepEqual(await session.searchNew({ afterUid: 4 }), []);
  assert.deepEqual(await session.searchNew({ afterUid: 1 }), [2]);
  assert.deepEqual(await session.searchNew({ afterUid: 0 }), [1, 2]);
  await session.close();
});
