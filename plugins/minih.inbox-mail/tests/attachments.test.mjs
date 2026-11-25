import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const attachments = require("../lib/attachments.js");

/**
 * Locating one attachment inside one message, by its section number.
 *
 * A save asks the server for `BODY.PEEK[<part>]`, so the part number has to be the
 * one the server's own `BODYSTRUCTURE` uses — never a position in the panel's
 * list, which means something else as soon as a message carries an inline image.
 * These tests pin the numbering (a plain message is part `1`, a multipart nests as
 * `1.2`, a message inside a message is saved as one `.eml`), the names both sides
 * compare, and the bounds that keep a crafted structure from becoming an unbounded
 * walk.
 */

/** A leaf body: `type`, `subtype`, parameters, id, description, encoding, octets. */
function leaf(type, subtype, { params = null, id = null, encoding = "7BIT", size = "0", lines, disposition, name } = {}) {
  const node = [type, subtype, params, id, null, encoding, size];
  if (String(type).toUpperCase() === "TEXT") node.push(lines ?? "1");
  // The extensions: md5, disposition, language, location.
  node.push(null);
  if (disposition) node.push(disposition);
  if (name) {
    node[2] = ["NAME", name];
  }
  return node;
}

const attachmentOf = (name, type = "APPLICATION", subtype = "OCTET-STREAM", size = "512") =>
  leaf(type, subtype, { encoding: "BASE64", size, disposition: ["ATTACHMENT", ["FILENAME", name]] });

test("a message that is not multipart has one part, and it is part 1", () => {
  const parts = attachments.partsOf(leaf("TEXT", "PLAIN", { size: "12" }));
  assert.deepEqual(parts, [
    { part: "1", type: "text/plain", encoding: "7bit", size: 12, name: "", attached: false },
  ]);
});

test("a multipart numbers its children in document order", () => {
  const structure = [
    leaf("TEXT", "PLAIN", { size: "10" }),
    attachmentOf("report.pdf", "APPLICATION", "PDF", "512"),
    attachmentOf("photo.png", "IMAGE", "PNG", "2048"),
    "MIXED",
    ["BOUNDARY", "B0"],
  ];
  const parts = attachments.partsOf(structure);
  assert.deepEqual(
    parts.map((entry) => [entry.part, entry.type, entry.name, entry.attached]),
    [
      ["1", "text/plain", "", false],
      ["2", "application/pdf", "report.pdf", true],
      ["3", "image/png", "photo.png", true],
    ],
  );
  // The extension data after the subtype is not a fourth part.
  assert.equal(parts.length, 3);
});

test("a nested multipart nests its numbers, and every part keeps its own", () => {
  const structure = [
    [
      leaf("TEXT", "PLAIN", { size: "5" }),
      leaf("TEXT", "HTML", { size: "9" }),
      "ALTERNATIVE",
      ["BOUNDARY", "B1"],
    ],
    attachmentOf("data.bin"),
    "MIXED",
    ["BOUNDARY", "B0"],
  ];
  assert.deepEqual(
    attachments.partsOf(structure).map((entry) => entry.part),
    ["1.1", "1.2", "2"],
  );
  const chosen = attachments.partAt(structure, "2");
  assert.equal(chosen.part, "2");
  assert.equal(chosen.name, "data.bin");
  assert.equal(chosen.encoding, "base64");
  // A number nobody has is nobody's part, and text parts are not filtered out:
  // the caller knows which parts it is willing to save.
  assert.equal(attachments.partAt(structure, "3"), null);
  assert.equal(attachments.partAt(structure, "1.1").type, "text/plain");
});

test("a part number is compared as written, so 1 is not 1.1 and 2 is not 1.2", () => {
  // The repro from review: HTML with an inline image, and a PDF beside it. The
  // panel's list is `0:image/png (1.2) | 1:report.pdf (2)`, so part 1.2 must be
  // the image and part 2 the PDF — an index would hand back the PDF for both.
  const structure = [
    [
      leaf("TEXT", "HTML", { size: "400" }),
      leaf("IMAGE", "PNG", { id: "<cid-image>", encoding: "BASE64", size: "900", disposition: ["INLINE", null] }),
      "RELATED",
      ["BOUNDARY", "B1"],
    ],
    attachmentOf("report.pdf", "APPLICATION", "PDF", "700"),
    "MIXED",
    ["BOUNDARY", "B0"],
  ];
  const image = attachments.partAt(structure, "1.2");
  assert.equal(image.type, "image/png");
  assert.equal(image.encoding, "base64");
  assert.equal(attachments.partAt(structure, "2").name, "report.pdf");
  assert.equal(attachments.partAt(structure, "1"), null);
  assert.equal(attachments.partAt(structure, "1.20"), null);
  assert.equal(attachments.partAt(structure, "2.0"), null);
});

test("an inline part with a file name counts, because that is how a photo is attached", () => {
  const structure = [
    leaf("TEXT", "PLAIN", { size: "3" }),
    leaf("IMAGE", "JPEG", {
      encoding: "BASE64",
      size: "900",
      disposition: ["INLINE", ["FILENAME", "photo.jpg"]],
    }),
    "MIXED",
  ];
  const chosen = attachments.partAt(structure, "2");
  assert.equal(chosen.name, "photo.jpg");
  assert.equal(chosen.attached, true);
});

test("a forwarded message is an attachment of its own", () => {
  const structure = [
    leaf("TEXT", "PLAIN", { size: "3" }),
    leaf("MESSAGE", "RFC822", { encoding: "7BIT", size: "4096" }),
    "MIXED",
  ];
  const chosen = attachments.partAt(structure, "2");
  assert.equal(chosen.type, "message/rfc822");
  assert.equal(chosen.name, "attached-message.eml");
});

test("an RFC 2231 name is read back, so both sides can compare it", () => {
  // `filename*=UTF-8''…` is what a Chinese mail client sends.
  const extended = [
    leaf("TEXT", "PLAIN", { size: "3" }),
    leaf("APPLICATION", "PDF", {
      encoding: "BASE64",
      size: "700",
      disposition: ["ATTACHMENT", ["FILENAME*", "UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf"]],
    }),
    "MIXED",
  ];
  assert.equal(attachments.partAt(extended, "2").name, "季度报告.pdf");
  // The same name split into continuations, which is the only place it appears.
  const continued = [
    leaf("TEXT", "PLAIN", { size: "3" }),
    leaf("APPLICATION", "PDF", {
      encoding: "BASE64",
      size: "700",
      disposition: [
        "ATTACHMENT",
        ["FILENAME*0*", "UTF-8''%E5%AD%A3%E5%BA%A6", "FILENAME*1*", "%E6%8A%A5%E5%91%8A.pdf"],
      ],
    }),
    "MIXED",
  ];
  assert.equal(attachments.partAt(continued, "2").name, "季度报告.pdf");
  // A `name*` on the type is the other place a sender may put it.
  const typed = [
    leaf("TEXT", "PLAIN", { size: "3" }),
    leaf("APPLICATION", "PDF", {
      encoding: "BASE64",
      size: "700",
      params: ["NAME*", "UTF-8''%E6%8A%A5%E5%91%8A.pdf"],
    }),
    "MIXED",
  ];
  assert.equal(attachments.partAt(typed, "2").name, "报告.pdf");
});

test("a name only counts as a disagreement when both sides have one", () => {
  assert.equal(attachments.sameName("report.pdf", "report.pdf"), true);
  // A sender wrote it in different case; it is the same file.
  assert.equal(attachments.sameName("Report.PDF", "report.pdf"), true);
  // An inline image has no file name of its own, so the panel's `image/png`
  // description of it is not a contradiction.
  assert.equal(attachments.sameName("image/png", ""), true);
  assert.equal(attachments.sameName("", "report.pdf"), true);
  assert.equal(attachments.sameName("report.pdf", "photo.png"), false);
});

test("only a number that is a section number is allowed into a command", () => {
  for (const good of ["1", "2", "1.2", "10.3.4"]) assert.equal(attachments.isPart(good), true, good);
  for (const bad of ["", " ", "0.", ".1", "1.", "1..2", "a", "TEXT", "1 2", "1;2", "1\r\n"]) {
    assert.equal(attachments.isPart(bad), false, JSON.stringify(bad));
  }
  assert.equal(attachments.isPart(undefined), false);
  assert.equal(attachments.isPart(2), true);
  // Anything that is not a section number is not a part, even when it looks close.
  assert.equal(attachments.partAt([[leaf("TEXT", "PLAIN")], "MIXED"], "1;DELETE"), null);
  assert.equal(attachments.partAt([[leaf("TEXT", "PLAIN")], "MIXED"], ""), null);
});

test("a structure that is not a list, or is absurdly wide, yields nothing", () => {
  assert.deepEqual(attachments.partsOf(null), []);
  assert.deepEqual(attachments.partsOf("nope"), []);
  assert.deepEqual(attachments.partsOf({}), []);
  assert.equal(attachments.partAt([], "1"), null);
  const wide = [];
  for (let index = 0; index < 400; index += 1) wide.push(leaf("TEXT", "PLAIN"));
  wide.push("MIXED");
  // A crafted message cannot make this walk allocate without limit.
  assert.equal(attachments.partsOf(wide).length, 200);
});

test("a part's bytes are decoded by its declared transfer encoding", () => {
  assert.equal(attachments.decodePart(Buffer.from("QUJD"), "base64").toString("latin1"), "ABC");
  assert.equal(
    attachments.decodePart(Buffer.from("a=3Db=0D=0A", "latin1"), "quoted-printable").toString("latin1"),
    "a=b\r\n",
  );
  // `7bit` and `8bit` are the bytes themselves.
  assert.equal(attachments.decodePart(Buffer.from("plain"), "7bit").toString("latin1"), "plain");
  assert.equal(attachments.decodePart(Buffer.from("plain"), "").toString("latin1"), "plain");
});

test("the suggested file name is one safe path segment", () => {
  assert.equal(attachments.suggestedName("../../etc/passwd"), "passwd");
  assert.equal(attachments.suggestedName("C:\\Users\\me\\report.pdf"), "report.pdf");
  assert.equal(attachments.suggestedName("季度报告.pdf"), "季度报告.pdf");
  assert.equal(attachments.suggestedName("a\u0000b\u0007c.txt"), "a b c.txt");
  assert.equal(attachments.suggestedName(""), "attachment");
  assert.equal(attachments.suggestedName(".."), "attachment");
  assert.equal(attachments.suggestedName("x".repeat(300)).length, 180);
  // A part nobody named is listed by its type; a type is not a file name.
  assert.equal(attachments.suggestedName("image/png"), "attachment.png");
  assert.equal(attachments.suggestedName("application/pdf"), "attachment.pdf");
  assert.equal(attachments.suggestedName("application/vnd.ms-excel"), "vnd.ms-excel");
});