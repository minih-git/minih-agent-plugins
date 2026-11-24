import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createFakePop3Server, popMessage } from "./helpers/fake-pop3.mjs";

const require = createRequire(import.meta.url);
const { createClient } = require("../lib/pop3.js");

/**
 * The POP3 wire client on its own.
 *
 * Three things here are load-bearing and none of them can be checked by reading
 * the code: a response that arrives split across reads, a line that begins with
 * a dot (which the server doubles and the client must undouble), and the
 * terminating dot that ends a multi-line response. The rest is what the plugin
 * promises about a mailbox it does not own — no `DELE`, a capped `RETR` that is
 * still fully drained, and a `-ERR` that is a reason rather than a crash.
 */

/** A transport whose answers this test writes by hand, byte for byte. */
function scriptedTransport() {
  let listener = null;
  let closeListener = null;
  const sent = [];
  return {
    sent,
    async send(data) {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
      sent.push(text);
      // `QUIT` is answered here, so a test that only scripts one response does
      // not have to wait out the client's three-second goodbye.
      if (/^QUIT\b/i.test(text.trim()) && listener) listener(Buffer.from("+OK bye\r\n", "latin1"));
    },
    async close() {
      closeListener?.(null);
    },
    onData(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    onClose(fn) {
      closeListener = fn;
      return () => {
        closeListener = null;
      };
    },
    /** Answer the pending command, optionally one byte at a time. */
    reply(text, chunkSize = 0) {
      const bytes = Buffer.from(text, "latin1");
      const size = chunkSize > 0 ? chunkSize : bytes.length;
      for (let offset = 0; offset < bytes.length; offset += size) {
        listener(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
      }
    },
  };
}

/** Let the client's serialised command actually go out before answering it. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("capabilities are read as a name-to-arguments map, LOGIN-DELAY included", async () => {
  const server = createFakePop3Server({ loginDelay: 120 });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.get("LOGIN-DELAY"), ["120"]);
  assert.equal(capabilities.has("TOP"), true);
  await client.close();
  assert.deepEqual(server.sentLines, ["CAPA", "QUIT"]);
});

test("a refused CAPA is an empty map, not a failed session", async () => {
  const server = createFakePop3Server({ refuseCapa: true });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  assert.equal((await client.capabilities()).size, 0);
  // The session is still usable: that is the point of not throwing.
  assert.deepEqual(await client.stat(), { count: 0, size: 0 });
  await client.close();
});

test("a multi-line response split across reads is reassembled and dot-unstuffed", async () => {
  const server = createFakePop3Server({
    // One byte per delivery: the parser has to survive being interrupted
    // anywhere, including inside the terminating ".\r\n".
    chunkSize: 1,
    messages: [popMessage({ uidl: "AAA", subject: "dots", body: ".leading dot\r\n..two dots\r\nend" })],
  });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  const headers = await client.top(1, 0);
  assert.match(headers.toString(), /^From: /);
  assert.match(headers.toString(), /Subject: dots/);
  const fetched = await client.retr(1, { maxBytes: 4096 });
  const text = fetched.body.toString();
  // The server doubled every leading dot; the client undid exactly one, so what
  // is left is the message the sender wrote.
  assert.ok(text.includes(".leading dot\r\n..two dots\r\nend"), text);
  assert.equal(fetched.truncated, false);
  assert.equal(fetched.size, fetched.body.length);
  await client.close();
});

test("UIDL pairs each message number with its permanent name, skipping junk", async () => {
  const transport = scriptedTransport();
  const client = createClient(transport, { timeoutMs: 400 });
  const pending = client.uidl();
  await tick();
  transport.reply("+OK 3 messages\r\n1 AAA\r\nnotanumber BBB\r\n2 CCC\r\n3 D E\r\n.\r\n");
  assert.deepEqual(await pending, [
    { number: 1, uidl: "AAA" },
    { number: 2, uidl: "CCC" },
  ]);
  await client.close();
});

test("a refused UIDL is a coded error that names the command", async () => {
  const server = createFakePop3Server({ refuseUidl: true });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  await assert.rejects(client.uidl(), (error) => {
    assert.equal(error.code, "POP3_ERR");
    assert.match(error.message, /UIDL/);
    return true;
  });
  await client.close();
});

test("RETR keeps only the beginning, reports the real size, and drains the rest", async () => {
  const server = createFakePop3Server({
    messages: [popMessage({ uidl: "AAA", body: "x".repeat(400) })],
  });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  const fetched = await client.retr(1, { maxBytes: 120 });
  assert.equal(fetched.truncated, true);
  assert.ok(fetched.body.length <= 120 + 2, "the cap is what is kept, not what is read");
  assert.ok(fetched.size > fetched.body.length);
  // The rest was drained, so the same connection still answers: a half-read
  // multi-line response would leave the next command unmatched. The two extra
  // octets are the CRLF the server emits before the terminating dot.
  const stat = await client.stat();
  assert.equal(stat.count, 1);
  assert.ok(Math.abs(stat.size - fetched.size) <= 2, `${stat.size} vs ${fetched.size}`);
  await client.close();
});

test("a server without TOP is answered with null, not an exception", async () => {
  const server = createFakePop3Server({ refuseTop: true, messages: [popMessage({ uidl: "AAA" })] });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  assert.equal(await client.top(1, 0), null);
  await client.close();
});

test("the client cannot delete: there is no DELE, and a whole session never sends one", async () => {
  const server = createFakePop3Server({ messages: [popMessage({ uidl: "AAA" }), popMessage({ uidl: "BBB" })] });
  const client = createClient(server.accept(), { timeoutMs: 400 });
  assert.equal(typeof client.dele, "undefined");
  await client.capabilities();
  await client.stat();
  await client.uidl();
  await client.top(1, 0);
  await client.retr(2, { maxBytes: 1024 });
  await client.close();
  assert.equal(
    server.sentLines.some((line) => /^DELE\b/i.test(line)),
    false,
    "deleting the user's mail is not a thing this client can do",
  );
  assert.deepEqual(
    server.sentLines.map((line) => line.split(" ")[0]),
    ["CAPA", "STAT", "UIDL", "TOP", "RETR", "QUIT"],
  );
});

test("a server that stops answering fails the command instead of hanging", async () => {
  const transport = scriptedTransport();
  const client = createClient(transport, { timeoutMs: 20 });
  await assert.rejects(client.stat(), (error) => {
    assert.equal(error.code, "POP3_TIMEOUT");
    return true;
  });
  assert.equal(client.closed, true);
});