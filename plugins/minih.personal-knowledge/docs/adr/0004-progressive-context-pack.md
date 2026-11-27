# ADR 0004: Progressive context pack (L0 / L1 / L2) for `knowledge_context`

- Status: Accepted (2026-11-27); shipped as 0.8.0
- Plugin: `minih.personal-knowledge`, baseline 0.7.2 (`b8c2e14`)
- Amends: ADR 0001 §6 (hybrid retrieval gains a chunk-level scoped mode and a
  vector score threshold), ADR 0001 §3 (ontology gains the `summary`
  attribute), ADR 0003 §2 (the main process owns one more tool in `host` mode)
- Reference reviewed from source: OpenViking (`volcengine/OpenViking`,
  `0d9528a6f`, 2026-11-27) — directory sidecars `.abstract.md` (L0, 256 chars)
  and `.overview.md` (L1, 4,000 chars) read before the body (L2); recall is
  scoped to a subtree and capped by a token budget (2,000 tokens); CJK-aware
  token estimates. Evidence of mechanisms, not of their shipped defaults.

## Context

### Current behavior

`knowledge_context` (`mcp/knowledge-core.mjs`, `context()`) routes by the
mapping file, by project notes whose `repo` covers `cwd`, and by alias or
title substrings of `topic`. It then reads every routed note **head-first and
whole**: up to `contextPerNoteChars` (24,000) per note inside a total
`maxChars` (default 32,000). `topic` never reaches the lexical or vector
channel; the hybrid retrieval of ADR 0001 §6 is used only by
`knowledge_search`.

### Measured defects (read-only scan of the user's vault, 2026-11-27)

| Fact | Evidence |
|---|---|
| Project notes are far above the 24,000-character line that ADR 0001 §4 calls a defect | 785 knowledge notes (conversation archive excluded): p50 5,576 chars, p90 40,379, max 222,171. `type: project` notes: Hungraim AIT 105,596; Minih-Router 73,063; Minih-Agent-Desktop 47,932; shmh-dp 42,630 |
| The head of a project note is its dated event log, not its current truth | `项目 - Minih-Agent-Desktop.md`: after `## 定位` and `## 仓库与状态`, the next 20 H2 headings are dated items (`## 会话分层归档（2026-11-09 …）`, …). A head cut at 24,000 chars keeps roughly the first half of that log and drops whatever the task needs |
| One call costs 20–30k tokens | 32,000 chars of mostly Chinese text; a CJK character is about one token, not the quarter the `chars / 4` habit assumes |
| No note carries a one-line summary | 0 of 2,102 notes have `summary`, `abstract`, or `description` in frontmatter, so nothing short can stand in for a note |
| The vector channel has no floor | `#searchRanked` fuses the 50 nearest chunks whatever their cosine score; a scoped query with no relevant vectors still fills `limit` |

### Constraints (unchanged from ADR 0001 and 0003)

- No new MCP tools; optional parameters and additive fields only.
- Markdown is the only source of truth; indexes are derived and rebuildable.
- Reads are tolerant, writes are strict; nothing leaves the machine by default.
- In `host` mode only the plugin's main process can compute a query vector, so
  a tool that needs the vector channel is registered there and withheld from
  the MCP `tools/list` for the life of that process (ADR 0003 §2).
- The host reads `tools/list` once per connection; the MCP server and the
  main process must render identical text for the same tool.

## Decision

### 1. `knowledge_context` gains a `mode`

| `mode` | Behavior |
|---|---|
| `navigate` (new default) | Routed notes are returned as **L0 + L1** (abstract and outline). `topic` is run through the hybrid retrieval **scoped to the routed notes** and the best sections come back as **L2 excerpts**. Default `maxChars` 12,000 |
| `full` | Today's behavior, byte-for-byte the same rendered text. Default `maxChars` 32,000 |

Routing itself (mapping projects, topic routes, `repo` matching, default
notes, recent conversations) does not change.

### 2. The three layers

**L0 — `abstract`.** `metadata.summary` when it is a non-empty string
(trimmed, at most 320 characters; longer values are cut at the last sentence
end inside the limit, or hard-cut with `…`). Otherwise the first paragraph of
the body after the H1 — skipping blank lines, headings, callouts (`> [!`),
images, and HTML comments — cut to 256 characters the same way. The text is
redacted with the existing `redactSensitiveContent`. `abstractSource` is
`"summary"` or `"body"`.

**L1 — `outline`.** The index's `headingOutline` (levels 1–3) with two
additions per entry: `chars`, the character count of that heading's section
(to the next heading of the same or higher level), and `date`, the first
`YYYY-MM-DD` found in the heading text or the section body, or `null`. At most
60 entries; past that the list stops and `outlineTruncated: true` is set.

**L2 — `sections`.** Only when `topic` is non-empty. Chunk-level hybrid
retrieval (§3) scoped to the routed notes. Each hit returns `path`, `title`,
`headingPath`, `startLine`, `endLine`, `sectionSha256` (the same hash
`knowledge_read` returns for that section, so a later write can reuse it),
`score`, `matchedBy`, and redacted `content` of at most `sectionChars`
(default 2,000) characters. Duplicates by `(path, headingPath)` are dropped.
At most `sectionLimit` hits (default 6, bound 1–12).

**Default notes** keep today's head excerpt under `defaultNoteSummaryChars`
(4,000) in addition to their L0/L1, because the user chose them for every
call.

**Budget.** Abstracts, outline lines, default-note heads, and section content
all count against `maxChars`. Order: default notes, then routed notes
(L0/L1), then sections by score. The pack stops at the budget and reports
`truncated: true`. Nothing in `navigate` mode returns a whole routed note.

### 3. Scoped chunk-level retrieval and a score floor

`#searchRanked` is generalized so the scope can be a **predicate over
paths** (today: one folder prefix) and so fusion can run at **chunk
granularity** (today: best chunk per note). Both uses keep their current
output; `context()` is the first caller of the chunk-level, path-set form.
Graph expansion is not applied to section retrieval; it stays note-level in
`knowledge_search`.

A vector hit enters fusion only when its cosine score is at least
`scoreThreshold`. The value lives in `~/.personal-knowledge/embedding.json`
as an optional field, default `0.35`, validated as a number in `[0, 1]`
(`EMBEDDING_CONFIG_INVALID` names the field otherwise). It applies to
`knowledge_search` and to `context()` alike. The settings panel must preserve
the field when it rewrites the file; a test proves the round trip.

### 4. `host` mode ownership

`knowledge_context` joins `MAIN_PROCESS_TOOLS` in `mcp/tool-text.mjs`. In
`host` mode the main process registers it through `pi.agent.registerTool`
and passes `embedQuery`; the MCP server withholds it from `tools/list`
exactly as it does for the two retrieval tools. In every other mode the MCP
server serves it as today.

To keep the two paths identical, the `knowledge_context` schema moves from
`mcp/server.mjs` into `TOOL_SCHEMAS`, and its renderer becomes
`renderKnowledgeContext(value)` in `mcp/tool-text.mjs`, used by both
`renderToolResult` and `renderMainProcessTool`. The `full` branch of that
renderer reproduces today's output.

### 5. Rendered text (`navigate`)

```text
Matched projects: …
Matched routes: …
Mode: navigate · Estimated tokens: 3,420 · Vector: ready | partial (n pending) | unavailable (REASON) | disabled

## Recent conversations            (unchanged block)

## Notes
### <title>
Path: … · Type: project · Status: active · Updated: 2026-11-10 · Verified: 2026-11-10 (quarterly)
SHA-256: …
Abstract (summary|body): …
Outline:
- ## 定位 (812 chars)
- ## 仓库与状态 (1,540 chars)
- ## 会话分层归档（2026-11-09 v1.4.0 已发布） (2,311 chars, 2026-11-09)
  - ### … 
[outline truncated at 60 headings]

## Sections for "<topic>"
### <title> › <H2> > <H3>   score=0.0312 · lexical, vector
Path: … · Lines 231–244 · Section SHA-256: …
<content>

Next: knowledge_read {note, section} reads any other heading; knowledge_search {scope} searches beyond these notes.
```

`Estimated tokens` is computed over the rendered text: a character in the
CJK ranges (U+3000–U+9FFF, U+F900–U+FAFF, U+FF00–U+FFEF, Hangul syllables,
kana) counts 1, every other character counts 0.25, rounded up. The number is
also returned as `estimatedTokens` in the structured result.

### 6. Ontology: the `summary` attribute

`config/ontology.default.yaml` adds `summary` to `attributes`. Validation
adds two codes: `SUMMARY_INVALID` (not a string, or longer than 320
characters) and `SUMMARY_MISSING`. `SUMMARY_MISSING` is reported only for
entity classes `project`, `topic`, `procedure`, `reference`, `convention`,
`environment`, only as a warning, and only by `knowledge_write` (dry-run and
real) and `scripts/lint-vault.mjs`. It never blocks a write, even under
`enforcement: enforce`, because it describes what the note lacks, not an
error the write introduces.

Automatic generation of summaries (through `pi.agent.complete`, opt-in, with
user confirmation before write-back) is a follow-up, not part of this change.

### 7. Skills and tool descriptions

- `skills/obsidian-knowledge/SKILL.md` "Retrieve enough context" step 1–2:
  call `knowledge_context` with the real `cwd` and a narrow `topic`; the
  default `navigate` pack returns abstracts, outlines, and the sections that
  match the topic; read other headings with `knowledge_read {note, section}`;
  use `mode: "full"` only when the user asks for a whole note. Remove the
  "a complete note returned by context is sufficient" sentence.
- `skills/obsidian-knowledge/references/routing.md`: document `summary` as
  the one-sentence L0 of a note and ask for it on new entity notes.
- `knowledge_context` description in `TOOL_SCHEMAS` names the two modes and
  the `topic` → sections behavior.
- The `instructions` string in `mcp/server.mjs` keeps "Call knowledge_context
  before relevant work" and adds "with a narrow topic".

### 8. Compatibility and release

- `mode: "full"` is byte-identical to 0.7.2. The default moves to
  `navigate`, which is a user-visible change in what the model receives and
  is therefore a **minor** bump: 0.7.2 → 0.8.0 in `manifest.json` and
  `package.json`, with a README paragraph in the repository root and the
  plugin description unchanged.
- No new permission, no `engines.minihAgent` change, no stored-format change.
  `embedding.json` gains one optional field with a default; a file without it
  behaves as before plus the 0.35 floor.
- Config keys `contextPerNoteChars` and `defaultNoteSummaryChars` keep their
  meaning; `contextPerNoteChars` applies to `full` mode only.

## Out of scope

Automatic summary generation; per-prompt recall injected through
`agent.extension` hooks (needs its own ADR and a high permission); the vault
content migration that splits oversized entity notes (ADR 0001 §5 plan, a
user-approved content task); a rerank model; LLM intent analysis.

## Consequences

- A `knowledge_context` call for a project with a 48k-character note drops
  from ~24,000 head characters to a few hundred characters of abstract and
  outline plus the sections that match the topic; the model reads the rest on
  demand.
- `knowledge_search` behavior changes only through the score floor: a scoped
  query whose vectors are all below 0.35 falls back to lexical and graph
  hits, which the `retrieval` field already reports.
- Two code paths (MCP and main process) serve `knowledge_context`; the shared
  schema and renderer are what keep them equal, and a test asserts it.

## Implementation plan

Branch `feat/personal-knowledge-context-pack-v2`, worktree
`.worktree/pk-context-pack-v2`. Files are under
`plugins/minih.personal-knowledge/` unless stated.

1. **`lib/sections.mjs`** — `sectionSizes(outline, body)` → `chars` per
   heading; `firstIsoDate(text)`; `firstParagraphAfterH1(body)`;
   `cutAtSentence(text, max)` (prefers `。．！？!?.` boundaries, else hard cut
   with `…`). Pure functions, unit-tested in `tests/sections.test.mjs`.
2. **`lib/tokens.mjs`** — `estimateTokens(text)` with the CJK rule of §5
   (check first whether the module already has a tokenizer helper; add beside
   it, do not change existing exports). Test: a 100-character Chinese string
   estimates ≥ 100; a 100-character ASCII string estimates 25.
3. **`lib/embeddings.mjs`** — `scoreThreshold` in `loadEmbeddingSettings`
   defaults and validation; `view/embedding-form.mjs` / settings save path
   preserves unknown keys and this one. Tests in
   `tests/embedding-settings.test.mjs` (invalid value names the field) and
   `tests/settings-panel.test.mjs` (round trip).
4. **`mcp/knowledge-core.mjs`**
   - Factor `#searchRanked` into `#retrieve({ query, inScope, granularity:
     "note" | "chunk", limit, embedQuery })` returning fused hits with their
     channel scores; `#searchRanked` keeps its output by calling it with
     `granularity: "note"` plus graph expansion and rerank. Apply the score
     floor to vector hits inside `#retrieve`.
   - `abstractFor(record)`, `outlineFor(record)` using §1 helpers; both
     redact.
   - `context()` gains `mode`, `sectionLimit`, `sectionChars`; `navigate`
     builds the pack of §2 with the budget order of §2; `full` is the current
     code path moved under the branch unchanged. `estimatedTokens` is filled
     by the renderer caller (server / main) from the rendered text, and also
     attached to the structured result before rendering (render once, measure,
     then prepend the header line — or compute over the body and add a fixed
     header allowance; pick one and test it).
5. **`mcp/tool-text.mjs`** — `knowledge_context` schema (with `mode`,
   `sectionLimit`, `sectionChars`), `renderKnowledgeContext`, add the name to
   `MAIN_PROCESS_TOOLS`. **`mcp/server.mjs`** — use the shared schema and
   renderer; withhold the tool in host mode with the existing mechanism.
   **`main.js`** — `runKnowledgeTool` handles `knowledge_context` with
   `embedQuery`.
6. **Ontology** — `config/ontology.default.yaml`, `lib/ontology.mjs`
   (`SUMMARY_INVALID`, `SUMMARY_MISSING` as warnings per §6),
   `scripts/lint-vault.mjs` output. Tests in `tests/ontology.test.mjs`.
7. **Skills and descriptions** per §7.
8. **Version and docs** — 0.8.0 in `manifest.json` and `package.json`;
   root `README.md` table row and a 0.8.0 paragraph; this ADR's status to
   Accepted with the merge date.

### Tests that must exist

In `tests/knowledge-core.test.mjs` (fixture vault in a temp dir, as today):

- `navigate` pack for a 48,000-character project note whose topic-relevant
  section sits after character 30,000: the result contains that section in
  `sections`, contains no `content` for the note itself, and the rendered text
  is under `maxChars`.
- `abstract` comes from `summary` when present (`abstractSource: "summary"`),
  from the first body paragraph otherwise, never from frontmatter text, and
  is redacted.
- `outline` entries carry `chars` and `date`; a note with 70 headings sets
  `outlineTruncated: true` and returns 60 entries.
- Empty `topic` → `sections: []` and the rendered hint line.
- `mode: "full"` renders exactly the 0.7.2 text for the existing fixture
  (snapshot the current output before refactoring and assert equality).
- Budget: `maxChars: 4000` with three routed notes stops with
  `truncated: true` and never splits a section in the middle of a line.
- Score floor: a stub `embedQuery` plus a vector index whose best cosine is
  0.2 yields `matchedBy` without `vector` and `retrieval.vector` unchanged.
- Host mode: `renderMainProcessTool("knowledge_context", value)` equals
  `renderToolResult("knowledge_context", value)` for the same value; the MCP
  `tools/list` omits the tool when `provider: "host"` (extend
  `tests/mcp-tool-list.test.mjs`).
- `estimatedTokens` for a Chinese-only pack is at least its character count.

### Verification (development tier)

- `npm test` in the plugin directory (builds `lib/` then `node --test`).
- `node scripts/probe-mcp.mjs` against the real vault, read-only, with
  `cwd=/Users/Shared/Projects/Minih-Agent-Desktop` and
  `topic="学习记忆 索引 预算"`: record the rendered length and
  `estimatedTokens` for `navigate` and `full` in the delivery report.
- `git diff --check`.

### Not in this change

Packaging (`.piplug`, `catalog.json`, `releases.json`), merging, pushing, and
any vault content edit. The review happens on the branch; the maintainer
merges and publishes.
