import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const mime = require("../lib/mime.js");

/**
 * Encoded words, in the encodings a Chinese mailbox actually uses.
 *
 * The failure this prevents is visible to the user: a notification titled
 * `=?GBK?B?…?=` is worse than no notification, because it looks like a bug in
 * the app rather than a message they received.
 */

const gbk = (bytes) => Buffer.from(bytes).toString("base64");

test("a UTF-8 base64 encoded word is decoded", () => {
  assert.equal(mime.decodeEncodedWords("=?UTF-8?B?5L2g5aW9?="), "你好");
});

test("a GBK encoded word is decoded, not shown as its bytes", () => {
  // 报告 in GBK
  assert.equal(mime.decodeEncodedWords(`=?GBK?B?${gbk([0xb1, 0xa8, 0xb8, 0xe6])}?=`), "报告");
});

test("gb2312 is treated as the wider gb18030, which is what senders really mean", () => {
  assert.equal(mime.normalizeCharset("gb2312"), "gb18030");
  assert.equal(mime.normalizeCharset("GBK"), "gb18030");
  // 中文 in GBK, declared as gb2312.
  assert.equal(mime.decodeEncodedWords(`=?gb2312?B?${gbk([0xd6, 0xd0, 0xce, 0xc4])}?=`), "中文");
});

test("Q encoding decodes underscores and hex escapes", () => {
  assert.equal(mime.decodeEncodedWords("=?GBK?Q?=D6=D0=CE=C4?="), "中文");
  assert.equal(mime.decodeEncodedWords("=?UTF-8?Q?a_b?="), "a b");
});

test("two adjacent encoded words are one string, not two with a space", () => {
  assert.equal(mime.decodeEncodedWords("=?UTF-8?B?5L2g?= =?UTF-8?B?5aW9?="), "你好");
});

test("plain text and an encoded word can share one value", () => {
  assert.equal(mime.decodeEncodedWords("Re: =?UTF-8?B?5L2g5aW9?= (fwd)"), "Re: 你好 (fwd)");
});

test("headers are unfolded and lower-cased, and values are decoded", () => {
  const raw = Buffer.from(
    "From: \"Boss\" <boss@example.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nImportance:\r\n High\r\n\r\n",
    "latin1",
  );
  const headers = mime.parseHeaders(raw);
  assert.equal(mime.headerValue(headers, "importance"), "High");
  assert.equal(mime.headerValue(headers, "subject"), "你好");
  assert.equal(mime.headerValue(headers, "missing"), "");
});

test("a raw UTF-8 subject without any encoded word is still readable", () => {
  const raw = Buffer.from("Subject: 预算\r\n\r\n", "utf8");
  const headers = mime.parseHeaders(raw);
  assert.equal(mime.headerValue(headers, "subject"), "预算");
});

test("an unknown charset falls back instead of throwing", () => {
  assert.doesNotThrow(() => mime.decodeEncodedWords("=?x-nonesuch?B?5L2g5aW9?="));
});
