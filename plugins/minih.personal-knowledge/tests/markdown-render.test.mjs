/**
 * `view/markdown.js` — the read-only note renderer (obsidian-independence §2).
 *
 * The parser is pure, so every row of the design table is asserted on the
 * tree it returns; no DOM library is involved (the drawer's DOM adapter is
 * exercised in the browser, not here).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdown, stripFrontmatter } from "../view/markdown.js";

/** Flatten a tree to `tag:text` pairs, so assertions stay readable. */
function outline(nodes, depth = 0, out = []) {
  for (const node of nodes ?? []) {
    if (typeof node === "string") {
      out.push(`${"  ".repeat(depth)}"${node}"`);
      continue;
    }
    if (node.tag === "text") {
      out.push(`${"  ".repeat(depth)}"${node.text}"`);
      continue;
    }
    const extra = node.attrs?.class ? `.${String(node.attrs.class).split(" ").join(".")}` : "";
    out.push(`${"  ".repeat(depth)}<${node.tag}${extra}>`);
    outline(node.children, depth + 1, out);
  }
  return out;
}

function tags(tree) {
  return tree.children.map((node) => node.tag);
}

const resolveNone = () => null;

test("frontmatter is stripped and headings shift down one level", () => {
  const source = ["---", "title: Demo", "type: topic", "---", "# Demo", "###### Deep"].join("\n");
  assert.equal(stripFrontmatter(source).trimStart().startsWith("# Demo"), true);
  const tree = parseMarkdown(source, { resolveLink: resolveNone });
  assert.deepEqual(tags(tree), ["h2", "h6"], "# → h2, ###### → h6 (capped)");
  assert.deepEqual(outline(tree.children[0].children), ['"Demo"']);
});

test("paragraphs keep inline emphasis, code, strike and http links", () => {
  const tree = parseMarkdown(
    "Text with **bold**, *italic*, `code`, ~~gone~~ and a [site](https://example.com/a).",
    { resolveLink: resolveNone },
  );
  assert.equal(tree.children.length, 1);
  const line = outline([tree.children[0]]).join("\n");
  assert.match(line, /<strong>[\s\S]*"bold"/);
  assert.match(line, /<em>[\s\S]*"italic"/);
  assert.match(line, /<code>[\s\S]*"code"/);
  assert.match(line, /<del>[\s\S]*"gone"/);
  const link = tree.children[0].children.find((node) => node.tag === "a");
  assert.equal(link.attrs.href, "https://example.com/a");
  assert.equal(link.attrs.class, "md-external");
});

test("only http(s) links become links; other schemes stay text", () => {
  for (const [url, keepsLabelOnly] of [
    ["file:///etc/passwd", true],
    ["obsidian://open?vault=Knowledge", true],
    ["./relative.md", true],
    // `javascript:` carries parentheses, so the inline pattern never matches
    // it: the whole source stays literal, which is the safest reading.
    ["javascript:alert(1)", false],
  ]) {
    const tree = parseMarkdown(`See [label](${url}) here`, { resolveLink: resolveNone });
    const plain = JSON.stringify(tree);
    assert.equal(tree.children[0].children.some((node) => node.tag === "a"), false, `${url} must not be a link`);
    if (keepsLabelOnly) {
      assert.match(plain, /"label"/, `${url} keeps its label as text`);
    } else {
      assert.match(plain, /See \[label\]\(javascript:alert\(1\)\) here/, `${url} stays literal`);
    }
  }
});

test("raw HTML stays text, never markup", () => {
  const tree = parseMarkdown('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>', {
    resolveLink: resolveNone,
  });
  const texts = tree.children.flatMap((node) => outline([node]));
  assert.ok(texts.some((line) => line.includes('<script>alert(')), "the tag is text");
  assert.equal(tree.children.some((node) => node.tag === "script" || node.tag === "img"), false);
});

test("fenced code blocks keep their body verbatim and get no inline parsing", () => {
  const tree = parseMarkdown("```js\nconst a = **1**;\n```", { resolveLink: resolveNone });
  const [pre] = tree.children;
  assert.equal(pre.tag, "pre");
  assert.equal(pre.children[0].tag, "code");
  assert.equal(pre.children[0].children[0].text, "const a = **1**;");
});

test("nested lists and task checkboxes", () => {
  const tree = parseMarkdown("- one\n- [ ] todo\n- [x] done\n  - nested\n\n1. first\n2. second", {
    resolveLink: resolveNone,
  });
  const [ul, ol] = tree.children;
  assert.equal(ul.tag, "ul");
  assert.equal(ol.tag, "ol");
  const tasks = ul.children.filter((item) => item.attrs?.class === "md-task-item");
  assert.equal(tasks.length, 2);
  const boxes = tasks.map((item) => item.children[0]);
  assert.equal(boxes[0].attrs.type, "checkbox");
  assert.equal(boxes[0].attrs.disabled, true);
  assert.equal(boxes[0].attrs.checked, undefined, "an unchecked task is not checked");
  assert.equal(boxes[1].attrs.checked, true);
  const nested = tasks[1].children.find((child) => child.tag === "ul");
  assert.ok(nested, "a deeper item becomes a nested list");
  assert.equal(ol.children.length, 2);
});

test("a plain quote is a blockquote; a callout gets its type class and title", () => {
  const tree = parseMarkdown("> plain quote\n\n> [!warning] Careful\n> body text", { resolveLink: resolveNone });
  assert.equal(tree.children[0].tag, "blockquote");
  const callout = tree.children[1];
  assert.equal(callout.tag, "div");
  assert.equal(callout.attrs.class, "md-callout callout-warning");
  assert.equal(callout.attrs["data-callout"], "warning");
  assert.equal(callout.children[0].attrs.class, "md-callout-title");
  assert.deepEqual(outline([callout.children[0].children[0]]), ['"Careful"']);
});

test("an unknown callout type falls back to note", () => {
  const tree = parseMarkdown("> [!strange] Title\n> body", { resolveLink: resolveNone });
  assert.equal(tree.children[0].attrs["data-callout"], "note");
});

test("pipe tables render a header and body cells", () => {
  const tree = parseMarkdown("| Name | Value |\n| --- | --- |\n| a | 1 |", { resolveLink: resolveNone });
  const [table] = tree.children;
  assert.equal(table.tag, "table");
  const [thead, tbody] = table.children;
  assert.equal(thead.children[0].children.length, 2);
  assert.equal(tbody.children[0].children[0].children[0].text, "a");
});

test("wikilinks resolve through the injected resolver, with alias and heading", () => {
  const resolves = new Map([
    ["Alpha", "01 Projects/Alpha.md"],
    ["Beta", null],
  ]);
  const tree = parseMarkdown("See [[Alpha]], [[Beta|Bee]], [[Alpha#Intro]] and [[Ghost]]", {
    resolveLink: (target) => resolves.get(target) ?? null,
  });
  const links = tree.children[0].children.filter((node) => node.tag === "a" || node.attrs?.class === "md-wikilink is-missing");
  assert.deepEqual(
    links.map((node) => node.attrs["data-target"]),
    ["Alpha", "Beta", "Alpha", "Ghost"],
  );
  assert.equal(links[0].tag, "a", "a resolved target is a link");
  assert.equal(links[0].attrs.class, "md-wikilink");
  assert.equal(links[1].tag, "span", "an unresolved target is text");
  assert.equal(links[1].attrs.class, "md-wikilink is-missing");
  assert.deepEqual(links[1].children.map((child) => child.text), ["Bee"], "the alias is the label");
  assert.deepEqual(links[2].children.map((child) => child.text), ["Alpha › Intro"], "a heading link shows it");
  assert.equal(links.length, 4, "every wikilink is rendered once");
});

test("embeds become a muted chip instead of being resolved", () => {
  const tree = parseMarkdown("Chart ![[08 Standards/知识库仪表盘.base#view]] and ![[image.png]]", {
    resolveLink: () => "should-not-be-used",
  });
  const chips = tree.children[0].children.filter((node) => node.attrs?.class === "md-embed");
  assert.equal(chips.length, 2);
  assert.equal(chips[0].attrs["data-embed"], "08 Standards/知识库仪表盘.base#view");
  assert.equal(tree.children[0].children.some((node) => node.tag === "a"), false, "an embed is not a followed link");
});

test("an empty note parses to an empty tree", () => {
  assert.deepEqual(parseMarkdown("", { resolveLink: resolveNone }).children, []);
  assert.deepEqual(parseMarkdown("---\ntitle: x\n---\n", { resolveLink: resolveNone }).children, []);
});
