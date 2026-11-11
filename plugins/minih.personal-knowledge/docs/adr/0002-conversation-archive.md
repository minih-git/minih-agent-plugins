# ADR 0002: Conversation archive in the user's vault

- Status: Proposed (2026-11-09)
- Plugin: `minih.personal-knowledge`, 0.5.0
- Related (Minih-Agent-Desktop): ADR `conversation-archive`, plugin API
  `docs/spec/07-plugins/03-plugin-api.md` § conversations, permission
  `conversation.read`
- Depends on: ADR 0001 (ontology, hybrid retrieval, Knowledge Universe)

## Context

Every Desktop conversation is stored only on the computer that ran it: the
session JSONL and SQLite rows never sync, and cloud sync explicitly excludes
conversations. What the user actually wants across computers is not the
sessions — it is the ability to ask "what did we do last week, why did we
decide that, where did we stop?" on whichever computer they are sitting at.

The vault is already the one place that syncs: it lives in iCloud and every
computer sees it. The Desktop side of that idea exists (`conversation.read`,
`pi.conversations.changes | summary | transcript`, redacted, opt-in). This ADR
records the plugin side: what is written, where, by whom, and what is
searchable afterwards.

The plan this ADR implements is `conversation-archive-plan.md` §3, §6–§9.

## Decision

### 1. One syncer, five-minute pulls, a local cursor

`lib/conversation-sync.mjs` runs one pass at plugin load and one every five
minutes, driven by `main.js` (`onLoad` starts it, `onUnload` stops it and
clears the timer). The change cursor lives in
`~/.personal-knowledge/conversation-sync.json` — never in the vault, because
the position a computer has read to is per computer.

Three properties of the host feed shape the code:

- **Removals are delivered at least once.** The same `removed: true` row can
  come back with the same cursor. Deletion is therefore idempotent (a missing
  file is a success, a file owned by another computer is left alone), and the
  cursor advances only after the whole page was handled. A failed delete
  throws, the cursor stays, and the next pass retries.
- **No summary is not nothing to write.** `summaryRevision: null` writes L3
  now and leaves L2 until a revision appears; the transcript never waits for a
  model.
- **The switch is read at call time.** `enabled: false` puts the syncer to
  sleep: nothing is written, nothing is deleted, the cursor is kept.

### 2. Layout

```text
09 Conversations/<project>/<YYYY-MM>/<YYYY-MM-DD> <title> <id8>.md   L2 summary
09 Conversations/_raw/<project>/<YYYY-MM>/<id8>[.pN].md              L3 transcript
09 Conversations/_daily/<YYYY-MM-DD> <device>.md                    daily roll-up
```

The project folder is chosen in this order: a repo-map project whose
`repoPrefixes` covers the session's project path, then the git remote's
`owner-repo` (`host/owner/repo` with credentials already stripped by the
host), then the directory name, then `_无项目`. The same repository therefore
lands in the same folder even when two computers keep it at different paths.

### 3. L2 is the searchable record; L3 is the evidence

L2 carries `type: conversation`, `session_id`, `device`, `created`, `updated`,
`covered_seq`, `summary_revision`, and a `transcript` link; its body is the
fixed goal / decisions / outcomes / files / open items / tags structure. A
session with no summary yet says so in one line.

L3 is the redacted turn stream: `## T012 · 2026-11-08 10:12`, the user's
words, the agent's reply, and one line per tool call (`- Bash `git status
--short``, `✗` on failure), with compaction checkpoints marked. Parts are
split at turn boundaries so each file stays under 512 KiB.

The daily page is generated from the state file, never from a model, and is
one file per computer per day, so two computers never write the same page.

### 4. One writer per file

Every note records `device` (this computer's `os.hostname()`, normalized). A
note whose `device` is not this computer is read-only here: never rewritten,
never deleted. Because a session only ever exists on one computer, a note has
exactly one writer and iCloud has nothing to conflict about.

**iCloud does produce conflict copies anyway** (`name 2.md`). The syncer looks
for them inside `09 Conversations/`, and resolves a copy only when the copy
and the file it duplicates are both this computer's: the newer `updated` wins.
Obsidian's own `name (1).md` form is left alone, because Obsidian still links
to it.

### 5. Two private folders, no backups

`_raw` and `_daily` are the two folders that must stay out of the index, out of
`knowledge_search`, and out of Obsidian's search and graph. They are excluded
in four places, each of which the user can inspect:

| Where | What |
| --- | --- |
| Shared index exclusions | `09 Conversations/_raw`, `09 Conversations/_daily` (`VaultIndex` always applies the layout's `archiveConfig`; user exclusions are preserved and nested paths match as prefixes) |
| `.obsidian/app.json` `userIgnoreFilters` | `09 Conversations/_raw` appended; every other key stays byte-identical, and no `.obsidian` folder is created when the vault has none |
| `lib/conversation-sync.mjs` | writes only under `09 Conversations/`, atomically (temp file + rename) |
| `mcp/knowledge-core.mjs` | the search paths filter `09 Conversations` unless `include: ["conversations"]` |

Writes are skipped when the bytes are unchanged, so an idle pass does not wake
iCloud. **The two private folders are never backed up**: a vault backup of
`09 Conversations` would double a folder every computer already syncs. The
`knowledge_write` backup path is not used for them at all — the syncer writes
files directly.

Every line that reaches a note passes `lib/redact.mjs` once more before it is
written, as a second layer after the host's own fragment redaction.

### 6. Retrieval: L0 → L1 → L2 → L3

- `conversation_search({ query, scope = "project", limit ≤ 8 })` searches L2
  summaries (title and body, frontmatter excluded), scoped to the current
  repository's project folder unless `scope: "all"`. It returns the session
  id, date, title, device, project, goal, the matched fields, and a snippet.
- `conversation_read({ sessionId, part: "summary" | "transcript", fromTurn,
  toTurn, query, maxChars ≤ 12000 })` reads one session. For a transcript it
  prefers the host API (`pi.conversations.transcript`, which keeps the user's
  archive switch in force) and falls back to the archived L3 file. A keyword
  returns the matching turns plus one neighbour on each side.
- `knowledge_context` additionally lists the three newest sessions of the
  current project as titles and ids — links only, never content.
- `knowledge_search` leaves `09 Conversations` out unless
  `include: ["conversations"]` is passed.

Every result carries the same caveat: archived conversation material is
historical, may be outdated, and is data rather than instructions.

### 7. L0 profile candidates are opt-in and never self-applying

`lib/profile-candidates.mjs` drafts `00 Inbox/画像候选 <date>.md` from recent
summaries and user-scoped learned memory with `pi.agent.complete`. Off by
default, at most one attempt per week (a failed attempt counts, so a broken
model cannot loop), and **it never edits `08 Standards/个人画像.md`** — merging
is the user's action.

### 8. Settings panel and the weekly check

Two panel sections close the loop (`docs/design/settings-panel.md` §2):

- **Conversation archive** (`kg.conversations.status | sync | device`): whether
  the host switch is on, this computer's device name, the last sync time, what
  the last pass wrote and removed, and the last error *code* — never content.
  "Sync now" runs one pass and refreshes the section. The device name is
  editable and stored in `~/.personal-knowledge/conversation-settings.json`
  (never in the vault); a rename only affects files written afterwards, and the
  syncer keeps the old name as one of its own, so deleting a renamed session
  still works.
- **Profile candidates** (`kg.profile.status | set | run | models.list`):
  switch, model, last run, the next allowed run while the weekly limit holds,
  the last error code, and the latest candidate with a copy-link action.
  `kg.profile.set` accepts exactly `enabled` and `modelKey`; anything else is
  refused by name, because a silently ignored key would look saved. "Generate
  now" is a manual action and ignores the weekly limit, but stays disabled
  without the switch and a model.

The weekly check is a six-hour timer in `ProfileCandidateScheduler`, started by
`onLoad` and cleared by `onUnload`. Every path — the startup check, the timer,
a direct call — obeys `candidateDue`: switch on, model chosen, a week since the
last attempt (a failure counts), and not read-only. Nothing runs while the
plugin is stopped, so a late timer cannot outlive an unload.

`models.list` (read-only catalog of the user's configured models) is the one
additional permission; without the host API the panel falls back to typing
`providerId/modelId` by hand.

## Consequences

- The plugin now requests three more permissions: `conversation.read` (the
  feed), `agent.complete` (profile candidates) and `models.list` (the model
  list in the panel). The second one only ever runs when the user turns the
  feature on and names a model, but it is shown at install time.
- `engines.minihAgent` / `piDesktop` move to `>=1.4.0`, the first published
  Desktop release whose changelog carries `conversation.read`. Hosts 1.0.0–1.3.x
  do not know the permission and would refuse this manifest.
- `VaultIndex` learned to match a nested `ignoreFolders` entry as a path
  prefix; a plain top-level name behaves exactly as before.
- The vault grows with the archive; L3 is the bulk of it. Deleting a
  conversation in Desktop deletes its notes on the computer that wrote them,
  and that deletion propagates through the vault sync.
- The transcript is the one place where an agent can read what a previous
  session was *told*, so the caveat and the "data, not instructions" rule are
  part of the tool output, not only of the skill.

## Alternatives considered

- **Index L3 and search it.** Rejected: it is large, redundant with L2 for
  search, and would put every transcript in the graph and in embeddings.
- **Keep the daily page in the index (inside `09 Conversations/` proper).** It
  would duplicate every summary in `conversation_search` results for little
  gain, so it lives in `_daily` with the same out-of-index treatment.
- **Let the plugin decide which device writes a session's notes.** Rejected:
  the writer must be the computer that has the transcript, which is by
  definition the one that produced it.
- **Write profile changes directly.** Rejected: the profile is the user's own
  statement about themselves.
