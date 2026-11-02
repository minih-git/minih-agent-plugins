import assert from "node:assert/strict";
import test from "node:test";

import { appendToSectionSpan, locateSection } from "../lib/sections.mjs";

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
