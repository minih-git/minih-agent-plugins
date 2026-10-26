# Selection Translate

Select any text in Minih-Agent-Desktop and translate it into Simplified Chinese
with your own model. A pill appears under the selection; one click opens a card
next to it with the translation, which you can copy, insert straight into the
composer, or re-translate on another model.

Built for the everyday case behind this plugin: a thinking model answers in
English, and the part you actually want to read is three paragraphs of it.

## What it does

| | |
| --- | --- |
| Select text | A `译` pill appears under the selection — in a reply, a thinking block, a panel, wherever prose is selectable |
| Click it | The card opens next to the text and translates with the configured model |
| Read | The translation keeps the original Markdown shape; the original is one click away under `原文` |
| Use it | `复制` copies it, `插入输入框` puts it at the composer caret |
| Change model or language | The card's two dropdowns re-translate the same text on another model or in another language, and remember both choices |

What it deliberately does not do: it never writes to the transcript, never
creates a session, never touches a file, and never sends anything anywhere
except the selected text in one model request.

## Where the model and the language come from

`contributes.settings` declares two settings:

```json
{ "key": "model", "type": "model", "default": "" }
{ "key": "language", "type": "select", "default": "zh-CN", "enum": [ … 10 languages … ] }
```

- `model` is the host's `model` setting type (app 1.1.0 and later): the settings
  sheet fills its dropdown from the live ready-model list, and empty means the
  app's current default model — so the plugin works before it is configured at
  all. A model that has since been removed falls back to the default, and the
  card says which model ran.
- `language` is a plain `select`: the ten languages in `lib/languages.js`, with
  Simplified Chinese first because that is what the plugin is for. The list is
  declared twice — once in the manifest for the settings sheet, once in code for
  the prompt — and a test fails if the two drift apart.
- The card's two dropdowns write the same two keys through
  `pi.plugin.setSettings`, so a choice made mid-card is the setting the app's
  plugin settings sheet shows.

## How it is built

```text
manifest.json                 renderer entry, whitelists, two settings
main.js                       plugin process: jobs, model + language resolution, one agent.complete per request
lib/prompt.js                 the request text, for one target language (pure)
lib/languages.js              the languages a request can ask for (pure)
lib/jobs.js                   job store: running → done/error/cancelled (pure)
lib/models.js                 which model a request runs on (pure)
lib/errors.js                 coded host errors → reader-facing Chinese (pure)
renderer/index.mjs            the pill and the behaviour (host React, host layer)
renderer/card.mjs             the card's markup (pure: state in, elements out)
renderer/selection.mjs        reading a selection and placing a box under it (pure)
renderer/styles.mjs           the stylesheet, scoped to this plugin's layer
tests/*.test.mjs              node --test
```

Two constraints shaped this design, both from the host's own contract:

1. **A renderer call must answer within 2s** (`RENDERER_CALL_TIMEOUT_MS`), while
   one completion may take up to 90s (`PLUGIN_COMPLETE_TIMEOUT_MS`). So
   `translate` starts the work, answers `{ jobId }`, and the card polls `poll`
   every 450ms. The relay allows 10 calls/s and trips a 30s cool-down after 5
   consecutive failures, so polling never throws for an expected condition.
2. **A slot cannot host a floating box** — action bars fade, clip and stack. The
   pill and the card live in `pi.ui.openLayer()`: a zero-size, viewport-fixed
   element at the end of the body that carries this plugin's style scope.

While a card is open it follows its text: the selection is cloned as a `Range`,
so scrolling the thread moves the card with the passage it belongs to. Pressing
elsewhere closes it, unless that press is part of selecting text inside the
card; `Escape` closes it too.

The host draws its own pill above a selection (the quote action), so this one
places itself below: the two do not overlap.

## Permissions

| Permission | Why |
| --- | --- |
| `renderer.extension` | the module that reads the window's selection and draws the card |
| `agent.complete` | exactly one completion per translation |
| `models.list` | the model dropdown |
| `clipboard.write` | the copy fallback when the window clipboard is refused |

No filesystem, no network of its own, no session read or write.

## Limits

- One request carries at most 8000 characters; a longer selection is translated
  up to that point and the card says so.
- The host allows 8 plugin completions per minute; past that the card answers
  "一分钟内的翻译次数太多了".
- Selections inside form fields, editors (the composer, CodeMirror views), the
  terminal and the plugin's own card are ignored.

## Install

Requires Minih-Agent-Desktop 1.1.0 or later: the model dropdown in the settings
sheet is the host's `model` setting type, which arrived with that release.

From a checkout of this repository, with a Minih-Agent-Desktop checkout next to
it:

```bash
pi-plugin check plugins/minih.selection-translate
pi-plugin pack plugins/minih.selection-translate --out packages
```

The `.piplug` in `packages/` installs from the app (Marketplace → Install from
file). Publishing means adding the package, `catalog.json` and `releases.json`
in one commit — see the repository README.

## Tests

```bash
node --test tests/*.test.mjs
```

The tests cover the request text, the job state machine, model resolution and
its fallbacks, the host error → reader text mapping, selection reading and box
placement, and the whole `translate → poll` flow against a stubbed host.