---
name: obsidian-project-knowledge
description: Extract repository knowledge into structured Obsidian project notes. Use when the user wants to turn a codebase, docs folder, README, architecture, features, deployment flow, or operations knowledge into reusable Obsidian notes, MOCs, or linked project knowledge pages.
---

# Obsidian Project Knowledge

Use this skill when a user wants to **沉淀 / 提炼 / 保存项目知识到 Obsidian**.

This skill is for turning a repository into a small Obsidian knowledge system rather than dumping raw code summaries. It works best when the user wants reusable notes such as:
- project overview
- architecture notes
- feature notes
- deployment / operations notes
- MOC / knowledge map pages
- linked project knowledge packs

## Companion skills

Use these alongside this skill when relevant:
- `obsidian-cli` — locate the vault, create/read notes, verify links
- `obsidian-markdown` — write valid Obsidian notes with frontmatter and wikilinks
- `obsidian-bases` — only if the user also wants `.base` dashboards

## Outcome

Produce a **usable knowledge package** inside the user's Obsidian vault, typically including:
1. one project overview note
2. zero or one knowledge map / MOC
3. zero to N topic notes
4. links from existing project/resource/MOC pages
5. verification that notes and links resolve in Obsidian

## Workflow

### 1. Find the sink before writing
Determine the Obsidian vault first.

Preferred order:
1. If the user gave the vault path, use it
2. Otherwise use `obsidian vaults verbose` / `obsidian vault info=path`
3. If needed, search for `.obsidian` folders

Do not start writing notes until the vault target is known.

### 2. Scope the knowledge extraction
Identify what kind of knowledge the user wants:
- one document -> one note
- one repository -> project overview + supporting topic notes
- one subsystem / folder -> targeted design note
- one operational topic -> deployment / runbook note

Choose the smallest useful knowledge package.

### 3. Inspect the repository deliberately
Read only the files needed to form a reliable mental model.

Common starting points:
- `README.md`
- root `package.json` / workspace files
- app entrypoints
- router / module registry / schema files
- `docs/`
- deployment files
- representative controllers, services, stores, or views

Do not mechanically summarize every file. Extract:
- product purpose
- core capabilities
- module boundaries
- data model
- auth / sync / deploy design
- constraints and tradeoffs

### 4. Design the note set
Use these heuristics:

**Small repo / narrow request**
- create one note only

**Medium repo**
- create one project overview note
- add one or two topic notes if a concern is clearly distinct

**Broad or long-lived repo**
- create:
  - project overview
  - knowledge map / MOC
  - topic notes for major concerns

Typical topic splits:
- auth / SSO
- subsystem or integration model
- sync / identity model
- frontend/backend architecture
- deployment / operations

See `references/note-patterns.md` for templates.

### 5. Write notes for reuse, not for one-time reading
Each note should:
- have frontmatter
- use a stable title
- explain the problem the project is solving
- describe how the design works
- call out important constraints
- include related-note links

Prefer synthesis over raw file-by-file narration.

Good note names:
- `项目 - <repo-name>`
- `<Repo> - 知识地图`
- `<Repo> - 认证与 SSO 设计`
- `<Repo> - 前后端架构`
- `资料 - <topic>`

### 6. Connect the new notes into the vault
Do not leave notes orphaned.

When appropriate, append links to existing:
- project index pages
- resource index pages
- MOC pages
- standards / deployment pages

If no obvious index exists, create the new notes first and keep the internal links strong.

### 7. Verify in Obsidian
Minimum verification:
1. read the created note(s) via `obsidian read`
2. check the expected links via `obsidian links`
3. if you created `.base` files, open them and confirm views resolve

Report the created files and the verification evidence.

## Extraction heuristics

Prioritize these kinds of knowledge:
- **What the project is** — business purpose and user flows
- **How it is organized** — modules, pages, services, schemas
- **How identity works** — auth, SSO, token flow, role checks
- **How integrations work** — downstream systems, injection methods, protocols
- **How it runs** — deployment, runtime model, operational hazards
- **What is constrained** — single-node assumptions, data model shortcuts, known limits

Avoid low-value output such as:
- giant file inventories
- line-by-line summaries
- repeating obvious framework boilerplate
- copying whole docs when a durable summary is better

## Output contract

At completion, report:
- notes created or updated
- where they were linked
- what themes were captured
- how you verified the result
- remaining gaps, if any

## Examples of requests that should trigger this skill
- “把这个项目沉淀到我的 Obsidian 知识库”
- “帮我把仓库功能和架构整理成 Obsidian 笔记”
- “把 docs 和源码提炼成项目知识地图”
- “把这个 repo 的部署和设计保存到知识库”
