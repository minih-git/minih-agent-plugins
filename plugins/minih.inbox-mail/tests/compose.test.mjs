import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const compose = require("../lib/compose.js");

/**
 * The message composer, checked against the rules the wire format and the host's
 * own refusals impose.
 *
 * These are the assertions that matter for an outgoing message, and every one of
 * them is about something a recipient or the host would reject: a header that is
 * not 7-bit, an encoded word that splits a character, a body line longer than the
 * limit, a `Bcc:` header that leaks the addresses it was trusted with, a
 * `References:` chain that loses the thread, or a subject that grows `Re: Re:`.
 */

/** The headers of one built message, unfolded, as `name -> value`. */
function headersOf(mime) {
  const text = mime.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  const block = end >= 0 ? text.slice(0, end) : text;
  const map = new Map();
  for (const line of block.split("\r\n")) {
    if (/^[ \t]/.test(line) && map.size) {
      const [last] = [...map.keys()].slice(-1);
      map.set(last, `${map.get(last)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    map.set(name, line.slice(colon + 1).trim());
  }
  return map;
}

/**
 * The text of every RFC 2047 encoded word in one header value.
 *
 * Whitespace between two adjacent encoded words is a fold, not a word gap
 * (RFC 2047 §6.2), so it disappears before decoding — which is exactly what a
 * mail client does with a long Chinese subject.
 */
function decodeWords(value) {
  return String(value)
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (match, base64) => Buffer.from(base64, "base64").toString("utf8"));
}

function build(overrides = {}) {
  return compose.buildMessage({
    from: { name: "", address: "owner@example.com" },
    to: ["ann@example.com"],
    subject: "Subject",
    text: "Hello",
    boundary: "B0",
    messageId: "<fixed@example.com>",
    date: new Date(2026, 10, 14, 10, 0, 0),
    ...overrides,
  });
}

/** The decoded bytes of the one base64 part a built message carries. */
function base64Part(raw) {
  const marker = "Content-Transfer-Encoding: base64";
  const start = raw.indexOf(marker) + marker.length;
  const body = raw.slice(start);
  const headerEnd = body.indexOf("\r\n\r\n") + 4;
  const boundary = body.indexOf("\r\n--", headerEnd);
  return body.slice(headerEnd, boundary < 0 ? undefined : boundary);
}

test("a plain message carries the headers a mail client needs, and never a Bcc", () => {
  const out = build({
    cc: ["cara@example.com"],
    bcc: ["blind@example.com"],
    inReplyTo: "<parent@example.com>",
    references: ["<root@example.com>", "<parent@example.com>"],
  });
  const headers = headersOf(out.mime);
  assert.equal(headers.get("from"), "owner@example.com");
  assert.equal(headers.get("to"), "ann@example.com");
  assert.equal(headers.get("cc"), "cara@example.com");
  assert.equal(headers.get("subject"), "Subject");
  assert.equal(headers.get("message-id"), "<fixed@example.com>");
  assert.equal(headers.get("mime-version"), "1.0");
  assert.equal(headers.get("in-reply-to"), "<parent@example.com>");
  assert.equal(headers.get("references"), "<root@example.com> <parent@example.com>");
  assert.match(headers.get("date"), /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
  // The blind recipient travels in the envelope and nowhere else.
  assert.equal(headers.has("bcc"), false);
  assert.deepEqual(out.envelope.bcc, ["blind@example.com"]);
  assert.equal(headers.get("content-type"), "text/plain; charset=UTF-8");
  assert.equal(headers.get("content-transfer-encoding"), "quoted-printable");
});

test("a Chinese subject is encoded words that decode back, and no line is long", () => {
  const subject = "第三季度的数字和下一季度的计划，请查收：包含营收、毛利与活跃用户";
  const out = build({ subject });
  const raw = out.mime.toString("latin1");
  for (const line of raw.split("\r\n")) {
    assert.ok(line.length <= 78, `a header line is ${line.length} characters: ${line}`);
  }
  const headers = headersOf(out.mime);
  assert.equal(decodeWords(headers.get("subject")), subject);
  // No byte above 127 anywhere: the host refuses 8-bit content on a server
  // without 8BITMIME, and this message must never trip that.
  assert.ok([...out.mime].every((byte) => byte < 128), "the message is 7-bit");
});
test("folding a long ASCII subject keeps every space the sender typed", () => {
  // Two spaces and a tab are the sender's text, not decoration: a fold that
  // collapsed them would rewrite the subject the recipient reads.
  const short = "Invoice  for Q3\tattached";
  assert.equal(headersOf(build({ subject: short }).mime).get("subject"), short);
  const long = `A  subject${"\t"}with   run${" ".repeat(3)}of spaces, and enough words to need more than one line of seventy-eight characters`;
  const out = build({ subject: long });
  for (const line of out.mime.toString("latin1").split("\r\n")) {
    assert.ok(line.length <= 78, `a header line is ${line.length} characters: ${line}`);
  }
  // Unfolding restores the whitespace everywhere except at the break points,
  // where the fold itself owns one space.
  const unfolded = headersOf(out.mime).get("subject");
  assert.equal(unfolded.replace(/\s+/g, " "), long.replace(/\s+/g, " "));
  assert.match(unfolded, /A\s{2}subject/);
  assert.match(unfolded, /with\s{3}run/);
});


test("a display name with a comma is quoted, and a CJK name is encoded", () => {
  const out = build({
    from: { name: "Doe, Jane", address: "jane@example.com" },
    to: [{ name: "张三", address: "zhang@example.com" }],
  });
  const headers = headersOf(out.mime);
  assert.equal(headers.get("from"), '"Doe, Jane" <jane@example.com>');
  assert.equal(decodeWords(headers.get("to")), "张三 <zhang@example.com>");
  assert.deepEqual(out.envelope.to, ["zhang@example.com"]);
});

test("quoted-printable keeps text unbroken and lines legal", () => {
  const text = `你好，这是一段中文。\n\nA line with = sign:\t${"x".repeat(200)}`;
  const out = build({ text });
  // Everything after the first blank line is the body, including its own blank
  // lines: splitting on "\r\n\r\n" would stop at the first paragraph break.
  const raw = out.mime.toString("latin1");
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  for (const line of body.split("\r\n")) {
    assert.ok(line.length <= 76, `a body line is ${line.length} characters`);
  }
  // Every `=` is an escape (`=XX`) or a soft line break at the end of a line.
  for (const match of body.matchAll(/=/g)) {
    const next = body.slice(match.index + 1, match.index + 3);
    const softBreak = body.startsWith("\r\n", match.index + 1);
    assert.ok(softBreak || /^[0-9A-F]{2}$/.test(next), `a bare equals sign at ${match.index}`);
  }
  assert.ok([...out.mime].every((byte) => byte < 128), "the message is 7-bit");
  // And the escaped form decodes back to the text that was written.
  const decoded = Buffer.from(
    body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16))),
    "latin1",
  ).toString("utf8");
  assert.equal(decoded.replace(/\r\n$/, ""), text.replace(/\n/g, "\r\n"));
});

test("an attachment makes one multipart/mixed body with base64 in 76 columns", () => {
  const data = Buffer.alloc(200, 0x41);
  const out = build({ attachments: [{ name: "report.pdf", type: "application/pdf", data }] });
  const headers = headersOf(out.mime);
  assert.equal(headers.get("content-type"), 'multipart/mixed; boundary="B0"');
  const raw = out.mime.toString("latin1");
  assert.match(raw, /\r\n--B0\r\nContent-Type: text\/plain; charset=UTF-8\r\n/);
  assert.match(raw, /Content-Type: application\/pdf; name="report\.pdf"/);
  assert.match(raw, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.match(raw, /\r\n--B0--\r\n$/);
  const lines = base64Part(raw).split("\r\n");
  assert.ok(lines.length > 1, "the attachment is wrapped over several lines");
  for (const line of lines) assert.ok(line.length <= 76, `a base64 line is ${line.length} characters`);
  assert.equal(Buffer.from(lines.join(""), "base64").equals(data), true, "the bytes are the file's bytes");
});

test("a Chinese file name travels as RFC 2231 on its own folded line", () => {
  const name = "报告.pdf";
  const out = build({ attachments: [{ name, type: "application/pdf", data: Buffer.from("x") }] });
  const raw = out.mime.toString("latin1");
  assert.match(raw, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.pdf/);
  for (const line of raw.split("\r\n")) {
    assert.ok(line.length <= 78, `a MIME part header line is ${line.length} characters`);
  }
  const param = compose.rfc2231Parameter("filename", name);
  assert.equal(decodeURIComponent(param.slice(param.indexOf("''") + 2)), name);
});

test("a long file name is split into RFC 2231 continuations, never inside a triplet", () => {
  const name = `${"很长的文件名".repeat(12)}.pdf`;
  const param = compose.rfc2231Parameter("filename", name);
  assert.match(param, /filename\*0\*=UTF-8''/);
  assert.match(param, /filename\*1\*=/);
  const pieces = param.split(/;\r\n /).map((piece) => piece.replace(/^filename\*\d+\*=/, "").replace(/^UTF-8''/, ""));
  for (const piece of pieces) {
    // A continuation holds whole `%XX` triplets: a dangling `%` would corrupt the
    // very bytes the encoding exists to preserve.
    assert.equal(/%(?![0-9A-F]{2})/.test(piece), false, piece);
  }
  assert.equal(decodeURIComponent(pieces.join("")), name);
});

test("Re: and Fwd: are added once, whatever the original subject already says", () => {
  assert.equal(compose.replySubject("Quarterly numbers"), "Re: Quarterly numbers");
  assert.equal(compose.replySubject("Re: Quarterly numbers"), "Re: Quarterly numbers");
  assert.equal(compose.replySubject("RE: Quarterly numbers"), "RE: Quarterly numbers");
  assert.equal(compose.replySubject("Re[2]: Quarterly numbers"), "Re[2]: Quarterly numbers");
  assert.equal(compose.forwardSubject("Quarterly numbers"), "Fwd: Quarterly numbers");
  assert.equal(compose.forwardSubject("Fwd: Quarterly numbers"), "Fwd: Quarterly numbers");
  assert.equal(compose.forwardSubject("FW: Quarterly numbers"), "FW: Quarterly numbers");
});

test("the references chain keeps the whole thread, deduplicated and bounded", () => {
  const chain = compose.referencesFor({
    references: "<a@x> <b@x> <a@x> not-an-id",
    inReplyTo: "<c@x>",
  });
  assert.deepEqual(chain, ["<a@x>", "<b@x>", "<c@x>"]);
  const many = Array.from({ length: 40 }, (_, index) => `<m${index}@x>`);
  const capped = compose.referencesFor({ references: many, inReplyTo: "<last@x>" });
  assert.equal(capped.length, 20);
  assert.equal(capped[19], "<last@x>", "the message being answered is the last id");
});

test("a reply quotes the original with > and an attribution line", () => {
  const en = compose.replyBody({
    text: "First line\n\nThird line",
    from: { name: "Boss", address: "boss@example.com" },
    date: "14 Nov 2026, 10:00",
    locale: "en",
  });
  assert.equal(en, "\n\nOn 14 Nov 2026, 10:00, Boss wrote:\n> First line\n>\n> Third line\n");
  const zh = compose.replyBody({
    text: "你好",
    from: { name: "林静", address: "jing@example.com" },
    date: "2026年11月14日 10:00",
    locale: "zh-CN",
  });
  assert.equal(zh, "\n\n于 2026年11月14日 10:00，林静 写道：\n> 你好\n");
  // An HTML-only message is quoted as text, never as markup.
  const html = compose.replyBody({
    html: "<p>Hello <b>there</b></p><script>alert(1)</script>",
    from: { name: "Ann", address: "ann@example.com" },
    date: "yesterday",
    locale: "en",
  });
  assert.match(html, /> Hello there/);
  assert.doesNotMatch(html, /<b>|alert\(1\)/);
});

test("a forward carries the header summary and the plain text", () => {
  const body = compose.forwardBody({
    from: { name: "Boss", address: "boss@example.com" },
    to: [{ name: "Me", address: "me@example.com" }],
    subject: "Numbers",
    date: "14 Nov 2026",
    text: "the original",
    locale: "en",
  });
  assert.match(body, /---------- Forwarded message ----------/);
  assert.match(body, /From: Boss <boss@example\.com>/);
  assert.match(body, /To: Me/);
  assert.match(body, /the original\n$/);
  const zh = compose.forwardBody({
    from: { address: "boss@example.com" },
    subject: "数字",
    date: "2026-11-14",
    text: "原文",
    locale: "zh-CN",
  });
  assert.match(zh, /---------- 转发的邮件 ----------/);
  assert.match(zh, /发件人: boss@example\.com/);
});

test("recipients are parsed, deduplicated and bounded", () => {
  const parsed = compose.parseRecipients("ann@example.com, ANN@example.com; Bob <bob@example.com>");
  assert.deepEqual(parsed.entries, [
    { name: "", address: "ann@example.com" },
    { name: "Bob", address: "bob@example.com" },
  ]);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(compose.parseRecipients("not-an-address").invalid.length, 1);

  assert.throws(() => build({ to: [] }), { code: "NO_RECIPIENTS" });
  assert.throws(() => build({ to: ["nope"] }), { code: "INVALID_RECIPIENT" });
  const tooMany = Array.from({ length: 51 }, (_, index) => `person${index}@example.com`);
  assert.throws(() => build({ to: tooMany }), { code: "TOO_MANY_RECIPIENTS" });

  // The same address in two fields is one recipient, so 49 in To plus the same
  // address in Cc is still inside the 50-recipient cap.
  const fifty = Array.from({ length: 49 }, (_, index) => `person${index}@example.com`);
  const out = build({ to: fifty, cc: ["person0@example.com"] });
  assert.equal(out.envelope.to.length, 49);
  assert.deepEqual(out.envelope.cc, ["person0@example.com"]);
});

test("a message with no usable sender address is refused", () => {
  assert.throws(() => build({ from: { address: "not-an-address" } }), { code: "BAD_SENDER" });
  assert.throws(() => build({ from: { address: "" } }), { code: "BAD_SENDER" });
});

test("a generated Message-ID is unique and in the sender's own domain", () => {
  const first = compose.makeMessageId("owner@example.com");
  const second = compose.makeMessageId("owner@example.com");
  assert.match(first, /^<[^<>@\s]+@example\.com>$/);
  assert.notEqual(first, second);
});

test("the date header is local time with the sender's own offset", () => {
  const date = new Date(2026, 10, 14, 9, 5, 7);
  const formatted = compose.formatDate(date);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const expected = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
  assert.match(formatted, /^Sat, 14 Nov 2026 09:05:07 /);
  assert.ok(formatted.endsWith(expected));
  assert.equal(compose.isAddress("owner@example.com"), true);
  assert.equal(compose.isAddress("owner@example"), false);
});