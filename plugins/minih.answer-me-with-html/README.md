# Answer me with HTML (Minih-Agent-Desktop plugin)

Answer a hard question with a one-page HTML explainer, and keep the pages in one
place. The Agent writes a short Markdown draft; the bundled `am` CLI does the
layout, colours, dark mode and diagram coordinates; the reply ends with a card
this plugin draws in the conversation; and the panel lists what was made, so a
page can be opened, copied, deleted or cleaned up without hunting through a
hidden folder.

This plugin wraps the upstream skill
[`answer-me-with-html`](https://github.com/QingYunA/answer-me-with-html) (v0.5.6,
MIT). It ships the skill and its CLI unchanged, plus a host note for
Minih-Agent-Desktop, and adds the card, the panel and two commands.

## What it contributes

| Contribution | What it does |
| --- | --- |
| Skill `minih.answer-me-with-html/answer-me-with-html` | The Agent's instructions for writing a page, loaded on demand |
| Bundled CLI `skills/answer-me-with-html/scripts/am.mjs` | The renderer the skill drives over Bash; self-contained, no `npm install` |
| Reply card (`blockRenderer` slot) | The page at the end of a reply, drawn in the conversation with open / copy buttons |
| Panel | The pages the CLI wrote: open, copy path, delete one, clean old ones |
| Command `Answer me with HTML: Open panel` | Opens the panel from global search |
| Command `Answer me with HTML: Open pages folder` | Reveals the data directory in the file manager |
| Setting `cleanupDays` | The age the clean-up button uses (default 30 days) |

There is no agent tool: the skill runs the CLI over Bash, exactly as upstream
intends, so there is one way to render a page instead of two.

## Install

From the marketplace of this distribution repository, or for development:

1. **Plugins** → header overflow menu → **Load development plugin**.
2. Select this directory.
3. Review the permissions (`agent.prompt.inject` and `renderer.extension` are high
   risk) and grant them.

The skill appears in the Agent's skill list after the plugin loads; an already
running session picks it up in its next turn.

## Use

Ask the way you always do — "explain how this request path works", "compare
Redis and Memcached for our cache", "why is this job slow" — or say
`画个图 / 讲讲原理`. The Agent writes the draft, runs the CLI, and ends its reply
with the card below.

Settings that belong to the page itself (theme, light/dark, text size, auto-open,
the STE writing check, voice) are the CLI's own: `am config`, or `am help` for
everything else. The panel points at them instead of duplicating them.

## Where the pages live

`AM_HOME` when it is set, otherwise `~/.answer-me-with-html`:

```text
pages/    one HTML page per answer        ← the panel lists these
videos/   explainer videos
cache/    voice-over cache
```

The plugin resolves that directory the same way the CLI does, and reads the two
folders the CLI itself writes to and cleans: that directory's `pages/`, and —
when the CLI had to fall back because the directory was not writable — its
temporary folder `<tmpdir>/answer-me-with-html-<uid>/pages/`. Rows from the
second folder are labelled as coming from the temporary folder. If `AM_HOME` is
set in your shell but not for the app, the panel shows the default directory:
set it for the app too, or unset it, so both see the same folder.

A page written somewhere else on purpose (`am render -o <file>`, for the
workspace) is not listed by the panel; the card still shows it.

Cleaning is the CLI's own `am clean`, so the plugin and the CLI agree on what
"old" means: pages and videos older than the setting in every folder, plus the
voice-over cache. The panel's destructive buttons are two-step — the first click
arms, the second runs.

## When a page appears

The skill makes a page when a picture carries the answer: a flow, request path,
architecture, state machine or lifecycle; a comparison across three or more
dimensions; a diagnosis with several findings to rank; a hierarchy; or when you
ask for a diagram. A short factual answer, a yes/no with its reason, a single
cause or a one-line fix stays plain text. This plugin adds no always-on mode of
its own.

If you want a page for **every** answer with a conclusion, add this to
`~/.pi/agent/AGENTS.md` (the rules file this host reads):

> `[answer-me-with-html always-on]` Whenever a reply gives a conclusion, summary, plan, comparison, review or explanation, even a short one, also make a page with the answer-me-with-html skill (2 to 4 panels for routine answers), render it with `--no-open` before you write the reply, and end the reply with the page card. Skip casual chat, one- or two-sentence replies with no conclusion, pure command output, and requests for plain text.

To go the other way — pages only when you ask for one — add instead:

> Do not use the answer-me-with-html skill unless I ask for a page, a diagram or a visual explanation, or say I don't get it.

## Where a page goes, and how a reply ends

Two destinations, and the choice decides whether the click opens the page in the
app or elsewhere.

| Destination | How the reply ends | What a click does |
| --- | --- | --- |
| Session scratch: `-o "$PI_SCRATCH_DIR/answers/<topic>.html"` | a plain link `[打开页面 · 标题](file:///…)` | opens in the app's own browser panel, next to the conversation |
| Library: `~/.answer-me-with-html/pages` | the card below | the card's button: in-app browser if its panel is showing, else the system browser |

The app routes a linked `.html` file inside the project or the session scratch
directory to its browser panel; a file anywhere else only gets "reveal in the
file manager" and "copy path". That is why the scratch directory is the default
and the library is the deliberate choice for keeping a page. The panel lists both
(the scratch rows are labelled 会话临时目录).

## The card at the end of a reply

For a page kept in the library, a reply ends with one fenced block, and the plugin
draws a card for it:

````markdown
```minih.answer-me-with-html:page
/Users/you/.answer-me-with-html/pages/TCP-三次握手-20261021-095532.html
```
````

The card shows the page title, where it lives (页面库 / 临时目录 / 其他位置), its
size and time, and two buttons. **打开页面** asks the app's own browser panel to
show the page first, and falls back to the system's default browser when the host
refuses; the card says which happened. **复制路径** copies the absolute path. The file name sits under them, and
the full path is its tooltip — no bare path and no long URL appears in the reply.

States it can be in: **读取中** while the plugin answers, **打不开** with the
reason when the file is gone (and then no buttons, so nothing dead is
clickable), and a plain notice when the fence holds no path at all. Without the
plugin the same fence falls back to a code block, so the path stays readable
either way.

### Why the page opens in a browser window, not inside the reply

Inside the reply only a card can be drawn (see below). Opening the page itself is
a separate step, and the plugin tries the app's own browser panel first. That
panel only accepts work while it is the visible work-panel tab, keyed by an
active session — and a card's button runs from a renderer call, which carries no
session. So the in-app path needs the Browser panel to be open already; with it
closed, the click lands in the system browser and the card says so. Open the
Browser tab once (right work panel → Browser) if you want clicks to stay in the
app.

### Why a card and not the page itself

The host renderer's Content-Security-Policy is `default-src 'self'` with no
`frame-src`, and the renderer document itself is loaded from `file://`, so a page
in another folder cannot be embedded as an iframe inside a reply. A renderer slot
is the one supported way to draw something of your own in the conversation, and
that is what this card is.

This is also why the plugin no longer suggests a plain `file://` link: for a page
**outside the workspace** a click on such a link only offers "reveal in the file
manager" and "copy absolute path", which is a worse answer than one button.

## Permissions

| Permission | Risk | Why |
| --- | --- | --- |
| `agent.prompt.inject` | high | Required for `contributes.skills`: without it the skill is never sent to the Agent |
| `ui.panel` | low | The panel window |
| `clipboard.write` | medium | "Copy path" on a page row and on the card |
| `renderer.extension` | high | The reply card: a module the host evaluates in its own renderer, plus the `plugin.call` whitelist that reaches `onRendererCall` |
| `browser.cdp` | high | Showing a page in the app's browser panel. Broader than this one use — the host exposes no narrower browser API — so denying it costs nothing: every open then goes to the system browser |

The plugin asks for no file permission. It reads and deletes pages with its own
Node process, because those files live outside the workspace and the host file
gateway is rooted in the workspace; the rules it keeps instead are in `main.js` —
the CLI's own folders only, one file-name shape, one regular file per delete, and
the CLI for bulk cleaning. The card's path arrives from the reply, so it is
checked the same way (absolute, plain `.html` name, existing regular file) before
anything is read or opened. It has no network access.

## Files

```text
manifest.json                    identity, contributions, permissions
main.js                          commands, panel channels, card channels, file operations
lib/pages.js                     page listing, naming rules, folder usage
renderer/card.mjs                the reply card (renderer slot)
renderer/index.html, panel.css, panel.js   the panel
skills/answer-me-with-html/      the bundled upstream skill and CLI
tests/                           offline tests (node --test)
UPSTREAM.json                    upstream commit, file hashes, what was changed
THIRD_PARTY_NOTICES.md           upstream attribution and licence
CHANGELOG.md                     release notes
```

## Develop

```bash
node --test --test-timeout=120000 "tests/*.test.js"   # offline, no app needed
pi-plugin check .                                     # from a Minih-Agent-Desktop checkout
pi-plugin pack . --out ../../packages
```

The tests cover the naming and listing rules the panel depends on, the checks the
card's channels enforce, and the bundled CLI end to end with `AM_HOME` pointed at
a temporary directory.

To look at the card without loading the plugin, bundle `renderer/card.mjs` with a
stub `pi` that answers `plugin.call`, and open the result in a browser: the card
uses only `react` and the host's `--ds-*` tokens, so it renders outside the app.

### Updating the bundled skill

Replace `scripts/am.mjs`, `references/` and `licenses/` from the new upstream
tag, re-apply the "Host: Minih-Agent-Desktop" note in `SKILL.md`, then refresh the
hashes in `UPSTREAM.json`. Bump this plugin's version and add a `CHANGELOG.md`
entry that names the upstream version.

## Licence

MIT. The bundled skill, CLI and references are upstream work by QingYunA under
the same licence; see `THIRD_PARTY_NOTICES.md` and `UPSTREAM.json`.
