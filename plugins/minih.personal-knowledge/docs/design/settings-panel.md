# Settings panel

- Status: Accepted (2026-10-25)
- Target version: 0.4.0
- Scope: one host panel that holds every plugin setting. The Knowledge Universe
  view drops its ⚙ menu and keeps only what is drawn on the star map.

## 1. Entry

The Plugins page shows an "Open panel" button for any plugin that declares a
panel in its manifest. The plugin declares one and requests `ui.panel`:

```json
{
  "ui": {
    "panel": "view/settings.html",
    "width": 720,
    "height": 760,
    "title": { "en": "Personal Knowledge Settings", "zh-CN": "知识库设置" }
  },
  "permissions": ["…existing…", "ui.panel"]
}
```

- The panel page lives in `view/` so it can import the shared modules
  (`bridge.js`, `strings.js`, `settings.js`, `vendor/*`). Pages may not import
  from a parent directory.
- The view's ⚙ button opens the same panel: the view invokes
  `kg.openSettings`, and `main.js` calls `pi.ui.openPanel()`.
- The panel and the view share `onPanelInvoke`. Every new channel is added to
  the `CHANNELS` allow-list in `main.js`.

## 2. Sections

| Section | Content | Editable |
|---|---|---|
| Vault | Vault path (with note count and an exists check), read-only mode, backup retention days, ignored folders | Yes. Path and ignored folders apply after the plugin is reloaded; the panel says so next to the field |
| Vector retrieval | The existing retrieval form (`RetrievalSettingsPanel`), with test connection and key status | Yes |
| Index | Notes, chunks stored and pending, model and dims, time of the last write; incremental refresh and full rebuild with progress | Actions |
| Display | Interface language: follow host, 中文, EN | Yes |
| Ontology health | The issue list now in the view, with the severity filter and a copy-link action per note | Read only |
| Project routing | Projects (repo prefixes, aliases, notes), topic routes, default notes; notes that do not exist are flagged | Read only; edit `repo-map.json` by hand |
| Memory | Whether learned-memory reading is enabled in Desktop, and where to turn it on | Read only |

Ontology migration stays out of the panel; a session drives it.

## 3. Storage and precedence

Configuration stays in the files the MCP server, the CLI scripts, and other
agent clients already read. The panel is only an editor.

| Setting | File | Overridden by |
|---|---|---|
| `vaultPath`, `ignoreFolders`, `backupRetentionDays`, `readOnly` (new optional key) | `~/.personal-knowledge/repo-map.json`, or the file `PERSONAL_KNOWLEDGE_CONFIG` names | `PERSONAL_KNOWLEDGE_VAULT`, `PERSONAL_KNOWLEDGE_READ_ONLY` |
| Embedding | `~/.personal-knowledge/embedding.json`, or `PERSONAL_KNOWLEDGE_EMBEDDING_CONFIG` | — |
| Language | `view-prefs.json` in `pi.plugin.getDataPath()` | — |

Rules:

- An environment variable wins. The panel shows the field as locked and names
  the variable, so an edit never silently fails to apply.
- Saving `repo-map.json`:
  - keeps every key the panel does not edit;
  - writes atomically and backs up the previous file to
    `~/.personal-knowledge/backups/repo-map-<timestamp>.json`.
- When no user file exists yet, the first save starts from the bundled
  template.
- `readOnly` applies immediately. Before a real write (`knowledge_write` with
  `dryRun: false`, `kg.promote.apply`), both the MCP server and `main.js`
  re-read the config: an mtime check, at most once per second, the same rule
  as `embedding.json`.
- The two existing `isReadOnlyMode()` copies become one helper in `lib/`.
- The language moves out of the view's `localStorage`. The panel and the view
  are separate pages and need one source. On first load the view migrates a
  stored language into `view-prefs.json` (if that file has none), then removes
  it from `localStorage`.

## 4. Channels

| Channel | Payload → result |
|---|---|
| `kg.settings.get/set/test` | Unchanged |
| `kg.graph` | Unchanged. The panel's health section reads its `issues` |
| `kg.config.get` | → `{ path, source: "user" \| "template", values, locked: { key: envName }, vault: { exists, notes }, reloadRequired: [key] }` |
| `kg.config.set` | `{ values }` → `{ saved, reloadRequired }`. Refuses locked keys. Validates: the vault path is an existing directory; retention is an integer from 1 to 3650; ignored folders are relative and contain no `..` |
| `kg.routing.get` | → `{ projects, topicRoutes, defaultNotes }`, each note with `exists` |
| `kg.index.status` | → `{ enabled, vectorReady, notes, chunks, stored, pending, model, dims, writtenAt, running, done, total, reason }` |
| `kg.index.rebuild` | `{ mode: "incremental" \| "full" }` → `{ started }`, or a refusal with `RUNNING` / `DISABLED` |
| `kg.memory.status` | → `{ readEnabled }`, from `pi.memory.list({ limit: 1 })` |
| `kg.prefs.get/set` | `{ language: "auto" \| "zh-CN" \| "en" }` |
| `kg.openSettings` | → opens the panel |

## 5. View changes

- The ⚙ menu goes. The ⚙ button now opens the settings panel.
- The retrieval side panel goes; its form lives in the panel only.
- Health mode splits:
  - the issue list moves to the panel;
  - coloring by severity becomes a row in the ≡ Layers menu.
- Time-lapse becomes a corner control on the star map (play or pause, plus a
  slider), because it animates the map itself. Under reduced motion it steps
  instead of animating.
- Language: the view reads `kg.prefs.get` on load and again on `focus` and
  `visibilitychange`. The host cannot push an event from one plugin page to
  another, so a change in the panel shows when the user returns to the view.
- The 3D / star-chart mode toggle is unchanged.

## 6. Lifecycle and concurrency

- `main.js` owns at most one index run. A second `kg.index.rebuild` while one
  is running is refused with `RUNNING`.
- `ensureVectors` gains an optional `onProgress({ done, total })`, called
  between batches. It also gains an abort signal that is checked between
  batches.
- `onUnload` aborts the run, so a plugin reload or disable never leaves an
  orphaned run behind.
- The existing `.lock` file still serializes writers across `main.js`, the MCP
  server, and the CLI. The shrink guard stays.
- A full rebuild asks for confirmation first. With a remote endpoint it sends
  every note to the provider again.
- The panel polls `kg.index.status` every second while a run is in progress,
  and stops polling while the panel is hidden.

## 7. Compatibility and release

- Version 0.4.0. The new `ui.panel` permission makes Desktop ask the user to
  review the plugin's permissions again on reload. `engines` is unchanged.
- File formats are unchanged except for the new optional `readOnly` key in
  `repo-map.json`. Older builds and other clients ignore it.
- The panel follows the host theme (`appearance:changed`) and the language
  rule in §3, and reads `--pi-plugin-titlebar-height` for its top padding.

## 8. Tests and acceptance

Every test uses `tests/helpers/home.mjs`; none touches the real
`~/.personal-knowledge`.

- `kg.config.*`:
  - an environment variable locks its field;
  - keys the panel does not edit survive a save;
  - a backup is written;
  - the template is used when no user file exists;
  - invalid values are refused.
- `readOnly`: after the config is toggled, the next real write is refused
  without a restart. Cover both the MCP handler and `kg.promote.apply`.
- `kg.index.rebuild`:
  - the single-run guard holds;
  - progress only moves forward;
  - an abort stops the run between batches;
  - the index never shrinks.
- `kg.prefs.*`: values round-trip, and the legacy `localStorage` language is
  migrated.
- The user path, in BrowserPreview with a stub bridge:
  - open each section;
  - save the vault settings;
  - test the connection;
  - start an incremental refresh with fake progress;
  - in the view, ⚙ opens the panel, the time-lapse corner control plays, and
    the coloring layer toggles.
- Screenshots: panel at 720×760 and at a narrow width; view at 1024×768.
  Screenshots stay out of the repository.

## 9. Out of scope

- Editing project routing in the panel
- A migration UI
- Any Desktop change, including an API to restart the MCP server
- New MCP tools
