import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const summary = require("../lib/summary.js");
const store = require("../lib/store.js");

/**
 * The list's one-line preview.
 *
 * The interesting cases are the ones a real mailbox produces: a plain message, a
 * quoted-printable one, an HTML alternative, a multipart message whose text part
 * comes second, and a base64 part that cannot be decoded from its first bytes.
 * What must hold in every case is the bound and that nothing thrown ever reaches
 * the watcher.
 */

test("the preview bound is the envelope's own bound", () => {
  assert.equal(summary.MAX_SUMMARY, store.MAX_SUMMARY);
  assert.equal(summary.MAX_SUMMARY, 140);
});

test("a plain text message becomes one line, with its whitespace collapsed", () => {
  const text = "Hello there,\n\n  this  is\n a test message.\n";
  assert.equal(summary.summarizeFragment(Buffer.from(text, "utf8")), "Hello there, this is a test message.");
});

test("the preview stops at 140 characters", () => {
  const long = "x".repeat(400);
  const clipped = summary.summarizeFragment(Buffer.from(long, "utf8"));
  assert.equal(clipped.length, 140);
  assert.equal(summary.clip("abc", 3), "abc");
  // A surrogate pair is never cut in half.
  const pair = `${"a".repeat(139)}👍`;
  const result = summary.summarizeFragment(Buffer.from(pair, "utf8"));
  assert.equal(result.length, 139);
});

test("an HTML body is stripped to text, not shown as markup", () => {
  const html =
    "<html><head><style>p{color:red}</style></head><body><p>Hello&nbsp;<b>world</b></p><p>Second line</p></body></html>";
  const text = summary.summarizeFragment(Buffer.from(html, "utf8"), { contentType: "text/html; charset=utf-8" });
  assert.equal(text, "Hello world Second line");
  assert.doesNotMatch(text, /[<>]/);
});

test("quoted-printable is decoded, and a soft break does not become a stray equals", () => {
  const raw = Buffer.from("Caf=C3=A9 and a very long line that was =\r\nwrapped by the sender.", "latin1");
  const text = summary.summarizeFragment(raw, {
    contentType: "text/plain; charset=utf-8",
    transferEncoding: "quoted-printable",
  });
  assert.equal(text, "Café and a very long line that was wrapped by the sender.");
});

test("a multipart message is read from its text part, and an attachment is skipped", () => {
  const raw = Buffer.from(
    [
      "--B0",
      "Content-Type: application/pdf; name=report.pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=report.pdf",
      "",
      "JVBERi0xLjQK",
      "--B0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The actual message.",
      "--B0--",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const text = summary.summarizeFragment(raw, { contentType: 'multipart/mixed; boundary="B0"' });
  assert.equal(text, "The actual message.");
});

test("a base64 part yields no preview instead of random letters", () => {
  const raw = Buffer.from("SGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=", "utf8");
  assert.equal(
    summary.summarizeFragment(raw, { contentType: "text/plain; charset=utf-8", transferEncoding: "base64" }),
    "",
  );
});

test("nothing to summarize is an empty string, never an error", () => {
  assert.equal(summary.summarizeFragment(null), "");
  assert.equal(summary.summarizeFragment(Buffer.alloc(0)), "");
  // A fragment cut in the middle of a boundary is still handled.
  assert.equal(summary.summarizeFragment(Buffer.from("--B0\r\nContent-Type: text/pl", "utf8"), {
    contentType: 'multipart/alternative; boundary="B0"',
  }), "");
});

test("a GBK subject, the charset Chinese mail still arrives in, is decoded", () => {
  // "测试" in GBK, declared as gb2312 the way an older client would.
  const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
  assert.equal(summary.summarizeFragment(raw, { contentType: "text/plain; charset=gb2312" }), "测试");
});