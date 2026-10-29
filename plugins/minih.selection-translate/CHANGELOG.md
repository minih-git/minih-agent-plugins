# Changelog

## 0.3.2

The 「译」 mark is readable again.

- Both the mark on the selection pill and the one in the card header drew the
  accent colour on the soft accent fill: 2.59:1 in the light theme and 2.19:1
  in the dark one, below the 3:1 floor, so the character read as a smudge.
  They are now a solid accent chip with the page ink on top — 17:1 in both
  themes, the same combination the card's primary button already used.

## 0.3.1

Translations come back faster, and a slow model no longer looks frozen.

- The request no longer asks for thinking. Translation is transcription, and on
  a reasoning model the thinking time was most of the wait: the host aborts a
  plugin completion after 90 seconds, which is exactly what a slow reasoning
  model ran into. The host clamps the level to what the model supports.
- While it runs, the card counts the seconds it has been waiting, so a slow
  model reads as slow instead of dead.

## 0.3.0

A keyboard shortcut, so the pill is optional.

- Select text and press `Option+E` (macOS) or `Alt+E` (Windows, Linux): the
  translation starts without a click. The check is on the physical E key with
  Alt held, which is what makes it work on macOS — there Option+E is a dead key
  and arrives as `key: "Dead"` — and on non-Latin layouts.
- It only fires when there is prose selected outside a field, an editor, the
  terminal or the card itself, so it never takes a keystroke meant for the
  composer or an input method; holding the key down translates once.
- The pill's tooltip now names the shortcut, and its label no longer says
  "中文" only — the target language is a setting now.

## 0.2.0

Choose the language, and choose the model from a list.

- A new `翻译语种` setting picks the target language — Simplified Chinese by
  default, plus Traditional Chinese, English, 日本語, 한국어, Français, Deutsch,
  Español, Русский and Português. The card carries the same dropdown and
  re-translates the passage in the language just picked.
- The model setting is now a real dropdown in the plugin settings sheet: the
  host fills it from the live ready-model list, so nobody has to type a
  `providerId/modelId` any more. Empty still means the app's default model.
  This needs Minih-Agent-Desktop 1.1.0 or later.
- The prompt names the requested language and the "already in that language"
  case follows it; an unknown language in a settings file falls back to
  Simplified Chinese instead of failing.

## 0.1.0

First release: translate whatever you select.

- A `译` pill appears under a text selection anywhere in the window — a reply, a
  thinking block, a panel — and one click translates it into Simplified Chinese
  with your own model.
- The result opens in a card next to the text: the translation keeps the
  original Markdown shape, and the original sits behind `原文`.
- `复制` copies the translation; `插入输入框` puts it at the composer caret.
- The model is the plugin's `model` setting. Empty means the app's default
  model, so the plugin works unconfigured; the card's dropdown lists the live
  models, re-runs the same text on the one you pick, and remembers it. A model
  that has since been removed falls back to the default and says so.
- The card follows its passage while the thread scrolls; selecting text inside
  the card does not dismiss it, `Escape` or a press elsewhere does.
- Selections inside form fields, editors, the terminal and the plugin's own card
  are ignored; a very long selection is capped at 8000 characters with a note.