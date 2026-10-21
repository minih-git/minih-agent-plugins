# Third-party notices

## answer-me-with-html (skill, `am` CLI, references, font licence)

- Upstream: <https://github.com/QingYunA/answer-me-with-html>
- Version bundled here: 0.5.6, commit `e00b254c26d18783d274ade55585b2e63dc31f34`
- Licence: MIT — the full text ships as this plugin's `LICENSE` file, which is
  the upstream licence copied unchanged
- Copyright: QingYunA and the answer-me-with-html contributors

Bundled verbatim under `skills/answer-me-with-html/`:

| File | Note |
| --- | --- |
| `scripts/am.mjs` | the CLI, built by the upstream `scripts/build.mjs`; self-contained, no npm install |
| `references/settings.md`, `references/video.md` | read on demand by the skill |
| `licenses/OFL-Bangers.txt` | SIL Open Font License for the Bangers font the CLI embeds |

`SKILL.md` is the upstream document with one added host note and two
host-specific sentences. `UPSTREAM.json` records the upstream commit, the
SHA-256 of every bundled file, and exactly what was changed.

The plugin wrapper (manifest, entry, panel, tests, docs) is original work
released under the same MIT licence.

## Assets written by this plugin

None. The `icon.svg` in this directory was drawn for this plugin.
