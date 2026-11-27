import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KnowledgeService } from "../mcp/knowledge-core.mjs";
import { renderKnowledgeContext } from "../mcp/tool-text.mjs";
import { estimateTokens } from "../lib/tokens.mjs";
import { createVault } from "./helpers/context-fixture.mjs";
import { isolatedHome } from "./helpers/home.mjs";

// Keep every fixture away from the real ~/.personal-knowledge.
await isolatedHome();

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_EMBEDDING_PATH = process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG;
const SANDBOX_INDEX_DIR = process.env.PERSONAL_KNOWLEDGE_INDEX_DIR;
const fixedNow = () => new Date("2026-07-17T00:00:00Z");

/** A service over a vault of exactly these files. */
async function serviceFor(files, config, embedding = { enabled: false }) {
  const { root, vault } = await createVault(files);
  const embeddingPath = path.join(root, "embedding.json");
  await writeFile(embeddingPath, `${JSON.stringify(embedding)}\n`);
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = embeddingPath;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = path.join(root, "index");
  const service = await new KnowledgeService({
    vaultPath: vault,
    config: { ignoreFolders: [], backupRetentionDays: 0, ...config },
    now: fixedNow,
    pluginRoot: PLUGIN_ROOT,
  }).initialize();
  return { root, vault, service };
}

/** Put the shared sandbox paths back for the next test in this file. */
function restoreSandboxPaths() {
  process.env.PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG = SANDBOX_EMBEDDING_PATH;
  process.env.PERSONAL_KNOWLEDGE_INDEX_DIR = SANDBOX_INDEX_DIR;
}

const DEMO_PROJECTS = [{ name: "Demo", repoPrefixes: ["/workspace/demo"], notes: ["01 Projects/Project - Demo.md"] }];

function projectNote(body, { summary = null } = {}) {
  const summaryLine = summary ? `summary: ${summary}\n` : "";
  return `---\ntitle: Project - Demo\ntype: project\nstatus: active\nverified: 2026-07-01\nreview_interval: quarterly\nrepo: /workspace/demo\n${summaryLine}---\n${body}`;
}

test("navigate returns the topic's section of a 48,000-character note, never the note", async () => {
  const log = Array.from(
    { length: 150 },
    (_, index) => `### 日志 ${index}\n\n${"记录当天的进展与结论。".repeat(30)}\n`,
  ).join("\n");
  const note = projectNote(
    `# Demo\n\n## 定位\n\n这是项目的定位。\n\n${log}\n## 预算与索引\n\n学习记忆的索引预算按 token 估算，索引与预算分开记录。\n\n## 其他\n\n其他内容。\n`,
  );
  const sectionOffset = note.indexOf("## 预算与索引");
  assert.ok(sectionOffset > 30_000, `the matching section starts at ${sectionOffset}`);
  assert.ok(note.length > 48_000, `the note is ${note.length} characters`);

  const { service } = await serviceFor({ "01 Projects/Project - Demo.md": note }, { projects: DEMO_PROJECTS });
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "学习记忆 索引 预算" });

  assert.equal(context.mode, "navigate");
  assert.equal(context.notes.length, 1);
  assert.equal(context.notes[0].content, undefined, "navigate never returns a whole routed note");
  const hit = context.sections.find((section) => section.headingPath.join(" > ").includes("预算与索引"));
  assert.ok(hit, "the section past character 30,000 is returned");
  assert.match(hit.content, /学习记忆/);
  assert.ok(hit.startLine > 1);
  assert.match(hit.sectionSha256, /^[a-f0-9]{64}$/);

  const text = renderKnowledgeContext(context);
  assert.ok(text.length <= 12_000, `the rendered pack is ${text.length} characters`);
  assert.match(text, /## Sections for "学习记忆 索引 预算"/);
});

test("the abstract comes from summary first, then the first body paragraph, and is redacted", async () => {
  const files = {
    "01 Projects/Project - Demo.md": projectNote("# Demo\n\n## 定位\n\n正文首段，不是摘要。\n", {
      summary: "一句话摘要：项目的当前定位。",
    }),
    "03 Resources/Alpha.md":
      "---\ntitle: Alpha\ntype: topic\nstatus: active\n---\n# Alpha\n\n> [!info] 提示\n\nAlpha 的首段正文。\n\n第二段。\n",
    "03 Resources/Leak.md":
      "---\ntitle: Leak\ntype: topic\nstatus: active\n---\n# Leak\n\napi_key: sk-abcdefghijklmnopqrstuvwxyz123456\n",
    "03 Resources/Empty.md": "---\ntitle: Empty\ntype: topic\nstatus: active\n---\n# Empty\n",
    "03 Resources/Frontmatter.md":
      "---\ntitle: Frontmatter\ntype: topic\nstatus: active\ndescription: 这是 frontmatter 里的描述，不该成为摘要。\n---\n# Frontmatter\n",
  };
  const config = {
    projects: DEMO_PROJECTS,
    topicRoutes: [{
      name: "Resources",
      aliases: ["资源"],
      notes: [
        "03 Resources/Alpha.md",
        "03 Resources/Leak.md",
        "03 Resources/Empty.md",
        "03 Resources/Frontmatter.md",
      ],
    }],
  };
  const { service } = await serviceFor(files, config);
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "资源" });
  const byPath = new Map(context.notes.map((note) => [note.path, note]));

  const project = byPath.get("01 Projects/Project - Demo.md");
  assert.equal(project.abstractSource, "summary");
  assert.equal(project.abstract, "一句话摘要：项目的当前定位。");

  const alpha = byPath.get("03 Resources/Alpha.md");
  assert.equal(alpha.abstractSource, "body");
  assert.equal(alpha.abstract, "Alpha 的首段正文。", "the callout header is skipped, not returned as prose");

  const leak = byPath.get("03 Resources/Leak.md");
  assert.match(leak.abstract, /\[REDACTED/);
  assert.doesNotMatch(leak.abstract, /sk-abcdefghijklmnopqrstuvwxyz/);

  assert.equal(byPath.get("03 Resources/Empty.md").abstract, "", "an empty note has no abstract");
  assert.doesNotMatch(
    byPath.get("03 Resources/Frontmatter.md").abstract,
    /frontmatter 里的描述/,
    "frontmatter text is never the abstract",
  );
});

test("outline entries carry chars and date, and stop after 60 headings", async () => {
  const many = Array.from({ length: 70 }, (_, index) => `## 条目 ${index}\n\n正文 ${index}。\n`).join("\n");
  const note = projectNote(`# Demo\n\n## 定位（2026-11-09 更新）\n\n定位正文。\n\n${many}`);
  const { service } = await serviceFor({ "01 Projects/Project - Demo.md": note }, { projects: DEMO_PROJECTS });
  const context = await service.context({ cwd: "/workspace/demo/src" });
  const [entry] = context.notes;

  // 71 headings in the note: 60 are reported and the rest are announced.
  assert.equal(entry.outline.length, 60);
  assert.equal(entry.outlineTruncated, true);
  assert.equal(entry.outline[0].level, 1);
  assert.equal(entry.outline[0].text, "Demo");
  assert.ok(entry.outline[0].chars > 0);
  assert.equal(entry.outline[0].date, "2026-11-09", "the date is read from the section body");
  assert.equal(entry.outline[1].text, "定位（2026-11-09 更新）");
  assert.equal(entry.outline[1].date, "2026-11-09", "and from the heading text when it has one");
  assert.ok(entry.outline.every((item) => Number.isInteger(item.chars) && item.chars > 0));
});

test("an empty topic returns no sections and says how to get them", async () => {
  const note = projectNote("# Demo\n\n## 定位\n\n定位正文。\n");
  const { service } = await serviceFor({ "01 Projects/Project - Demo.md": note }, { projects: DEMO_PROJECTS });
  const context = await service.context({ cwd: "/workspace/demo/src" });

  assert.deepEqual(context.sections, []);
  const text = renderKnowledgeContext(context);
  assert.doesNotMatch(text, /## Sections for/);
  assert.match(text, /Next: knowledge_read \{note, section\}/);
  // Nothing was retrieved, so the mode line must not report a channel state.
  assert.match(text, /Vector: not attempted/);
});

test("the pack stops at maxChars with truncated: true and drops sections whole", async () => {
  const section = (name) => `## ${name}\n\n${"这一节讨论预算与索引的细节。".repeat(20)}\n`;
  const note = (title) =>
    `---\ntitle: ${title}\ntype: project\nstatus: active\nrepo: /workspace/demo\n---\n# ${title}\n\n${
      ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"].map((name) => section(`预算 ${name}`)).join("\n")
    }`;
  const files = {
    "01 Projects/Project - Demo.md": note("Demo"),
    "03 Resources/One.md": note("One"),
    "03 Resources/Two.md": note("Two"),
  };
  const config = {
    projects: [{
      name: "Demo",
      repoPrefixes: ["/workspace/demo"],
      notes: ["01 Projects/Project - Demo.md", "03 Resources/One.md", "03 Resources/Two.md"],
    }],
  };
  const { service } = await serviceFor(files, config);
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "预算", maxChars: 4_000 });

  assert.equal(context.truncated, true);
  const text = renderKnowledgeContext(context);
  assert.ok(text.length <= 4_000, `the rendered pack is ${text.length} characters`);
  for (const item of context.sections) {
    assert.ok(
      item.content.endsWith("\n") || item.content.length === 2_000,
      "a section is dropped, never cut in the middle of a line",
    );
  }
});

test("a vector hit below the score floor never enters the fusion", async () => {
  const note = "---\ntitle: Servers\ntype: environment\nstatus: active\n---\n# Servers\n\n资产服务器 EasyTier center node.\n";
  const config = { projects: [{ name: "Demo", repoPrefixes: ["/workspace/demo"], notes: ["Servers.md"] }] };
  const { service } = await serviceFor({ "Servers.md": note }, config, {
    enabled: true,
    provider: "host",
    modelKey: "minih-router/embed",
  });
  try {
    // Every stored chunk scores 0.2 against the query vector [1, 0].
    const record = service.index.note("Servers.md");
    const rows = record.chunks.map((chunk) => ({
      path: "Servers.md",
      headingPath: chunk.headingPath,
      start: chunk.start,
      end: chunk.end,
      sha: chunk.sha,
    }));
    service.vectors.chunks = rows;
    service.vectors.meta = { formatVersion: 1, identity: "stub", dims: 2, count: rows.length };
    service.vectors.vectors = new Float32Array(rows.length * 2).fill(0.2);
    service.pendingChunkCount = 0;
    const embedQuery = async () => [1, 0];

    const ranked = await service.search({ query: "服务器" }, { embedQuery });
    assert.equal(ranked.retrieval.vector, "ready");
    const hit = ranked.results.find((result) => result.path === "Servers.md");
    assert.ok(hit);
    assert.ok(!hit.matchedBy.includes("vector"), "0.2 is below the default floor of 0.35");
    assert.ok(hit.matchedBy.includes("lexical"));

    // The same hit fuses once the floor lets it through.
    service.embeddingSettings = { ...service.embeddingSettings, scoreThreshold: 0 };
    const relaxed = await service.search({ query: "服务器" }, { embedQuery });
    assert.ok(relaxed.results.find((result) => result.path === "Servers.md").matchedBy.includes("vector"));
  } finally {
    restoreSandboxPaths();
  }
});

test("estimatedTokens matches the rendered text and counts Chinese characters one for one", async () => {
  const note = projectNote("# Demo\n\n## 定位\n\n这是一个中文段落，用来验证 token 估算的分层。\n");
  const { service } = await serviceFor({ "01 Projects/Project - Demo.md": note }, { projects: DEMO_PROJECTS });
  const context = await service.context({ cwd: "/workspace/demo/src" });
  const text = renderKnowledgeContext(context);

  assert.equal(context.estimatedTokens, estimateTokens(text));
  const chinese = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
  assert.ok(context.estimatedTokens >= chinese, `${context.estimatedTokens} >= ${chinese}`);
});

test("a section reports the lines and hash knowledge_read reports for it", async () => {
  const note = projectNote(
    "# Demo\n\n## A\n\n第一段 alpha。\n\n### A1\n\n嵌套段落。\n\n## B\n\nbeta 段落的正文，用来命中主题。\n",
  );
  const { service } = await serviceFor({ "01 Projects/Project - Demo.md": note }, { projects: DEMO_PROJECTS });
  const context = await service.context({ cwd: "/workspace/demo/src", topic: "beta" });
  const section = context.sections.find((item) => item.headingPath.join(" > ") === "Demo > B");
  assert.ok(section, `expected the B section, got ${context.sections.map((item) => item.headingPath.join(" > ")).join(" | ")}`);

  const read = await service.read({ note: "01 Projects/Project - Demo.md", section: "B" });
  assert.equal(section.startLine, read.section.startLine + 1, "1-based line numbers, same section");
  assert.equal(section.endLine, read.section.endLine);
  assert.equal(section.sectionSha256, read.sectionSha256, "a later write can reuse the hash");
  assert.equal(section.content, read.content, "the excerpt is the section, not a chunk of it");
});