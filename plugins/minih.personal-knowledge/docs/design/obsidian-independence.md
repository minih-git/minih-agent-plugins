# Obsidian independence

- Status: Accepted (2026-11-10)
- Target version: 0.7.0
- Scope: `plugins/minih.personal-knowledge` only. No Desktop change, no vault
  data migration.

## 1. Goal

The vault is plain Markdown with YAML frontmatter and `[[wikilinks]]`. The
plugin's indexing, retrieval, guarded write-back, Knowledge Universe, and
conversation archive already read and write it with direct Node I/O. Three
things still assume the Obsidian app is installed:

1. Every "open the note" affordance is an `obsidian://` URI copied to the
   clipboard (`main.js` `copyLink`, `view/drawer.js` `copyLink` fixture path,
   `view/settings-page.js` `buildObsidianLink` / `copyNoteLink`).
2. The drawer shows the note as raw text (`content.textContent = …`), so
   reading a note in the plugin is worse than opening it elsewhere.
3. The two dashboard tables ("活跃项目", "待复核知识") exist only as Obsidian
   Bases (`08 Standards/知识库仪表盘.base`, embedded in `Home.md`).

After this change a user without Obsidian can read any note, follow its links,
and see both dashboards inside the plugin. Obsidian stays a supported optional
viewer: nothing in the vault changes, `.base` files and `Home.md` embeds are
left untouched, and the Obsidian link stays available as a secondary action.

Out of scope:

- A host `shell.openPath` capability (would be a Desktop SDK/ADR change).
  `pi.shell.openExternal` accepts http(s)/mailto only.
- Renaming the skills. `obsidian-knowledge` and `obsidian-project-knowledge`
  keep their ids; only descriptions change (§5).
- Editing notes in the plugin UI.
- Knowledge Universe layout or relation fixes (separate task).

## 2. Read-only note preview (drawer)

Replace the raw-text preview in `view/drawer.js` with rendered Markdown.

Rendering — a new pure module `view/markdown.js` (no dependency; the vault
uses a small Markdown subset). Split it in two so Node tests need no DOM
(the plugin's tests run under plain `node --test` with no DOM library):

- `parseMarkdown(text, { resolveLink }) → tree` returns plain objects
  (`{ tag, attrs, children | text }`) and holds all logic;
- `toDom(tree, { onWikilink, onExternal })` is a thin adapter that only
  creates elements and wires clicks.

| Input | Output |
| --- | --- |
| Frontmatter block | Not rendered (the drawer already shows class/galaxy) |
| `#`–`######` headings | `h1`–`h6` (shifted down so the drawer title stays the largest) |
| Paragraphs, `**bold**`, `*italic*`, `` `code` ``, `~~strike~~` | Matching inline elements |
| Fenced code blocks | `<pre><code>` with no highlighting |
| `-`, `*`, `1.` lists, `- [ ]` / `- [x]` tasks | Nested lists, disabled checkboxes |
| `> quote`, `> [!type] Title` callouts | `blockquote`; callouts get a class per type and the title line |
| Pipe tables | `table` |
| `[text](https://…)` | Link that calls `pi.shell.openExternal` through a new `kg.openExternal` channel (http/https only) |
| `[[target]]`, `[[target|alias]]`, `[[target#heading]]` | Internal link, see below |
| `![[file.base#view]]`, `![[image]]`, other embeds | A muted chip "嵌入：<target>" — not resolved |
| Raw HTML | Escaped as text |

Security: the renderer builds DOM nodes (`createElement` / `textContent`),
never `innerHTML` with note text. URLs other than http(s) are rendered as
plain text.

Internal links: resolve with the same rules as `VaultIndex.resolveTarget`.
`kg.note` already returns resolved data; extend its response with
`links: [{ raw, resolved | null }]` computed in `main.js` from
`record.linkTargets` so the view does not re-implement resolution. Clicking a
resolved link calls the existing drawer navigation (`onNavigate`) when the
target is a node in the model, otherwise opens the drawer for that path via
`kg.note`. Unresolved targets render as a dashed "missing" link, not
clickable.

Keep the existing redaction (`redactSensitiveContent`), `MAX_PREVIEW_CHARS`
truncation badge, and backlinks group unchanged.

Actions row in the drawer:

- Primary: none needed — the note is readable in place.
- Secondary: "复制文件路径" copies the absolute path (new channel
  `kg.copyPath`, uses `pi.clipboard.writeText`, permission already granted).
- Secondary: "复制 Obsidian 链接" (existing `kg.copyLink`), kept for users who
  still use Obsidian.

## 3. Knowledge dashboard (settings panel)

Add a section "知识看板" to `view/settings.html` / `view/settings-page.js`,
placed before "本体健康" (`#sec-health`), with nav pill `nav-dashboard`.

Backend: new channel `kg.dashboard` in `main.js`, pure derivation in a new
`lib/dashboard.mjs` so it is unit-testable. Input: the vault index; output:

```json
{
  "activeProjects": [{ "path", "title", "status", "stability", "verified" }],
  "reviewDue": [{ "path", "title", "type", "project", "stability",
                  "verificationScope", "verified", "reviewState" }]
}
```

Rules must match the `.base` formulas exactly (they are the user's existing
definition, not the ontology `STALE` rule):

- Base filter for both tables: `.md` only, not under `Templates/`, not under
  `04 Archive/`.
- 活跃项目: `type == "project"` and `status == "active"`, sorted by title.
- 待复核知识: `status == "active"` and `reviewState != "有效"`, where
  `reviewState` is:
  - `"未验证"` when `verified` is missing;
  - `"需复核"` when `stability == "volatile"` and `verified` is older than 30
    days, or `stability == "mixed"` and older than 90 days;
  - otherwise `"有效"`.
  Sort by review state (需复核 before 未验证), then title.
- Day arithmetic uses local dates; `now` is injectable for tests.

UI: two compact tables reusing the health-list row styles. Each row shows
title and the listed fields; clicking a row copies the note's file path and
shows a toast. Opening the note in the Knowledge Universe drawer from the
panel would need a cross-page targeting channel the host does not offer yet,
so it is out of scope here. Counts appear in the section header. Empty states
use i18n strings.

Do not write any file into the vault for this.

## 4. Copy and wording

`view/strings.js` (zh-CN and en):

- `drawerCopyLink` → "复制 Obsidian 链接" stays; add `drawerCopyPath`
  "复制文件路径" / "Copy file path", `toastPathCopied`.
- `healthDesc` → drop "复制 Obsidian 链接定位修复"; say rows can be opened in
  the drawer or copied as a path.
- New strings for the dashboard section and the embed chip / missing link.

The health list (`settings-page.js` §5) gets the same two actions as the
drawer: copy path (primary) and copy Obsidian link (secondary).

## 5. Manifest, skills, MCP text

Wording only, ids unchanged:

- `manifest.json` / `package.json` descriptions and safety notes: "a local
  Markdown knowledge vault (Obsidian-compatible)" instead of "a local Obsidian
  vault". Safety notes keep every factual statement; only the noun changes.
- `skills/obsidian-knowledge/SKILL.md`, `skills/obsidian-project-knowledge/SKILL.md`:
  descriptions and body say Markdown vault; keep any Obsidian-specific
  formatting guidance (wikilinks, callouts, Bases) as "compatible with
  Obsidian" notes.
- `mcp/server.mjs`, `mcp/tool-text.mjs`: tool descriptions say "knowledge
  vault"; `.base` remains searchable.
- `lib/obsidian-config.mjs` behavior unchanged (already a no-op without
  `.obsidian/`).

## 6. Tests

Add or update under `tests/`:

- `markdown-render.test.mjs`: assert `parseMarkdown` trees for every row of
  the §2 table, including raw HTML kept as text, non-http links rendered as
  text, callout, task list, table, wikilink with alias and heading, embed
  chip, frontmatter stripped. No DOM library is added.
- `dashboard.test.mjs`: both tables with an injected `now`, covering missing
  `verified`, volatile 29/31 days, mixed 89/91 days, archived/template
  exclusion, non-active status.
- `kg.note` response includes `links` with resolved and unresolved entries
  (extend the existing panel or knowledge-core test that exercises `kg.note`).
- New channels are added to the `CHANNELS` allow-list in `main.js`. In
  `tests/settings-panel.test.mjs` (which already drives `onPanelInvoke`):
  `kg.dashboard` returns both tables for a fixture vault, `kg.copyPath`
  writes the absolute path through a stubbed `pi.clipboard`, and
  `kg.openExternal` forwards http(s) to a stubbed `pi.shell.openExternal`
  and rejects `file:`, `obsidian:`, and `javascript:`. Add `shell.openExternal`
  to `manifest.json` permissions for this channel.

Run: `pnpm test` (or `npm test`) inside the plugin directory —
`node scripts/build.mjs --lib && node --test tests/*.test.mjs`.

UI check: open `view/index.html` and `view/settings.html` in fixture mode via
BrowserPreview, screenshot the drawer with a rendered note (heading, list,
callout, wikilink, embed chip) and the dashboard section.

## 7. Release

Bump to 0.7.0 in `manifest.json` and `package.json`; add a README changelog
line. Packaging, catalog, and `releases.json` follow the repository README
release steps only when the user authorizes a release.
