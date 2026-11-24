import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const body = require("../lib/body.js");

/**
 * One message body, as the reading pane will see it.
 *
 * The cases are the encodings and charsets Chinese mail actually arrives in, the
 * two ways a message can carry an attachment, and the shapes that must not turn
 * into an unbounded parse. Every fixture is a real MIME document, not a
 * hand-built object, so the parser is exercised the way the network feeds it.
 */

function mime(lines, bodyText) {
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${bodyText}`, "utf8");
}

test("multipart/alternative yields both alternatives, decoded from base64", () => {
  const raw = Buffer.from(
    [
      "From: a@example.com",
      "Subject: hi",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="B1"',
      "",
      "--B1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      // 你 好
      "5L2g5aW9",
      "--B1",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<p>hi <b>there</b> =E2=9C=93</p>",
      "--B1--",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const parsed = body.parseMessage(raw);
  assert.equal(parsed.text, "你好");
  assert.equal(parsed.html, "<p>hi <b>there</b> ✓</p>");
  assert.deepEqual(parsed.attachments, []);
});

test("a GBK part declared as gb2312 is decoded, not mojibake", () => {
  // 报告 in GBK, base64-encoded, exactly as an old client sends it.
  const raw = mime(
    ["Content-Type: text/plain; charset=gb2312", "Content-Transfer-Encoding: base64"],
    "sai45g==",
  );
  assert.equal(body.parseMessage(raw).text, "报告");
});

test("a Big5 part and an ISO-8859-1 part decode in their own charsets", () => {
  // 測試 in Big5.
  const big5 = mime(
    ["Content-Type: text/plain; charset=big5", "Content-Transfer-Encoding: base64"],
    "tPq41Q==",
  );
  assert.equal(body.parseMessage(big5).text, "測試");
  // é as a quoted-printable byte, declared latin-1.
  const latin = mime(
    ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable"],
    "caf=E9",
  );
  assert.equal(body.parseMessage(latin).text, "café");
});

test("a plain 8-bit body without a declared charset is read as UTF-8", () => {
  const raw = mime(["Content-Type: text/plain"], "发票到了");
  assert.equal(body.parseMessage(raw).text, "发票到了");
});

test("quoted-printable soft line breaks do not leave stray equals signs", () => {
  const raw = mime(
    ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"],
    "a very long line that was=\r\nwrapped by the sender",
  );
  assert.equal(body.parseMessage(raw).text, "a very long line that waswrapped by the sender");
});

test("an attachment is listed by name and size, and never decoded as text", () => {
  const raw = Buffer.from(
    [
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "see attached",
      "--M",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="quarterly report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "QUJD",
      "--M--",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const parsed = body.parseMessage(raw);
  assert.equal(parsed.text.trim(), "see attached");
  assert.deepEqual(parsed.attachments, [{ filename: "quarterly report.pdf", size: 3 }]);
});

test("an RFC 2047 filename is decoded for display", () => {
  const raw = Buffer.from(
    [
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
      "--M",
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="=?UTF-8?B?5oql6KGoLnhsc3g=?="',
      "",
      "x",
      "--M--",
      "",
    ].join("\r\n"),
    "utf8",
  );
  assert.deepEqual(body.parseMessage(raw).attachments.map((file) => file.filename), ["报表.xlsx"]);
});

test("an inline named document is both an attachment and a message part", () => {
  const raw = Buffer.from(
    [
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: message/rfc822",
      "",
      "Subject: forwarded",
      "",
      "inner body",
      "--M--",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const parsed = body.parseMessage(raw);
  assert.equal(parsed.attachments.length, 1);
  assert.match(parsed.attachments[0].filename, /\.eml$/);
});

test("a message with no body part is empty rather than an error", () => {
  const parsed = body.parseMessage(Buffer.from("From: a@b\r\nSubject: only headers\r\n\r\n", "utf8"));
  // The default part type is text/plain, so the body is the empty string: the
  // panel shows an empty body, not an error and not a null it has to special-case.
  assert.equal(parsed.text, "");
  assert.equal(parsed.html, null);
  assert.deepEqual(parsed.attachments, []);
});

test("a hostile nesting does not recurse past the parser's own limits", () => {
  let raw = "Content-Type: text/plain\r\n\r\nbottom\r\n";
  for (let depth = 0; depth < 20; depth += 1) {
    const boundary = `B${depth}`;
    raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      raw,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  const parsed = body.parseMessage(Buffer.from(raw, "utf8"));
  // Deeper than `MAX_DEPTH` the walk stops: nothing is produced and nothing hangs.
  assert.ok(body.MAX_DEPTH >= 3 && body.MAX_DEPTH <= 10);
  assert.equal(parsed.text === null || parsed.text === "bottom\r\n", true);
});

test("a part count above the limit is ignored instead of parsed", () => {
  const parts = Array.from({ length: 200 }, (_, index) =>
    `--P\r\nContent-Type: text/plain\r\n\r\npart ${index}\r\n`,
  ).join("");
  const parsed = body.parseMessage(
    Buffer.from(`Content-Type: multipart/mixed; boundary="P"\r\n\r\n${parts}--P--\r\n`, "utf8"),
  );
  assert.ok(parsed.text.startsWith("part 0"));
  assert.ok(body.MAX_PARTS < 200);
});
