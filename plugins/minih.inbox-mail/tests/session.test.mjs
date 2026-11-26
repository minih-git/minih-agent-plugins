import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createFakeServer, message } from "./helpers/fake-imap.mjs";

/**
 * The IMAP client on its own: the parts of it that the watcher's happy path does
 * not reach — a server that stops answering, two teardowns at once, and a
 * `BYE` in the middle of a conversation.
 */

const require = createRequire(import.meta.url);
const { createSession, imapDate } = require("../lib/session.js");
const agentTools = require("../lib/agent-tools.js");

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

test("a Chinese keyword is a literal that ends its line, continued after the bytes", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.add(message({ uid: 1, subject: "发票 2026-04", date: "02-Apr-2026 09:00:00 +0800" }));
  server.add(message({ uid: 2, subject: "Invoice 2026-04", date: "02-Apr-2026 09:00:00 +0800" }));
  const session = connect(server, { timeoutMs: 400 });
  const uids = await session.searchBy({ subject: "发票", since: new Date(2026, 3, 1) });
  assert.deepEqual(uids, [1]);
  // The exact bytes: the marker closes its line, the literal follows the server's
  // continuation, and the rest of the command continues on the next line. A single
  // line with `SUBJECT {6} SINCE …` is `BAD` on a real server.
  const wire = server.sent.join("");
  const literal = Buffer.from("发票", "utf8").toString("latin1");
  const expected = `UID SEARCH CHARSET UTF-8 SUBJECT {6}\r\n${literal} SINCE 1-Apr-2026\r\n`;
  assert.ok(wire.includes(expected), `the wire was ${JSON.stringify(wire)}`);
  assert.deepEqual(server.searchLiterals, ["发票"]);
  await session.close();
});

test("an ASCII keyword stays a quoted string and asks for no charset", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.add(message({ uid: 1, subject: "发票 2026-04" }));
  server.add(message({ uid: 2, subject: "Invoice 2026-04" }));
  const session = connect(server, { timeoutMs: 400 });
  const uids = await session.searchBy({ subject: "Invoice" });
  assert.deepEqual(uids, [2]);
  const wire = server.sent.join("");
  assert.match(wire, /UID SEARCH SUBJECT "Invoice"/);
  assert.doesNotMatch(wire, /CHARSET/);
  await session.close();
});

test("a sender and a subject that are both non-ASCII get one literal each, on its own line", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.add(message({ uid: 1, subject: "发票", from: { name: "财务", address: "finance@example.com" } }));
  server.add(message({ uid: 2, subject: "快递", from: { name: "财务", address: "finance@example.com" } }));
  const session = connect(server, { timeoutMs: 400 });
  const uids = await session.searchBy({ from: "财务", subject: "发票" });
  assert.deepEqual(uids, [1], "both criteria narrow the same search");
  assert.deepEqual(server.searchLiterals, ["财务", "发票"]);
  const wire = server.sent.join("");
  const caiwu = Buffer.from("财务", "utf8").toString("latin1");
  const fapiao = Buffer.from("发票", "utf8").toString("latin1");
  const expected = `UID SEARCH CHARSET UTF-8 FROM {6}\r\n${caiwu} SUBJECT {6}\r\n${fapiao}\r\n`;
  assert.ok(wire.includes(expected), `the wire was ${JSON.stringify(wire)}`);
  await session.close();
});

test("a literal marker in the middle of a line is BAD, as a real server answers", async () => {
  const server = createFakeServer({ uidNext: 1 });
  server.accept();
  const replies = [];
  server.transport.onData((chunk) => replies.push(Buffer.from(chunk).toString("utf8")));
  // The shape the plugin used to send: one line, marker in the middle.
  await server.transport.send("A1 UID SEARCH SUBJECT {6} SINCE 1-Apr-2026\r\n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(replies.join(""), /^A1 BAD a literal must be the last thing on its line/);
});

test("a server that refuses the charset says BADCHARSET rather than failing generically", async () => {
  const server = createFakeServer({ uidNext: 1, refuseCharset: true });
  const session = connect(server, { timeoutMs: 400 });
  await assert.rejects(
    () => session.searchBy({ subject: "发票" }),
    (error) => error.code === "IMAP_NO" && /BADCHARSET/.test(error.message),
  );
  await session.close();
});

test("a bare date is the local calendar day, for the filter and for IMAP", () => {
  // A fixed zone, because the bug only exists in one: a UTC+8 user asking for
  // "since 2026-04-01" must get mail from 2026-04-01 00:30 local time, and the
  // server must be asked for that same day.
  const script = `
    const assert = require("node:assert/strict");
    const tools = require(${JSON.stringify(require.resolve("../lib/agent-tools.js"))});
    const { imapDate } = require(${JSON.stringify(require.resolve("../lib/session.js"))});
    const since = tools.parseDate("2026-04-01", "since");
    assert.equal(since.getHours(), 0, "local midnight");
    assert.equal(since.toISOString(), "2026-03-31T16:00:00.000Z");
    assert.equal(imapDate(since), "1-Apr-2026");
    const row = (iso) => ({ subject: "发票", from: { name: "", address: "a@b.example" }, receivedAt: Date.parse(iso) });
    const criteria = tools.criteriaOf({ since: "2026-04-01" });
    assert.equal(tools.matchesCriteria(row("2026-03-31T16:30:00Z"), criteria), true, "00:30 on the day asked for");
    assert.equal(tools.matchesCriteria(row("2026-03-31T15:30:00Z"), criteria), false, "23:30 the day before");
    assert.equal(tools.parseDate("2026-04-01", "since").getDate(), 1);
    process.stdout.write("local-day-ok");
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, TZ: "Asia/Shanghai" },
    encoding: "utf8",
  });
  assert.equal(output.trim(), "local-day-ok");
  // And the same calendar day is what the ASCII `SINCE` line says.
  assert.equal(imapDate(new Date(2026, 3, 1)), "1-Apr-2026");
  assert.equal(agentTools.parseDate("2026-04-01", "since").getHours(), 0);
});
