import assert from "node:assert/strict";
import test from "node:test";

import {
  appendToSectionSpan,
  cutAtSentence,
  firstIsoDate,
  firstParagraphAfterH1,
  headingOutline,
  locateSection,
  sectionSizes,
} from "../lib/sections.mjs";

const cases = [
  {
    name: "a middle section with trailing blank lines",
    section: "Target",
    prefix: "# Note\n\n## Target\n\nExisting body.\n",
    separator: "\n",
    suffix: "\n\n## History\n\nKeep history.\n\n## Links\n\n[[Related]]\n",
  },
  {
    name: "a middle section without trailing blank lines",
    section: "Target",
    prefix: "# Note\n\n## Target\n\nExisting body.\n",
    separator: "\n",
    suffix: "## History\n\nKeep history.",
  },
  {
    name: "a nested section before sibling and parent-level headings",
    section: "Parent > Target",
    prefix: "# Note\n\n## Parent\n\n### Target\n\nExisting body.\n",
    separator: "\n",
    suffix: "\n### History\n\nKeep history.\n\n## Links\n\n[[Related]]\n",
  },
  {
    name: "an empty section before the next heading",
    section: "Target",
    prefix: "# Note\n\n## Target\n",
    separator: "",
    suffix: "\n## History\n\nKeep history.\n",
  },
  {
    name: "a final section with trailing blank lines",
    section: "Target",
    prefix: "# Note\n\n## Target\n\nExisting body.\n",
    separator: "\n",
    suffix: "\n\n",
  },
  {
    name: "a middle section with CRLF outside the addition",
    section: "Target",
    prefix: "# Note\r\n\r\n## Target\r\n\r\nExisting body.\r\n",
    separator: "\n",
    suffix: "\r\n## History\r\n\r\nKeep history.\r\n",
  },
];

for (const { name, section, prefix, separator, suffix } of cases) {
  for (const extra of ["New entry.", "New entry.\n"]) {
    test(`appendToSectionSpan preserves surrounding bytes for ${name} (${extra.endsWith("\n") ? "terminated" : "unterminated"} addition)`, () => {
      const content = prefix + suffix;
      const span = locateSection(content, section);
      assert.equal(span.ok, true);

      const actual = appendToSectionSpan(content, span.startLine, span.endLine, extra);

      assert.equal(actual, `${prefix}${separator}New entry.\n${suffix}`);
    });
  }
}

const OUTLINE_BODY = [
  "# Note",
  "",
  "Intro.",
  "",
  "## Position",
  "",
  "Now the note.",
  "",
  "### Detail",
  "",
  "A detail from 2026-11-09.",
  "",
  "## History",
  "",
  "Older text.",
  "",
].join("\n");

test("sectionSizes counts each heading's own section, not its children", () => {
  const outline = headingOutline(OUTLINE_BODY);
  const chars = sectionSizes(outline, OUTLINE_BODY);
  assert.equal(outline.length, 4);
  const lines = OUTLINE_BODY.split("\n");
  // H1 runs to the end of the body.
  assert.equal(chars[0], OUTLINE_BODY.length);
  // ## Position contains ### Detail, so it stops at ## History.
  assert.equal(chars[1], `${lines.slice(4, 12).join("\n")}\n`.length);
  assert.equal(chars[2], "### Detail\n\nA detail from 2026-11-09.\n\n".length);
  assert.equal(chars[3], "## History\n\nOlder text.\n".length);
});

test("firstIsoDate reads the first YYYY-MM-DD or nothing", () => {
  assert.equal(firstIsoDate("会话分层归档（2026-11-09 已发布）"), "2026-11-09");
  assert.equal(firstIsoDate("v1.4.0 released"), null);
  assert.equal(firstIsoDate(""), null);
});

test("firstParagraphAfterH1 skips callouts, comments, images, and headings", () => {
  const body = [
    "# Title",
    "",
    "> [!info] Status",
    "",
    "<!-- a note to self",
    "spanning lines -->",
    "",
    "## Section",
    "",
    "![banner](banner.png)",
    "",
    "The real abstract lives here,",
    "on two lines.",
    "",
    "Second paragraph is not part of it.",
    "",
  ].join("\n");
  assert.equal(firstParagraphAfterH1(body), "The real abstract lives here, on two lines.");
  assert.equal(firstParagraphAfterH1("# Only a title\n"), "");
  assert.equal(firstParagraphAfterH1("No heading at all.\n\nMore.\n"), "No heading at all.");
});

test("cutAtSentence prefers a sentence end and never exceeds the limit", () => {
  const paragraph = `${"甲".repeat(120)}。${"乙".repeat(200)}`;
  assert.equal(cutAtSentence(paragraph, 150), `${"甲".repeat(120)}。`);
  const hardCut = cutAtSentence("x".repeat(300), 100);
  assert.equal(hardCut.length, 100);
  assert.ok(hardCut.endsWith("…"));
  assert.equal(cutAtSentence("short.", 100), "short.");
  // A version number is not a sentence end.
  assert.ok(cutAtSentence(`v1.4.0 ${"y".repeat(200)}`, 60).endsWith("…"));
});
