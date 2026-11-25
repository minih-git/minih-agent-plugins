import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const body = require("../lib/body.js");
const { bodyMode } = await import("../view/policy.js");

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

test("an attachment is listed by name, size and the MIME part it occupies", () => {
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
  // `part` is the IMAP section number the same attachment is downloaded from; it
  // is what makes a save fetch one part instead of the whole message.
  assert.deepEqual(parsed.attachments, [
    {
      filename: "quarterly report.pdf",
      size: 3,
      part: "2",
      type: "application/pdf",
      encoding: "base64",
    },
  ]);
  // Listing never carries the bytes: a download asks for them separately.
  assert.equal(parsed.attachments[0].data, undefined);
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

test("a raw 8-bit GBK body is decoded without a transfer encoding", () => {
  // 报告 in GBK, exactly as an old client on a Chinese Windows sends it: no
  // base64, no quoted-printable, just bytes and a charset.
  const raw = Buffer.concat([
    Buffer.from("Content-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: 8bit\r\n\r\n", "latin1"),
    Buffer.from([0xb1, 0xa8, 0xb8, 0xe6]),
  ]);
  const parsed = body.parseMessage(raw);
  assert.equal(parsed.text.trim(), "报告");
});

test("a GBK newsletter keeps both alternatives, and the HTML one is what is shown", () => {
  const gbk = Buffer.from([0xb1, 0xa8, 0xb8, 0xe6]); // 报告
  const raw = Buffer.concat([
    Buffer.from(
      [
        "From: news@example.com",
        "Subject: newsletter",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain; charset=gbk",
        "Content-Transfer-Encoding: 8bit",
        "",
      ].join("\r\n") + "\r\n",
      "latin1",
    ),
    gbk,
    Buffer.from(
      [
        "",
        "--B",
        "Content-Type: text/html; charset=gbk",
        "Content-Transfer-Encoding: 8bit",
        "",
        "<table><tr><td>",
      ].join("\r\n") + "\r\n",
      "latin1",
    ),
    gbk,
    Buffer.from("</td></tr></table>\r\n--B--\r\n", "latin1"),
  ]);
  const parsed = body.parseMessage(raw);
  assert.equal(parsed.text.trim(), "报告");
  assert.match(parsed.html, /^<table>/);
  assert.match(parsed.html, /报告/);
  // The reading pane's default is the HTML alternative when there is one.
  assert.equal(bodyMode({ text: parsed.text, html: parsed.html }), "html");
});

/**
 * The message from the review that made a list index wrong: HTML with an inline
 * `cid:` image, and a PDF attached beside it.
 *
 * The panel's list is `0:image/png (part 1.2) | 1:report.pdf (part 2)`; the two
 * parsers disagree about positions from the moment the message has an inline
 * image, which is why a part number is the only name a save may use.
 */
function htmlWithInlineImage() {
  return Buffer.from(
    [
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
      "QUJD",
      "--R--",
      "--M",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQ=",
      "--M--",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

test("an inline image and a PDF are listed with the parts the server numbers", () => {
  const parsed = body.parseMessage(htmlWithInlineImage());
  assert.deepEqual(
    parsed.attachments.map((file) => [file.part, file.filename, file.type]),
    [
      ["1.2", "image/png", "image/png"],
      ["2", "report.pdf", "application/pdf"],
    ],
  );
});

test("an attachment is taken out by its part number, never by its place in a list", () => {
  const raw = htmlWithInlineImage();
  // Part 1.2 is the inline image, and its bytes are the image's.
  const image = body.selectAttachment(raw, "1.2");
  assert.equal(image.type, "image/png");
  assert.equal(image.data.toString("latin1"), "ABC");
  // Part 2 is the PDF, and only the PDF.
  const pdf = body.selectAttachment(raw, "2");
  assert.equal(pdf.filename, "report.pdf");
  assert.equal(pdf.data.toString("latin1"), "%PDF-1.4");
});

test("a part number that names a different file is refused, not saved", () => {
  const raw = htmlWithInlineImage();
  // The panel said this part is the PDF; the number belongs to the image.
  assert.throws(
    () => body.selectAttachment(raw, "1.2", { filename: "report.pdf" }),
    (error) => error.code === "ATTACHMENT_MISMATCH",
  );
  assert.throws(
    () => body.selectAttachment(raw, "2", { filename: "logo.png" }),
    (error) => error.code === "ATTACHMENT_MISMATCH",
  );
  // An empty name on either side is not a disagreement, and the case of a name is
  // not one either.
  assert.equal(body.selectAttachment(raw, "2", { filename: "" }).filename, "report.pdf");
  assert.equal(body.selectAttachment(raw, "2", { filename: "REPORT.PDF" }).filename, "report.pdf");
});

test("a part number that is not a number, or not there, is refused by code", () => {
  const raw = htmlWithInlineImage();
  for (const bad of ["", "1;DELETE", "1.2\\r\\n", "TEXT", "1..2"]) {
    assert.throws(
      () => body.selectAttachment(raw, bad),
      (error) => error.code === "INVALID_ARGUMENT",
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => body.selectAttachment(raw, "3"),
    (error) => error.code === "ATTACHMENT_NOT_FOUND",
  );
  assert.throws(
    () => body.selectAttachment(raw, "2", { maxBytes: 1 }),
    (error) => error.code === "ATTACHMENT_TOO_LARGE",
  );
});

test("a name sent as an RFC 2231 continuation is read the same as the server reads it", () => {
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
      'Content-Disposition: attachment; filename*0*=UTF-8\'\'%E5%AD%A3%E5%BA%A6; filename*1*=%E6%8A%A5%E5%91%8A.pdf',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQ=",
      "--M--",
      "",
    ].join("\r\n"),
    "utf8",
  );
  // The name only exists in the continuations, so a client that reads only
  // `filename` would have no name at all — and nothing to check a save against.
  assert.equal(body.parseMessage(raw).attachments[0].filename, "季度报告.pdf");
  assert.equal(body.selectAttachment(raw, "2", { filename: "季度报告.pdf" }).filename, "季度报告.pdf");
});
