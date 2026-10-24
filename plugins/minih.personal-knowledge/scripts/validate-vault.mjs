import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createKnowledgeService,
  findSensitiveContent,
  parseFrontmatter,
} from "../mcp/knowledge-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = await createKnowledgeService({ pluginRoot: root });
const config = service.config;
const requiredNotes = [...new Set([
  ...(config.defaultNotes ?? []),
  ...(config.projects ?? []).flatMap((project) => project.notes ?? []),
  ...(config.topicRoutes ?? []).flatMap((route) => route.notes ?? []),
])];

for (const note of requiredNotes) await service.read({ note, maxChars: 2_000 });

for (const project of config.projects ?? []) {
  const context = await service.context({ cwd: project.repoPrefixes[0], topic: project.name, maxChars: 8_000 });
  if (!context.matchedProjects.includes(project.name)) {
    throw new Error(`Repository mapping failed for ${project.name}.`);
  }
}

const files = await service.listFiles();
let markdown = 0;
let bases = 0;
let frontmatter = 0;
const sensitive = [];
for (const relative of files) {
  if (relative.endsWith(".base")) {
    bases += 1;
    continue;
  }
  markdown += 1;
  const resolved = await service.resolveExisting(relative);
  const raw = await readFile(resolved.absolute, "utf8");
  if (Object.keys(parseFrontmatter(raw)).length) frontmatter += 1;
  for (const finding of findSensitiveContent(raw)) sensitive.push({ path: relative, ...finding });
}
if (sensitive.length) {
  throw new Error(`Sensitive credential patterns found: ${JSON.stringify(sensitive)}`);
}

const search = await service.search({ query: "EasyTier", limit: 5 });
if (search.count < 1) throw new Error("EasyTier canonical note was not searchable.");
const stale = await service.stale({ limit: 500 });

console.log(JSON.stringify({
  status: "ok",
  vault: service.vaultPath,
  files: files.length,
  markdown,
  bases,
  frontmatter,
  requiredNotes: requiredNotes.length,
  projects: (config.projects ?? []).map((project) => project.name),
  easyTierHits: search.count,
  staleOrUnverified: stale.count,
  sensitiveFindings: 0,
}, null, 2));
