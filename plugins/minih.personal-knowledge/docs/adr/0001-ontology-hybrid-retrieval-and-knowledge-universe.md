# ADR 0001: Lightweight ontology, hybrid retrieval, and the Knowledge Universe view

- Status: Accepted (2026-10-24)
- Plugin: `minih.personal-knowledge`, baseline 0.1.2 (`a10dd1d`)
- Related (Minih-Agent-Desktop): ADR `agent-long-term-memory` (D668),
  ADR `learned-memory-consolidation` (Proposed), ADR 0168 (external URL
  allowlist), ADR `plugin-learned-memory-read` (Accepted, D682)
- Amended 2026-10-24: remote embedding providers behind an explicit switch
  (§6.1), at the user's request
- Amended 2026-10-24 (2): the view is redesigned as a 3D star map with a flat
  chart mode; the visual and interaction rules now live in
  `docs/design/knowledge-universe-v2.md` (§10). `deployment` is read as
  `release` (§3)

## Context

### Current behavior (0.1.2)

The plugin turns a local Obsidian vault into long-term agent context through
one stdio MCP server (`mcp/server.mjs`) and two skills. `main.js` is a
declarative stub. The server exposes six tools: `knowledge_context`,
`knowledge_search`, `knowledge_read`, `knowledge_stale`, `knowledge_links`,
and `knowledge_write`. Every call walks the vault and reads every file again.
Since 0.1.2 the vault and the mapping file are resolved in this order:
environment variable, then `~/.personal-knowledge/repo-map.json`, then the
bundled template. The manifest declares no settings.

What works and must be kept:

- Path containment: relative paths only, no hidden components, `realpath`
  checks against the vault root.
- Guarded writes: dry-run by default, compare-and-set on the whole-file
  SHA-256, atomic temp-file rename, a timestamped backup with retention, a
  credential detector that rejects the write, and a read-only switch
  (`PERSONAL_KNOWLEDGE_READ_ONLY`).
- Redacted snippets and reads.
- Time-aware metadata (`updated`, `verified`, `verification_scope`,
  `stability`, `review_interval`) and `knowledge_stale`.

### Measured defects

All figures come from a read-only probe of the user's vault on 2026-10-24:
273 Markdown notes, 15 Bases, 1.61 MB.

| Defect | Evidence |
|---|---|
| YAML block lists are lost | `parseFrontmatter` reads only single-line `key: value`. All 224 notes that write `tags` as a block list parse to an empty value; `aliases` and relation lists fail the same way |
| Whole-note replace is the only write | 13 notes exceed the default 24,000-character read window; one note has 123,629 characters, above the 100,000-character read maximum, so it cannot be read in full and then written back safely |
| CJK search is a literal substring match | Terms split only on whitespace. `服务器资产` finds 3 notes; `资产服务器` finds 0 |
| Routing ignores metadata | 177 notes carry `repo` and 171 carry `project`; `knowledge_context` routes only through the hand-written `repo-map.json` |
| Writes check no vocabulary | Only non-empty `title` and `type` are required |
| A redacted read can be written back | `knowledge_read` returns redacted text but the SHA of the raw file, so a full replacement built from it would persist `[REDACTED]` (0 notes affected today) |
| Full scan per call | `knowledge_search` takes 104–327 ms and `knowledge_links` 143 ms. That is acceptable now, but a graph view and vector search would need the same scan again |

### Vault content state

- `type` has 25 values; the standard note lists 6. `release`,
  `release-record`, and `agent-release-record` mean the same thing.
- `stability` has values outside the standard: `verified` (10), `snapshot`
  (7), `evolving` (3), `event` (2), `high` (1).
- `status` has 25 values, several of which are a deployment log, for
  example `merged-main-not-deployed` or `succeeded-runtime-verified`.
- 1,243 wikilinks carry no type. The standard defines five typed relations
  (`depends_on`, `deployed_to`, `affects`, `supersedes`, `resolved_by`);
  4 notes use them. 38 links are unresolved, 45 notes have no backlink,
  2 notes have no frontmatter.
- Entity notes accumulate dated event logs. The four largest notes (123,629,
  92,208, 70,338, and 57,684 characters) are project or topic notes that keep
  appending release and site records.
- The preference "report in Chinese" exists in three places: the global
  `AGENTS.md`, a Desktop learned-memory entry, and
  `02 Areas/领域 - 个人开发与协作偏好.md`.

### Constraints

- Desktop learned memory is host-owned SQLite with provenance rules and
  tombstones (D668). On this device: 21 active entries, 35 suggestions, and
  201 tombstones (2026-10-24). The Plugin SDK has no memory surface, and D668
  §8 lists one as out of scope for v1.
- A plugin `main.js` runs in its own Electron `utilityProcess` with raw Node
  built-ins. The brokered `pi.*` gate does not constrain direct Node access
  (Desktop spec `05-security/01-security.md` §6). The MCP server already reads
  the vault this way. A plugin view is a sandboxed, context-isolated page that
  reaches its plugin through `window.pluginBridge.invoke(channel, payload)`,
  forwarded to `onPanelInvoke` with a 30-second timeout.
- Desktop opens only `http:`, `https:`, and `mailto:` URLs externally
  (`safe-open-external.ts`, ADR 0168), so `obsidian://` links are refused.
- A plugin installs as the directory it ships. The host never runs
  `npm install`. Third-party code must be vendored and built by a committed
  script (see `minih.terminal/scripts/build.mjs`).
- The manifest promises that nothing leaves the machine.
- Adding MCP tools adds tool declarations to every session that loads the
  plugin.

## Decision

### 1. Principles

1. Markdown notes stay the only source of truth. Every index (parse cache,
   BM25, vectors, graph) is derived, rebuildable, and lives outside the vault
   under `~/.personal-knowledge/index/<sha1(vault realpath)>/`.
2. No new MCP tools. The six tools gain optional parameters and additive
   output fields. Health checks run as a script and inside the view.
3. Reads are tolerant and writes are strict. Legacy vocabulary is always
   readable through alias tables. Validation applies to what a write
   introduces.
4. Nothing leaves the machine by default. The only default network peer is a
   loopback embedding server. Note text goes to any other endpoint only after
   the user turns on the remote switch of §6.1.
5. Every degradation is reported in the tool result with its reason. No
   silent fallback.

### 2. Shared vault index

A new module `lib/vault-index.mjs` serves the MCP server and `main.js`. Each
process keeps its own in-memory instance.

- **Scan.** Walk the vault with the existing ignore rules. `stat` every file
  and re-read only files whose `mtimeMs` or `size` changed. Keep per file:
  SHA-256, parsed frontmatter, outgoing links, heading outline, chunks, and
  BM25 tokens. Re-scan at most once per second per process.
- **Frontmatter.** Parse with the `yaml` package (ISC), vendored as one
  bundled ESM file in `lib/vendor/yaml.mjs`. Keep the parsed `Document` for
  round-trip edits (§8). A note whose frontmatter fails to parse keeps
  `metadata: {}` plus a `FRONTMATTER_INVALID` issue. It is never rejected on
  read.
- **Links.** Resolve `[[target]]`, `[[target#heading]]`, `[[target|alias]]`,
  and frontmatter wikilinks the way Obsidian does: an exact vault-relative
  path first, then a unique basename, then the shortest path among duplicate
  basenames. Unresolved targets become ghosts. `knowledge_links` and the graph
  use this one resolver.
- **Chunks.** Split by H1–H3 headings. A section above 2,000 characters is
  split again at paragraph boundaries into pieces of at most 2,000
  characters. A chunk records its path, heading path, character offsets, and
  text SHA-256. It never stores text in an index file.

`knowledge-core.mjs` stays the service facade and moves its parsing, link,
and scan code into `lib/`. New modules stay under about 500 lines.

### 3. Lightweight ontology

The ontology is plain data. Its default ships as
`config/ontology.default.yaml`. A vault may override it with a YAML code block
in the note named by the mapping key `ontologyNote`, which defaults to
`08 Standards/知识本体.md` when that note exists. The vault note is the
authority for this user, so the person can read and edit it in Obsidian.

Vocabulary is borrowed from mature ontologies without adopting their storage
or reasoning: SKOS (`prefLabel` → `title`, `altLabel` → `aliases`, `related`,
`broader`), PROV-O (`wasDerivedFrom` → `source`), Dublin Core (`replaces` →
`supersedes`), and Schema.org (`softwareRequirements` → `depends_on`).

**Classes.** `type` holds one class name.

| Family | Class | Meaning |
|---|---|---|
| entity | `project` | A product or repository the user owns or works on |
| entity | `topic` | One facet of a project: architecture, data model, deployment model, feature area |
| entity | `environment` | A server, cluster, network, or site where software runs |
| entity | `organization` | A customer, employer, or vendor |
| entity | `technology` | A tool, library, protocol, or service product |
| entity | `reference` | Reusable knowledge that no single project owns |
| entity | `convention` | A rule or standard the user follows |
| entity | `procedure` | A runbook or repeatable how-to |
| event | `decision` | An accepted, proposed, or superseded choice |
| event | `release` | A build, release, or deployment that happened |
| event | `incident` | A failure, its diagnosis, and its resolution |
| event | `record` | Any other dated event: an audit, a migration, or a meeting |
| navigation | `moc`, `index`, `daily`, `weekly`, `inbox` | Maps and journals; exempt from relation rules |

**Type aliases.** Legacy values are read as classes. The migration rewrites
them (§5).

| Legacy `type` | Class |
|---|---|
| `architecture`, `note`, `feature`, `project-note`, `source-audit`, `operations` | `topic` |
| `runbook`, `incident-runbook`, `troubleshooting` | `procedure` |
| `release-record`, `agent-release-record`, `deployment` | `release` |
| `architecture-decision` | `decision` |
| `feature-record` | `record` |
| `inbox-index` | `index` |
| `weekly-review`, `weekly-index` | `weekly` |
| `domain`, `area` | `convention` (the plan flags each note for review) |

**Predicates.** A predicate is a frontmatter key whose value is a wikilink or
a list of wikilinks.

| Predicate | Domain → range | Cardinality |
|---|---|---|
| `project` | topic, procedure, every event → project | one |
| `depends_on` | project, topic → project, topic, technology, environment | many |
| `deployed_to` | project, topic, release → environment | many |
| `uses` | project, topic → technology | many |
| `for` | project, environment → organization | many |
| `affects` | every event → every entity | many |
| `resolved_by` | incident → release, decision | many |
| `supersedes` | decision, convention → the same class | many |
| `related` | any → any | many |

`project` keeps its current key because 171 notes already use it. `repo`
(string or list of absolute paths) and `source` (path, URL, or session id)
are plain attributes, not predicates.

**Lifecycle.** `status` describes only where the note is in its lifecycle.
Details move to a new attribute, `outcome`, so no information is lost.

| Classes | `status` values | Default `stability` |
|---|---|---|
| `project` | `active`, `paused`, `done`, `archived` | `mixed` |
| other entity classes | `active`, `archived` | `stable`, `mixed`, or `volatile` |
| `decision` | `proposed`, `accepted`, `superseded`, `rejected` | `historical` |
| `release` | `planned`, `succeeded`, `failed`, `rolled-back` | `historical` |
| `incident` | `open`, `mitigated`, `resolved` | `historical` |
| `record` | `open`, `done` | `historical` |

`stability` stays `stable | mixed | volatile | historical`, and
`review_interval` keeps its current values.

**Validation.** `lib/ontology.mjs` checks a note and returns issues with
stable codes: `UNKNOWN_TYPE`, `LEGACY_TYPE`, `UNKNOWN_STATUS`,
`UNKNOWN_STABILITY`, `UNKNOWN_PREDICATE_TARGET` (broken link),
`DOMAIN_VIOLATION`, `RANGE_VIOLATION`, `CARDINALITY_VIOLATION`,
`FRONTMATTER_INVALID`, `OVERSIZE` (more than 24,000 characters), `ORPHAN`, and
`STALE`. A note can accept a known exception with `lint_ignore: [OVERSIZE]`.
`scripts/lint-vault.mjs` prints every issue in the vault, and the view's health
mode shows the same issues. `knowledge_write` validates the resulting note:

- `enforcement: warn` (initial value in the ontology file): dry-run and real
  writes return `warnings[]` and succeed.
- `enforcement: enforce` (the user flips it after the migration): a write
  fails with `ONTOLOGY_VIOLATION` only when it adds an issue that the stored
  note did not already have. Editing an unmigrated note is never blocked by
  its existing problems.

### 4. Storage rules

These rules go into the vault standard (`08 Standards/知识库规范.md`) and the
`obsidian-knowledge` skill.

1. An entity note states what is true now and may be edited in place.
2. An event note records one dated event. After the event closes it is only
   appended to, and it links to its entities through `project` and
   `affects`.
3. An entity note above 24,000 characters is a defect. Its dated logs move to
   event notes, and the entity keeps a summary plus links.
4. Typed relations go in frontmatter. Body wikilinks remain weak links.
5. Each fact has one authority (§9). Other places link to it.

### 5. Migration of existing notes

The user chose a reviewed, batched migration.

1. `scripts/ontology-migrate.mjs --plan` reads the vault and writes
   `~/.personal-knowledge/migrations/<stamp>/plan.json` and `plan.md`. It never
   writes to the vault. For each note the plan lists the proposed `type`,
   `status`, `outcome`, and `stability` changes, `project` backfills implied by
   the folder (for example a note under `01 Projects/Hungraim AIT/` with no
   `project`), and the rule that produced each change. Notes that need a human
   decision are marked `review`.
2. The plan also lists:
   - every Base file whose filters reference a value that changes, with the
     proposed filter edit;
   - proposed typed relations for the 22 project notes (`depends_on`,
     `deployed_to`, `for`, `uses`), drafted by reading those notes;
   - a split proposal for each `OVERSIZE` note: which sections stay in the
     entity and which become event notes;
   - the preference de-duplication of §9.
3. The user approves the plan, or edits and then approves it. Nothing is
   applied before that.
4. `scripts/ontology-migrate.mjs --apply <plan> --batch <n>` applies at most
   30 notes per batch. Each note goes through `knowledge_write` with
   `operation: "patchFrontmatter"`, so the body stays byte-for-byte unchanged
   and every change has a backup. A batch writes `applied.json` with the
   before and after SHA of each note, and the batch stops at the first stale
   hash.
5. After a batch, re-run the lint and the static Base-filter check. Note
   splits and preference edits are separate batches with full-note diffs that
   the user approves one by one.
6. After the last batch the user sets `enforcement: enforce`.

### 6. Hybrid retrieval

The user chose to add embeddings now. The default is a local Ollama with
`bge-m3`. Behind an explicit switch, any OpenAI-compatible endpoint can be
used instead, for example Minih-Router (§6.1).

**Lexical channel.** BM25F over chunks with `k1 = 1.2` and `b = 0.75`. Field
weights: title 3, aliases 3, path 2, heading path 1.5, body 1. Tokens are
lowercased ASCII words (split on non-alphanumeric characters, with the
hyphenated whole also kept) and CJK character bigrams. A CJK run of one
character becomes a unigram. This fixes both reordering (`资产服务器`) and
partial phrases.

**Vector channel.**

- Default provider `ollama`: `POST {baseUrl}/api/embed` with
  `{ model, input: string[] }`. Defaults: `baseUrl = http://127.0.0.1:11434`,
  `model = bge-m3` (1,024 dimensions), 32 chunks per request, 30-second
  request timeout, 500 ms connect timeout. Provider `openai-compatible` is
  defined in §6.1.
- Settings live in `~/.personal-knowledge/embedding.json` (§6.1). Without the
  remote switch, a `baseUrl` whose host is not `127.0.0.1`, `localhost`, or
  `::1` is rejected with `EMBEDDING_NOT_LOOPBACK`.
- Chunks are embedded from redacted text. Chunks under an excluded folder
  (§6.1) are never embedded. The vector dimension is taken from the first
  response. Vectors are L2-normalized and stored as `vectors.f32`
  (concatenated Float32), with `chunks.jsonl` (path, heading path, offsets,
  chunk SHA) and `meta.json` (format version and the provider identity of
  §6.1). A change to either invalidates the index. About 3,000 chunks of
  1,024 dimensions need about 12 MB. Search is a brute-force cosine scan
  (estimate, to be measured).
- Only the MCP server writes the vector index. The Desktop server and a
  Codex server may run at the same time, so a writer takes `.lock` in the
  index directory with `O_EXCL`; a lock older than 10 minutes is stale. A
  process that cannot take the lock uses the index as it is. Files are
  replaced by temp-file rename, and `meta.json` is written last. A loader
  that finds `vectors.f32` of the wrong size discards the index and rebuilds.
- When the server starts, it refreshes changed chunks in the background in
  sequence. A tool call spends at most 3 seconds refreshing before it
  answers. The query itself is embedded with a timeout of 3 seconds for a
  loopback endpoint and 8 seconds otherwise; on timeout the call answers with
  `EMBED_FAILED`. `scripts/build-index.mjs` rebuilds the whole index from the
  command line.

**Fusion and ranking.**

1. Take the top 50 from each channel and fuse them with reciprocal rank
   fusion: `Σ 1 / (60 + rank)`.
2. Graph expansion: for the top 10 notes, add at most 5 typed neighbors
   (`project`, `depends_on`, `resolved_by`) at 0.3 × the parent score if they
   are not already in the list.
3. Rerank: archived notes (`status: archived` or under `04 Archive/`) × 0.5;
   notes past their review window × 0.85.
4. Group by note. Each result keeps its best chunk as `section` and
   `snippet`.

**Degradation contract.** Every search and context result carries
`retrieval: { lexical: "ready", vector: <state>, reason?, pendingChunks? }`.

| Vector state | Trigger | Result |
|---|---|---|
| `ready` | Index current, server reachable | Lexical and vector fused |
| `partial` | Some changed chunks not yet embedded | Fused; unembedded chunks are lexical only; `pendingChunks` set |
| `unavailable` | A reason code from the list below | Lexical and graph only; the reason is printed in the text output |
| `disabled` | `enabled: false` in `embedding.json` | Lexical and graph only |

Reason codes for `unavailable`:

| Code | Trigger |
|---|---|
| `OLLAMA_UNREACHABLE`, `EMBEDDING_UNREACHABLE` | No answer from the `ollama` or the `openai-compatible` endpoint |
| `MODEL_MISSING` | The endpoint does not serve the model (HTTP 404 or a model error) |
| `EMBEDDING_AUTH_FAILED` | HTTP 401 or 403 |
| `EMBEDDING_RATE_LIMITED` | HTTP 429 |
| `EMBEDDING_KEY_MISSING` | `apiKeyEnv` is set but no value was found (§6.1) |
| `EMBEDDING_NOT_LOOPBACK`, `EMBEDDING_INSECURE_URL`, `EMBEDDING_CONFIG_INVALID` | The settings file breaks a rule of §6.1; the message names the field |
| `EMBED_FAILED` | Any other failure, including a timeout or an unexpected response shape |

An unreachable or rate-limited endpoint is cached for 60 seconds, so a
missing Ollama costs one 500 ms probe per minute at most. Error messages carry
the status code and the provider's short error text. They never carry the API
key or note text. Ollama is not installed on this machine today. Installing
it, or configuring a remote endpoint, is a user step (§12).

#### 6.1 Embedding providers and the remote switch

The user asked for a switch and for other providers besides Ollama.

**Settings file.** `~/.personal-knowledge/embedding.json` is the only home
for embedding settings. It applies to Desktop and Codex alike, because both
start the same MCP server. The repo-map `embedding` block of the unreleased
0.2.0 code is removed. When the file is missing, every field takes its
default, so the behavior is exactly the default `ollama` setup.

```json
{
  "enabled": true,
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "bge-m3",
  "allowRemote": false,
  "apiKeyEnv": "",
  "exclude": []
}
```

| Field | Meaning |
|---|---|
| `enabled` | Turns the vector channel on or off |
| `provider` | `ollama` (native API) or `openai-compatible` (any `/v1/embeddings` server: Minih-Router, OpenAI, SiliconFlow, LM Studio, or Ollama's own compatible API) |
| `baseUrl` | For `openai-compatible`, the API root including `/v1`, for example `https://<router-host>/v1` |
| `model` | The embedding model the endpoint serves |
| `allowRemote` | The remote switch. `false` keeps every request on the loopback interface |
| `apiKeyEnv` | The name of the environment variable that holds the API key; empty means no key |
| `exclude` | Vault folder prefixes whose notes are never sent to the embedder; they stay searchable through the lexical channel |

**Rules.** The MCP server checks them when it loads the file, and the view
checks them before it saves the file.

- A non-loopback `baseUrl` needs `allowRemote: true`, otherwise
  `EMBEDDING_NOT_LOOPBACK`.
- A non-loopback `baseUrl` must use `https:`, otherwise
  `EMBEDDING_INSECURE_URL`. The key never travels over plain HTTP.
- `apiKeyEnv` is empty or matches `^[A-Z_][A-Z0-9_]{0,63}$`.
- `exclude` entries are vault-relative folders without `..`.
- Any other problem fails with `EMBEDDING_CONFIG_INVALID`, and the message
  names the field.

**`openai-compatible` protocol.**

- The plugin sends `POST {baseUrl}/embeddings` with
  `{ model, input: string[] }`, 32 inputs per request. When there is a key, it
  adds the header `Authorization: Bearer <key>`.
- Vectors come from `data[].embedding`, ordered by `data[].index`.
- This provider has no separate probe request. The first real request also
  serves as the probe, so no quota is spent on probing.

**API key.** The key is never stored in `embedding.json`. Desktop plugin
settings refuse secrets until secure storage exists, and Desktop starts plugin
MCP servers with a minimal environment. The key is resolved in this order:

1. `process.env[apiKeyEnv]`.
2. On macOS and Linux, if step 1 finds nothing: one child process runs the
   user's shell (`$SHELL` if it is zsh or bash, otherwise `/bin/zsh`) with
   `-c 'source <rc> >/dev/null 2>&1; printf %s "$NAME"'`. Here `<rc>` is
   `~/.zshrc` or `~/.bashrc`, and `NAME` is the validated `apiKeyEnv`. The
   child gets no stdin, its stderr is discarded, and it has a 5-second
   timeout. This follows the user's convention of keeping local credentials
   in `~/.zshrc`.
3. Otherwise the result is `EMBEDDING_KEY_MISSING`.

The resolved key stays in process memory. It is resolved again after a
settings change or an `EMBEDDING_AUTH_FAILED` result. It is never written to a
file, a log, a tool result, the view payload, or an error message.

**Reload.** The MCP server and `main.js` check the modification time of
`embedding.json` at most once per second. After a change they rebuild the
client, so no restart is needed. The provider identity is
`provider + baseUrl + model + dimensions`. When it changes, the vector index
is invalid and is rebuilt.

**Cost and consent.** With a remote endpoint, the first build sends every
non-excluded chunk once. After that, only changed chunks are sent, plus one
short request per query. The provider bills these requests, and Minih-Router
bills them to the user's account. Before the user saves `allowRemote: true`,
the view shows the number of chunks and characters that will be sent. Redaction
removes credentials only. Hosts, IP addresses, server inventories, and
customer names are still sent unless their folders are excluded.

**Minih-Router** needs no special code. It is an `openai-compatible`
endpoint: `baseUrl` is `https://<router-host>/v1`, `model` is an embedding
model that the router serves, and `apiKeyEnv` names the AccessKey variable in
`~/.zshrc`. The router code has a `/v1/embeddings` route
(`internal/gateway/router.go`). This ADR has not verified whether the user's
deployment serves an embedding model.

### 7. Tool contract changes

All changes are additive or behind a new parameter value.

| Tool | Change | Compatibility |
|---|---|---|
| `knowledge_search` | `mode` gains `ranked` and it becomes the default; `all` and `any` keep their literal-substring behavior exactly. Results add `section`, `matchedBy` (`lexical`, `vector`, `graph`), and `retrieval` | Callers that pass `mode` explicitly see no change. Callers that omit it get ranked results |
| `knowledge_read` | Optional `section` (heading text or `H2 > H3` path) and `outline: true`. The result adds `redacted`, `outline`, and `sectionSha256`. `sha256` stays the whole-file hash | Additive |
| `knowledge_write` | Optional `operation`: `replace` (default, current behavior), `replaceSection`, `appendToSection`, `patchFrontmatter`; plus `section` and `frontmatter` parameters. The result adds `warnings` | Default unchanged |
| `knowledge_context` | Routes from note metadata as well as the mapping file (below). Notes may be returned as sections. The result adds `retrieval` | Input unchanged; output additive |
| `knowledge_stale`, `knowledge_links` | `knowledge_links` uses the shared resolver and reports `ghosts` | Additive |

`knowledge_context` routing order:

1. Mapping-file `projects` entries.
2. Notes of class `project` whose `repo` is a path prefix of the real path of
   `cwd`. Worktrees under `<repo>/.worktree/` match their repository.
3. `aliases` of those project notes matched against `topic`.

For each matched project it loads the head of the project note. If `topic` is
not empty, it then adds the best-ranked sections among notes whose `project`
is that project, within the existing budget. Default notes keep their head
summary. The tool descriptions in `server.mjs` stay short; the details go into
the skill.

### 8. Write safety additions

- **Section operations.** A section runs from its heading line to the line
  before the next heading of the same or a higher level. `replaceSection`
  takes `content` that includes the heading line. `appendToSection` appends
  `content` at the end of the section. A missing or duplicate heading fails
  with `SECTION_NOT_FOUND` or `SECTION_AMBIGUOUS` and lists the candidates.
- **Frontmatter patch.** `frontmatter` maps keys to new values; `null`
  removes a key. The edit goes through the parsed YAML `Document`, so other
  keys, their order, and comments are preserved. The body is not touched.
- **Unchanged guards.** Every operation still requires `expectedSha256` of
  the whole file, is a dry-run by default, runs the credential detector and
  the ontology check on the complete resulting note, writes atomically, and
  creates a backup.
- **Redaction guard.** A write fails with `REDACTED_PLACEHOLDER` when the
  resulting note contains a `[REDACTED` marker that the stored note does not
  contain.

### 9. Division of work with Desktop memory

Learned memory and the vault keep separate stores. Each kind of knowledge has
one authority.

| Knowledge | Authority | How it reaches a session |
|---|---|---|
| Hard rules for every task | `AGENTS.md` | System prompt |
| Preferences and corrective feedback | Desktop learned memory | Session-start index (40 lines / 6 KiB) and `MemorySearch` |
| Projects, topics, environments, decisions, events, procedures | Obsidian vault | `knowledge_context` on demand |
| Loose facts and references not yet part of a note | Learned memory, promoted to the vault when mature | Index and `MemorySearch` |
| Conversation evidence | Desktop transcripts | `SessionHistorySearch` |

Knowledge moves in one direction: a mature `fact` or `reference` memory is
promoted into a vault note. Vault content is never copied into memory.

- **Skill.** `obsidian-knowledge` gets the table above. Preferences go to
  `MemoryRemember`, not to the vault. The routing reference loses the
  "personal preferences" destination.
- **De-duplication.** The plan of §5 maps every bullet of
  `02 Areas/领域 - 个人开发与协作偏好.md` to one of: covered by `AGENTS.md`,
  covered by an active memory, to be remembered (the user saves it through
  `MemoryRemember` in a session, so provenance points at the user's own
  message), or history. After approval the note keeps only dated history and
  links. Memory entries that only restate `AGENTS.md` are listed for the user
  to archive in the Desktop memory manager, because the plugin cannot write
  memory.
- **Promotion in the view (phase P4).** A memory satellite offers "Promote to
  note". The view drafts a note under `00 Inbox/` with class `reference` or
  `record`, `source: memory:<id>`, and the memory's dates. It shows the
  dry-run result, and it writes only after the user confirms. Archiving the
  original memory remains the user's action in Desktop.
- **Reading memory** needs the Desktop permission `memory.read` (ADR
  `plugin-learned-memory-read`). `main.js` calls `pi.memory.list` once with
  `scope: "user"`, then once with `scope: "project"` for each `repo` path of a
  project note, paging until `nextOffset` is `null`. Entries attach to that
  project node. `readEnabled: false` sets `memory.status` to `disabled`. A
  missing API sets it to `unsupported`, and a missing grant sets it to
  `permission-missing`. The plugin never reads `pi.sqlite` directly, even
  though its raw-Node process could.

### 10. Knowledge Universe view

**Surface.** `contributes.views` gets one entry: `id: "universe"`, title
`{ en: "Knowledge Universe", zh-CN: "知识宇宙" }`, `icon: "sparkles"`,
`placement: "sidebar"`, `entry: "view/index.html"`. New permissions:
`ui.view`, and `clipboard.write` for "Copy Obsidian link". `main.js` stops
being declarative and implements `onPanelInvoke`. It loads the shared index
with a dynamic `import()` and reads the vault with raw Node, the same way the
MCP server does. No `fs.read` grant is needed, and the safety notes say so.

**Channels.** Every payload is JSON and every call stays under the 30-second
timeout.

| Channel | Input | Output |
|---|---|---|
| `kg.graph` | `{ includeMemory?: boolean }` | `GraphPayload` |
| `kg.note` | `{ path }` | Title, metadata, outline, redacted body preview (at most 8,000 characters), `sha256`, issues |
| `kg.copyLink` | `{ path }` | Writes `obsidian://open?vault=<name>&file=<path>` to the clipboard |
| `kg.promote.preview` | `{ memoryId }` | Draft path and content plus the dry-run summary |
| `kg.promote.apply` | `{ memoryId, path, content }` | The write summary; refused in read-only mode |
| `kg.settings.get` | `{}` | The embedding settings of §6.1, `apiKeyStatus` (`found`, `missing`, or `not-required`, never the key), index statistics read from disk (identity, chunk count, built at), and the send estimate (chunks and characters after `exclude`) |
| `kg.settings.set` | `{ embedding }` | Validates against §6.1 and writes `embedding.json` atomically with mode 0600; returns the saved settings, or the failing rule and field |
| `kg.settings.test` | `{ embedding }` | Embeds one fixed short string with the given settings and returns `{ ok, dims, latencyMs }` or a reason code of §6 |

```ts
type GraphPayload = {
  generatedAt: string;
  vaultName: string;
  nodes: Array<{
    id: string;                 // vault-relative path, or "memory:<id>"
    title: string;
    cls: string;                // ontology class, or "memory"
    family: "entity" | "event" | "navigation" | "memory";
    project?: string;           // id of the owning project node
    status?: string;
    stability?: string;
    created?: string;
    updated?: string;
    verified?: string;
    stale: boolean;
    archived: boolean;
    degree: number;
    chars: number;
    issues: string[];           // ontology issue codes
    memoryKind?: "preference" | "feedback" | "fact" | "reference";
  }>;
  links: Array<{ source: string; target: string; predicate: string }>; // "wikilink" for weak links
  ghosts: Array<{ id: string; referencedBy: string[] }>;
  memory: { status: "ok" | "disabled" | "unsupported" | "permission-missing"; count: number };
};
```

**Rendering, visual encoding, and interaction (amended 2026-10-24).** The
first version rendered a free force-directed 3D graph with glow, a dense
control surface, and 974 lines, most of them invisible. The user reviewed it
and chose a redesign: a 3D star map on a deep-blue night sky. It keeps a star
chart's structure (labeled galaxies, readable lines) and adds depth, galaxy
nebulae, bloom, and slow motion. It uses a fixed, deterministic layout, one
color family per galaxy, and event moons folded into a ring until the user
enters a galaxy. The flat star chart is a reading mode and the fallback when
WebGL is unavailable. The authoritative specification is
`docs/design/knowledge-universe-v2.md`, with mockups of both modes in
`docs/design/`. The layout is computed by a pure module, `lib/layout.mjs`,
and shipped in the graph payload, so both modes and the tests use the same
positions. Rendering code (`3d-force-graph` for the 3D view, with `three`,
`UnrealBloomPass`, `OutputPass`, and `CSS2DRenderer` from one copy of
`three`; `force-graph` for the chart) stays bundled by `scripts/build.mjs`
with esbuild from pinned dev dependencies into `view/vendor/`, with licenses
in `THIRD_PARTY_NOTICES.md`. The page keeps the CSP `default-src 'self';
script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
blob:; worker-src 'self' blob:; connect-src 'none'` and every string in `en`
and `zh-CN`.

"Open in Obsidian" is not offered: ADR 0168 refuses `obsidian://`, and
changing that boundary is outside this ADR.

**Retrieval settings panel.** A gear button opens the panel. It shows:

- the vector switch and the provider (local Ollama, or OpenAI-compatible
  endpoint);
- the base URL, the model, the key variable name, and the excluded folders;
- the remote switch, with this warning in both locales: "Redacted note
  sections will be sent to this address. Credentials are removed; hosts, IP
  addresses, and names are not.";
- the send estimate, the key status, and the index statistics.

"Test connection" calls `kg.settings.test`. "Save" calls `kg.settings.set`.
Saving `allowRemote: true` needs a second click on a confirm button that
repeats the estimate. The panel is the only UI for these settings. Editing
`embedding.json` by hand has the same effect.

### 11. Versions and release split

| Version | Content | Engine |
|---|---|---|
| 0.2.0 | P0–P3: index, YAML, sections, ontology and lint, migration tooling, hybrid retrieval, the view without memory | `>=0.25.0` (unchanged) |
| 0.3.0 | P4: `memory.read`, memory satellites, promotion | The first Desktop release that ships `memory.read` |

A Desktop build that does not know a permission refuses the manifest, so
0.3.0 must not be published before that Desktop release. `.codex-plugin/
plugin.json` keeps the same version. Packing, catalog regeneration, and
publication are a separate release step.

### 12. Phases and development checks

| Phase | Work | Development checks |
|---|---|---|
| P0 Foundation | §2, §7 read and write parts, §8, metadata routing | `node --test`: block-list properties, link resolver cases, section replace and append under CAS, frontmatter patch preserves body bytes, redaction guard, routing from `repo` and worktree paths; `npm run probe` |
| P1 Ontology | §3, §4 standard text, §5 tooling, lint script | Ontology unit tests with a fixture vault; `--plan` on a fixture and, read-only, on the real vault |
| P2 Retrieval | §6, §6.1 | Unit tests with fake loopback embed servers for both providers: `ready`, `partial`, `unavailable`, identity change invalidation, lock; every rule of §6.1; status mapping 401/403, 404, 429; key from `process.env` and from a temporary `HOME` whose `.zshrc` exports a test variable; the key never appears in errors, tool output, logs, or view payloads; `exclude`; reload after an `embedding.json` change; `kg.settings.*` validation and file mode 0600; `资产服务器` regression. No call to a real paid endpoint without the user's authorization |
| P3 View | §10 without memory | `scripts/build.mjs`; graph builder unit tests; BrowserPreview of the view with a stub bridge and a fixture payload: hover, drawer, filters, health mode, 2D switch; frame rate with the real 273-node payload |
| P4 Memory | §9; Desktop ADR `plugin-learned-memory-read` | Desktop side as that ADR lists; plugin side: payload mapping of memory scopes to project nodes, `permission-missing`, `disabled`, `unsupported`, promotion dry-run and read-only refusal |

Migration batches run after the user approves the plan, independent of the
phases.

User steps:

- Pick one vector backend, or leave vectors off:
  - local: install Ollama (`brew install ollama`), start it, and run
    `ollama pull bge-m3` (about 1.2 GB);
  - remote: in the view's retrieval settings choose `openai-compatible`, enter
    the base URL and model, name the key variable kept in `~/.zshrc`, and turn
    on the remote switch. For Minih-Router, first confirm that the deployment
    serves an embedding model.
- Review and approve the migration plan, then each split and preference batch.
- Archive the memory entries the plan lists.
- Verify the view inside the running Desktop app.

## Consequences

- Agents get ranked, reorder-tolerant CJK retrieval, semantic matches when an
  embedding backend is configured, and section-level reads that fit the
  budget.
- Large notes become editable without full-note replacement, and the
  redaction guard closes a data-loss path.
- The vault gains an explicit vocabulary. Unmigrated notes keep working,
  because reads accept aliases and enforcement blocks only new issues.
- One parse feeds the MCP tools, the lint, and the view.
- New costs: vendored `yaml` and `3d-force-graph` with three.js (about 1.5 MB
  in the package, estimated), about 12 MB of vectors outside the vault, and
  either an optional Ollama daemon with a 1.2 GB model or provider charges for
  remote embedding requests.
- `knowledge_search` without `mode` changes from literal to ranked results;
  this is called out in the changelog.
- The plugin keeps raw-Node access to the vault in two processes: the MCP
  server, and now `main.js` for the view. The safety notes state this.
- With the remote switch on, redacted note text leaves the machine. Desktop's
  `net.domains` allowlist governs host-owned egress only, and it does not see
  requests from the MCP server or `main.js`. The settings file and the
  confirmation in the panel are the only controls. The manifest safety notes
  change from "nothing leaves the machine" to "nothing leaves the machine
  unless you turn on remote embeddings", and they describe what is sent and
  how the key is read.

## Alternatives

- **Full OWL/RDF with a triple store and a reasoner.** Rejected: a 273-note
  personal vault gains nothing from a reasoner when the reader is a language
  model, and a triple store would be a second source of truth beside the
  Markdown. Obsidian Bases already query frontmatter.
- **Constrain only new writes and never migrate.** Rejected by the user: the
  drift would stay forever.
- **Evaluate before adding vectors.** Proposed earlier; the user chose to add
  local embeddings now.
- **In-process ONNX (transformers.js with bge-small-zh).** Kept as a fallback
  design only: it adds onnxruntime and model files to the package and weaker
  CJK quality than bge-m3.
- **Cloud embeddings as the default.** Rejected: the default stays local.
  Since the amendment of 2026-10-24, remote endpoints are allowed behind the
  explicit switch of §6.1.
- **The API key in `embedding.json` or in Desktop plugin settings.**
  Rejected: the file is plain text, and Desktop plugin settings refuse secrets
  until secure storage exists.
- **The switch in Desktop plugin settings.** Rejected: Desktop passes
  settings to the MCP server only at spawn, so a change would need a reload.
  Codex shares the MCP server but not Desktop settings. String settings with
  empty defaults also made the MCP server skip loading before 0.1.2.
- **A vector database (Chroma, LanceDB, Qdrant).** Rejected: a service for
  about 3,000 vectors.
- **A 2D-only renderer (Sigma.js, Cosmograph).** Rejected: the user wants the
  universe look; 2D remains a switch.
- **An Obsidian community plugin for the view.** Rejected: the view must sit
  beside Desktop memory, and a second plugin platform doubles the maintenance.
- **Reading `pi.sqlite` directly from the plugin.** Rejected: it would bypass
  host ownership of SQLite, the read switch, and future schema changes.
