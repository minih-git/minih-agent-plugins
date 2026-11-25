import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const attachments = require("../lib/attachments.js");

/**
 * Locating one attachment inside one message.
 *
 * A download asks the server for `BODY.PEEK[<part>]`, so the part number has to
 * be the one the server's own `BODYSTRUCTURE` uses. These tests pin the numbering
 * (a plain message is part `1`, a multipart nests as `1.2`, a message inside a
 * message is saved as one `.eml`) and the bounds that keep a crafted structure
 * from becoming an unbounded walk.
 */

/** A leaf body: `type`, `subtype`, parameters, id, description, encoding, octets. */
function leaf(type, subtype, { params = null, encoding = "7BIT", size = "0", lines, disposition, name } = {}) {
  const node = [type, subtype, params, null, null, encoding, size];
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

test("a nested multipart nests its numbers, and the attachments are still in order", () => {
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
  const first = attachments.attachmentAt(structure, 0);
  assert.equal(first.part, "2");
  assert.equal(first.encoding, "base64");
  assert.equal(attachments.attachmentAt(structure, 1), null);
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
  const chosen = attachments.attachmentAt(structure, 0);
  assert.equal(chosen.part, "2");
  assert.equal(chosen.name, "photo.jpg");
});

test("a forwarded message is an attachment of its own", () => {
  const structure = [
    leaf("TEXT", "PLAIN", { size: "3" }),
    leaf("MESSAGE", "RFC822", { encoding: "7BIT", size: "4096" }),
    "MIXED",
  ];
  const chosen = attachments.attachmentAt(structure, 0);
  assert.equal(chosen.part, "2");
  assert.equal(chosen.type, "message/rfc822");
  assert.equal(chosen.name, "attached-message.eml");
});

test("a structure that is not a list, or is absurdly wide, yields nothing", () => {
  assert.deepEqual(attachments.partsOf(null), []);
  assert.deepEqual(attachments.partsOf("nope"), []);
  assert.deepEqual(attachments.partsOf({}), []);
  assert.equal(attachments.attachmentAt([], 0), null);
  assert.equal(attachments.attachmentAt(leaf("TEXT", "PLAIN"), -1), null);
  assert.equal(attachments.attachmentAt(leaf("TEXT", "PLAIN"), 7), null);
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
});