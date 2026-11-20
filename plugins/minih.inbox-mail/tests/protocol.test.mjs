import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createParser, kindOf, parseTagged, parseUntagged } = require("../lib/protocol.js");

/**
 * The wire format, at the two places it is easy to get wrong: a literal that
 * arrives in pieces, and a section name that carries spaces and parentheses.
 */

const bytes = (text) => Buffer.from(text, "latin1");

test("a literal split across reads is reassembled before it is parsed", () => {
  const parser = createParser();
  const head = bytes("* 1 FETCH (UID 9 BODY[HEADER.FIELDS (SUBJECT)] {13}\r\nSubject: ok\r\n");
  assert.deepEqual(parser.push(head), [], "the literal is not complete yet");

  const tail = bytes(")\r\nA1 OK done\r\n");
  const responses = parser.push(tail);
  assert.equal(responses.length, 2);
  const fetch = parseUntagged(responses[0]);
  assert.equal(fetch.kind, "fetch");
  assert.equal(fetch.item.uid, 9);
  assert.equal(Buffer.from(fetch.item.headers).toString("latin1"), "Subject: ok\r\n");
  assert.equal(kindOf(responses[1]), "tagged");
});

test("one chunk can carry several responses", () => {
  const parser = createParser();
  const responses = parser.push(bytes("* 3 EXISTS\r\n* 2 EXPUNGE\r\n* OK [UIDNEXT 12] ok\r\n"));
  assert.equal(responses.length, 3);
  assert.deepEqual(parseUntagged(responses[0]), { kind: "exists", count: 3 });
  assert.deepEqual(parseUntagged(responses[1]), { kind: "expunge", count: 2 });
  assert.equal(parseUntagged(responses[2]).code, "UIDNEXT");
  assert.equal(parseUntagged(responses[2]).value, 12);
});

test("a section name with spaces and parentheses stays one atom", () => {
  const parser = createParser();
  const [tokens] = parser.push(
    bytes("* 1 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {3}\r\nabc)\r\n"),
  );
  const list = tokens[3];
  assert.equal(list[0], "BODY[HEADER.FIELDS (FROM SUBJECT DATE)]");
  assert.equal(Buffer.isBuffer(list[1]), true);
});

test("quoted strings keep their escapes, and an envelope keeps its order", () => {
  const parser = createParser();
  const [tokens] = parser.push(
    bytes(`* 1 FETCH (UID 4 ENVELOPE ("date" "a \\"quoted\\" subject" (("Boss" NIL "boss" "example.com")) NIL NIL NIL NIL NIL NIL "<id@x>"))\r\n`),
  );
  const list = tokens[3];
  const envelope = list[list.indexOf("ENVELOPE") + 1];
  assert.equal(envelope[1], 'a "quoted" subject');
  const fetch = parseUntagged(tokens);
  assert.equal(fetch.item.envelope.subject, 'a "quoted" subject');
  assert.deepEqual(fetch.item.envelope.from, [{ name: "Boss", address: "boss@example.com" }]);
  assert.equal(fetch.item.envelope.messageId, "<id@x>");
});

test("a tagged NO and BAD are distinguishable from OK", () => {
  assert.equal(parseTagged(["A1", "OK", "[READ-WRITE]", "done"]).status, "OK");
  assert.equal(parseTagged(["A1", "NO", "no such mailbox"]).status, "NO");
  assert.equal(parseTagged(["A1", "BAD", "syntax"]).status, "BAD");
});

test("a continuation line is recognised on its own", () => {
  const parser = createParser();
  const [tokens] = parser.push(bytes("+ idling\r\n"));
  assert.equal(kindOf(tokens), "cont");
});

test("a SEARCH reply yields its UIDs and an empty one yields none", () => {
  const parser = createParser();
  const [full] = parser.push(bytes("* SEARCH 4 5 9\r\n"));
  assert.deepEqual(parseUntagged(full).uids, [4, 5, 9]);
  const [empty] = parser.push(bytes("* SEARCH\r\n"));
  assert.deepEqual(parseUntagged(empty).uids, []);
});
