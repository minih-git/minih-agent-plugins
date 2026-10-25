#!/usr/bin/env node
/**
 * Ontology migration tool (ADR 0001 §5). Read-only unless `--apply`.
 *
 *   node scripts/ontology-migrate.mjs --plan
 *     Scans the vault and writes plan.json + plan.md under
 *     ~/.personal-knowledge/migrations/<stamp>/ (or --out <dir>). The vault is
 *     never written.
 *
 *   node scripts/ontology-migrate.mjs --apply <planDir> --batch <n>
 *     Applies at most 30 notes per batch through knowledge_write
 *     (patchFrontmatter), so the body stays byte-for-byte unchanged and every
 *     change is backed up. `applied.json` records before/after hashes and the
 *     batch stops at the first stale hash. Entries marked `review: true` are
 *     never applied automatically.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createKnowledgeService } from "../mcp/knowledge-core.mjs";
import { groupReviewChanges, mapStatusChange } from "../lib/migrate-rules.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BATCH_SIZE = 30;

// Odd stability values observed in the wild and their best-guess class value.
const STABILITY_GUESSES = {
  verified: "stable",
  snapshot: "mixed",
  evolving: "volatile",
  event: "historical",
  high: "stable",
};

const PREFERENCE_RULES = [
  [/中文|chinese|汇报/i, "covered-by-AGENTS.md", "AGENTS.md 已规定中文汇报"],
  [/commit|提交信息|conventional/i, "covered-by-AGENTS.md", "AGENTS.md 已规定提交规范"],
  [/worktree|工作树/i, "covered-by-AGENTS.md", "AGENTS.md 已规定工作树流程"],
  [/凭据|credential|token|密钥/i, "covered-by-AGENTS.md", "AGENTS.md 已规定凭据红线"],
];

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function planChanges(note, ontology) {
  const changes = [];
  const metadata = note.metadata ?? {};
  const rawType = metadata.type;
  const cls = ontology.resolveClass(rawType);

  if (rawType && ontology.isAlias(rawType) && cls && cls !== rawType) {
    changes.push({ key: "type", from: rawType, to: cls, rule: "type-alias", review: false });
  }

  if (cls) {
    const vocabulary = ontology.statusVocabulary(cls);
    const status = metadata.status;
    if (vocabulary && status !== undefined && status !== "" && !vocabulary.includes(String(status))) {
      const value = String(status);
      const mapping = mapStatusChange(value, cls, vocabulary);
      changes.push({
        key: "status",
        from: value,
        to: mapping.to,
        ...(mapping.to2 ? { to2: mapping.to2 } : {}),
        ...(mapping.to === null ? { note: "无法自动映射，需人工决定目标状态" } : {}),
        rule: mapping.rule,
        review: true,
      });
    }
  }

  const stability = metadata.stability;
  if (stability !== undefined && stability !== "" && !ontology.stabilities.has(String(stability))) {
    const guess = STABILITY_GUESSES[String(stability)];
    changes.push({
      key: "stability",
      from: String(stability),
      to: guess ?? ontology.defaultStability(cls) ?? "stable",
      rule: guess ? "stability-guess" : "stability-default",
      review: true,
    });
  }

  // Folder-implied project backfill: a note under `01 Projects/<Folder>/` with
  // no `project` predicate points at the folder's project note.
  if (!metadata.project && note.path.startsWith("01 Projects/")) {
    const rest = note.path.slice("01 Projects/".length);
    const folder = rest.includes("/") ? rest.split("/")[0] : null;
    if (folder && folder !== path.basename(note.path)) {
      const candidates = [
        `01 Projects/${folder}.md`,
        `01 Projects/项目 - ${folder}.md`,
      ];
      let target = candidates.find((candidate) => service.index.note(candidate));
      if (!target) {
        target = service.index.paths().find(
          (candidate) =>
            candidate.startsWith(`01 Projects/${folder}/`) &&
            service.index.note(candidate)?.metadata?.type === "project",
        );
      }
      if (target) {
        changes.push({
          key: "project",
          from: null,
          to: `[[${target.replace(/\.md$/, "")}]]`,
          rule: "folder-implied",
          review: false,
        });
      }
    }
  }
  return changes;
}

function planRelations(note, ontology) {
  const proposals = [];
  if (ontology.resolveClass(note.metadata?.type) !== "project") return proposals;
  const proposed = { deployed_to: [], uses: [], for: [] };
  for (const target of note.linkTargets) {
    const resolved = service.index.resolveTarget(target);
    if (!resolved || resolved === note.path) continue;
    const targetNote = service.index.note(resolved);
    const targetClass = ontology.resolveClass(targetNote?.metadata?.type);
    if (targetClass === "environment" && !proposed.deployed_to.includes(target)) proposed.deployed_to.push(target);
    if (targetClass === "technology" && !proposed.uses.includes(target)) proposed.uses.push(target);
    if (targetClass === "organization" && !proposed.for.includes(target)) proposed.for.push(target);
  }
  for (const [predicate, targets] of Object.entries(proposed)) {
    if (targets.length === 0) continue;
    proposals.push({ path: note.path, predicate, targets, rule: "body-link-draft", review: true });
  }
  return proposals;
}

function planSplits(note, ontology) {
  if (note.chars <= ontology.oversizeChars) return [];
  const sections = (note.outline ?? []).filter((entry) => entry.level <= 2);
  const dated = sections.filter((entry) => /(?:20\d{2}|\d{4}[-/年])/.test(entry.text));
  return [
    {
      path: note.path,
      chars: note.chars,
      keep: sections.filter((entry) => !dated.includes(entry)).map((entry) => entry.text).slice(0, 40),
      becomeEvents: dated.map((entry) => entry.text).slice(0, 200),
      rule: "oversize-split-draft",
      review: true,
    },
  ];
}

function planBases(ontology) {
  const plans = [];
  for (const relative of service.index.paths()) {
    if (!relative.endsWith(".base")) continue;
    const raw = service.index.note(relative)?.raw ?? "";
    for (const match of raw.matchAll(/type\s*==\s*"([^"]+)"/g)) {
      const value = match[1];
      const cls = ontology.resolveClass(value);
      if (cls && cls !== value) {
        plans.push({ path: relative, from: value, to: cls, rule: "base-filter-alias", review: false });
      } else if (!cls) {
        plans.push({ path: relative, from: value, to: null, rule: "base-filter-unknown", review: true });
      }
    }
  }
  return plans;
}

function planPreferences() {
  const notePath = service.index.resolveTarget("02 Areas/领域 - 个人开发与协作偏好");
  if (!notePath) return [];
  const raw = service.index.note(notePath)?.raw ?? "";
  const items = [];
  for (const line of raw.split("\n")) {
    const bullet = /^- (.+)$/.exec(line.trim());
    if (!bullet) continue;
    const text = bullet[1];
    const matched = PREFERENCE_RULES.find(([pattern]) => pattern.test(text));
    items.push({
      bullet: text,
      destination: matched ? matched[1] : "review",
      note: matched ? matched[2] : "需要用户决定归属",
      review: true,
    });
  }
  return items.length ? [{ path: notePath, items }] : [];
}

function renderPlanMd(plan) {
  const lines = [
    "# 知识本体迁移计划",
    "",
    `- 生成时间：${plan.generatedAt}`,
    `- 知识库：${plan.vault}`,
    `- 笔记数：${plan.notes.length}（含自动项 ${plan.notes.reduce((sum, note) => sum + note.changes.filter((change) => !change.review).length, 0)} 条、待确认项 ${plan.notes.reduce((sum, note) => sum + note.changes.filter((change) => change.review).length, 0)} 条）`,
    "",
    "## 自动可应用的变更（review: false）",
    "",
    "| 笔记 | 键 | 从 | 到 | 规则 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const note of plan.notes) {
    for (const change of note.changes.filter((change) => !change.review)) {
      lines.push(`| ${note.path} | ${change.key} | ${change.from ?? "∅"} | ${change.to} | ${change.rule} |`);
    }
  }
  const reviewGroups = groupReviewChanges(plan.notes);
  lines.push("", "## 需要人工确认的变更（按组汇总，可整组批准）", "", "| 规则 | 键 | 从 | 建议 | 条数 | 示例笔记 |", "| --- | --- | --- | --- | --- | --- |");
  for (const group of reviewGroups) {
    lines.push(`| ${group.rule} | ${group.key} | ${group.from} | ${group.to} | ${group.count} | ${group.examplePaths[0]} |`);
  }
  lines.push("", "### 待确认明细", "", "| 笔记 | 键 | 从 | 建议 | 规则 |", "| --- | --- | --- | --- | --- |");
  for (const note of plan.notes) {
    for (const change of note.changes.filter((change) => change.review)) {
      lines.push(`| ${note.path} | ${change.key} | ${change.from ?? "∅"} | ${change.to ?? "需人工决定"}${change.to2 ? ` + ${JSON.stringify(change.to2)}` : ""} | ${change.rule} |`);
    }
  }
  lines.push("", "## Base 过滤器", "", "| 文件 | 从 | 到 | 规则 | review |", "| --- | --- | --- | --- | --- |");
  for (const base of plan.bases) {
    lines.push(`| ${base.path} | ${base.from} | ${base.to ?? "需人工判断"} | ${base.rule} | ${base.review} |`);
  }
  lines.push("", "## 项目笔记的类型化关系草案", "");
  for (const relation of plan.relations) {
    lines.push(`- ${relation.path} → ${relation.predicate}: ${relation.targets.map((target) => `[[${target}]]`).join(", ")}（待确认）`);
  }
  lines.push("", "## 超长笔记拆分草案", "");
  for (const split of plan.splits) {
    lines.push(`- ${split.path}（${split.chars} 字符）：保留 ${split.keep.length} 节，${split.becomeEvents.length} 个日期小节迁出为事件笔记（待确认）`);
  }
  lines.push("", "## 偏好笔记去重草案", "");
  for (const preference of plan.preferences) {
    lines.push(`- ${preference.path}：${preference.items.length} 条待确认`);
    for (const item of preference.items) {
      lines.push(`  - 「${item.bullet}」→ ${item.destination}（${item.note}）`);
    }
  }
  lines.push("", "## 存储规则（批准后写入 08 Standards/知识库规范）", "", ...STORAGE_RULES.map((rule) => `- ${rule}`));
  return lines.join("\n");
}

const STORAGE_RULES = [
  "实体笔记陈述现状，可原地编辑。",
  "事件笔记记录一件有日期的事，事件关闭后只追加，并通过 project 与 affects 指向实体。",
  "实体笔记超过 24,000 字符是缺陷：日期日志迁到事件笔记，实体保留摘要与链接。",
  "类型化关系写在 frontmatter；正文 wikilink 是弱链接。",
  "每个事实只有一个权威出处（AGENTS.md、Desktop learned memory、Vault 各管一段），其他地方链接过去。",
];

const service = await createKnowledgeService({ pluginRoot });
const ontology = service.ontology;
await service.index.refresh();

if (process.argv.includes("--plan")) {
  const notes = [];
  for (const relative of service.index.paths()) {
    if (!relative.endsWith(".md")) continue;
    const record = service.index.note(relative);
    const changes = planChanges(record, ontology);
    if (changes.length > 0) notes.push({ path: relative, changes });
  }
  const relations = service.index
    .paths()
    .filter((relative) => relative.endsWith(".md"))
    .flatMap((relative) => planRelations(service.index.note(relative), ontology));
  const splits = service.index
    .paths()
    .filter((relative) => relative.endsWith(".md"))
    .flatMap((relative) => planSplits(service.index.note(relative), ontology));
  const plan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    vault: service.rootRealpath,
    ontologySource: ontology.source,
    notes,
    bases: planBases(ontology),
    relations,
    splits,
    preferences: planPreferences(),
    storageRulesTarget: "08 Standards/知识库规范.md",
    storageRules: STORAGE_RULES,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(argValue("--out") ?? path.join(os.homedir(), ".personal-knowledge", "migrations", stamp));
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(path.join(outDir, "plan.md"), `${renderPlanMd(plan)}\n`);
  process.stdout.write(`计划已写入（未改动知识库）：${outDir}\n`);
  process.stdout.write(`  自动可应用变更 ${plan.notes.reduce((sum, note) => sum + note.changes.filter((change) => !change.review).length, 0)} 条\n`);
  process.stdout.write(`  待人工确认变更 ${plan.notes.reduce((sum, note) => sum + note.changes.filter((change) => change.review).length, 0)} 条\n`);
  process.stdout.write(`  Base 过滤器 ${plan.bases.length} 项；关系草案 ${plan.relations.length} 项；拆分草案 ${plan.splits.length} 篇；偏好条目 ${plan.preferences.reduce((sum, entry) => sum + entry.items.length, 0)} 条\n`);
} else if (process.argv.includes("--apply")) {
  const planDir = path.resolve(argValue("--apply"));
  const batchNumber = Number(argValue("--batch"));
  if (!Number.isInteger(batchNumber) || batchNumber < 1) {
    process.stderr.write("--apply 需要 --batch <n>（从 1 开始）\n");
    process.exit(1);
  }
  const plan = JSON.parse(await readFile(path.join(planDir, "plan.json"), "utf8"));
  const entries = plan.notes
    .map((note) => ({
      path: note.path,
      patch: Object.fromEntries(
        note.changes
          .filter((change) => !change.review && change.to != null)
          .map((change) => [change.key, change.to]),
      ),
    }))
    .filter((entry) => Object.keys(entry.patch).length > 0)
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  const batches = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) batches.push(entries.slice(i, i + BATCH_SIZE));
  const batch = batches[batchNumber - 1];
  if (!batch) {
    process.stderr.write(`批次 ${batchNumber} 不存在（共 ${batches.length} 批）\n`);
    process.exit(1);
  }
  const applied = [];
  for (const entry of batch) {
    const fresh = await service.read({ note: entry.path });
    const result = await service.write({
      path: fresh.path,
      frontmatter: entry.patch,
      operation: "patchFrontmatter",
      expectedSha256: fresh.sha256,
      dryRun: false,
    });
    applied.push({ path: fresh.path, before: fresh.sha256, after: result.afterSha256 });
  }
  const appliedPath = path.join(planDir, "applied.json");
  let log = { batches: [] };
  try {
    log = JSON.parse(await readFile(appliedPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  log.batches.push({ batch: batchNumber, at: new Date().toISOString(), applied });
  await writeFile(appliedPath, `${JSON.stringify(log, null, 2)}\n`);
  process.stdout.write(`批次 ${batchNumber} 完成：${applied.length} 篇（详情 ${appliedPath}）\n`);
  process.stdout.write(`剩余批次：${batches.length - batchNumber}\n`);
} else {
  process.stderr.write("用法：ontology-migrate.mjs --plan | --apply <planDir> --batch <n>\n");
  process.exit(1);
}
