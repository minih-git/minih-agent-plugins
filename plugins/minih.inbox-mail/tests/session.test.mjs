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

test("a fetch asks for headers, a capped text preview and the structure, never the body", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.add(message({ uid: 1 }));
  const session = connect(server, { timeoutMs: 500 });
  await session.select("INBOX");
  const [item] = await session.fetch([1]);
  assert.equal(item.uid, 1);
  const fetchLine = server.sentLines.find((line) => line.includes("UID FETCH"));
  // The headers, the type and encoding the preview needs, and the structure that
  // says whether there is an attachment: one command, no second round trip.
  assert.match(
    fetchLine,
    /BODY\.PEEK\[HEADER\.FIELDS \(FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING IMPORTANCE X-PRIORITY X-MSMail-Priority\)\]/,
  );
  assert.match(fetchLine, /BODYSTRUCTURE/);
  // A capped peek of the text, which is what the list's summary is built from.
  assert.match(fetchLine, /BODY\.PEEK\[TEXT\]<0\.4096>/);
  // And never the whole message: that is what opening it is for.
  assert.doesNotMatch(fetchLine, /BODY\.PEEK\[\]/);
  assert.equal(server.bodyFetches.length, 0, "no body was downloaded");
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

test("a mailbox name in modified UTF-7 is decoded, and the raw name is kept for commands", async () => {
  // 163 and 126 answer `LIST` with `&XfJSIJZk-` for 已删除.
  const server = createFakeServer({
    uidNext: 1,
    capabilities: ["IMAP4rev1", "ID"],
    mailboxes: [
      { name: "INBOX", flags: [] },
      { name: "&XfJSIJZk-", flags: [] },
      { name: "&V4NXPpCuTvY-", flags: [] },
    ],
  });
  const session = connect(server, { timeoutMs: 500 });
  await session.select("INBOX");
  const list = await session.listMailboxes();
  assert.deepEqual(
    list.map((entry) => ({ name: entry.name, label: entry.label })),
    [
      { name: "INBOX", label: "INBOX" },
      { name: "&XfJSIJZk-", label: "已删除" },
      { name: "&V4NXPpCuTvY-", label: "垃圾邮件" },
    ],
    "the label is readable, the name is what a command sends",
  );
  await session.close();
});


test("an APPEND waits for the continuation and writes the literal in bounded pieces", async () => {
  const server = createFakeServer({ uidNext: 1 });
  const session = connect(server, { timeoutMs: 400 });
  // 200 KiB is far more than one socket write should carry: the host caps a write
  // at 1 MiB, and a message may be 25 MiB, so the literal has to be split.
  const mime = Buffer.alloc(200 * 1024, 0x41);
  await session.appendMessage("Sent", mime, { timeoutMs: 400 });
  const line = server.sentLines.find((entry) => entry.startsWith("A1 APPEND"));
  assert.equal(line, `A1 APPEND "Sent" (\\Seen) {${mime.length}}`);
  // The fake reassembles what arrived between the continuation and the command's
  // own CRLF, so this equality proves every byte made it, in any number of writes.
  assert.equal(server.appends.length, 1);
  assert.equal(server.appends[0].mailbox, "Sent");
  assert.deepEqual(server.appends[0].flags, ["\\Seen"]);
  assert.equal(server.appends[0].message.equals(mime), true);
  const literals = server.sent.filter((entry) => entry.length > 0 && /^A\d+ [A-Z]/.test(entry) === false);
  assert.ok(literals.length > 1, "the literal arrived in more than one write");
  for (const piece of literals) assert.ok(piece.length <= 64 * 1024 + 2, "no write is unbounded");
  await session.close();
});

test("a structure fetch and a one-part fetch ask for exactly one message's part", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.add(message({ uid: 1, subject: "Invoice", attachment: true }));
  const session = connect(server, { timeoutMs: 400 });
  const structure = await session.fetchStructure(1);
  assert.ok(Array.isArray(structure), "the structure is the server's own nested list");
  const part = await session.fetchPart(1, "2");
  assert.equal(part.section, "2");
  assert.equal(
    Buffer.from(part.data).toString("latin1"),
    Buffer.from("%PDF-1.4 fake attachment").toString("base64"),
  );
  // Both are peeks: a section fetch without `.PEEK` would mark the message read.
  assert.equal(
    server.sentLines.some((line) => /BODY\[/.test(line) && !/BODY\.PEEK\[/.test(line)),
    false,
  );
  await session.close();
});
