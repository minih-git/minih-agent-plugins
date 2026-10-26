# Minih-Agent-Desktop plugins

The plugin distribution repository for
[Minih-Agent-Desktop](https://github.com/minih-git/minih-agent-desktop).

Plugins → Marketplace in the desktop app reads `catalog.json` from this
repository and downloads packages from the same tree. There is no publishing
platform behind it: no resolve endpoint, no device identifier, no second
distribution authority. This repository replaced the external plugin center the
client used to integrate with (ADR 0277).

## Layout

```text
catalog.json                                  what a client downloads first
releases.json                                 first-publication date per version
packages/<id>-<version>.piplug                the built package
plugins/<id>/                                 the plugin itself, as installed
scripts/build-catalog.mjs                     regenerates catalog.json
```

`catalog.json` declares `artifact_base_url` and every version carries a
`packages/...` relative URL, so a mirror serving the same tree serves the same
bytes and the digest in the catalog keeps matching. Packages are store-only
`.piplug` archives; the client verifies the declared SHA-256 before it extracts
anything.

The client reads this catalog at:

```text
https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json
```

## Plugins published here

Three of them were built by other people and are redistributed here unmodified,
keeping their own `LICENSE` and notice files inside their directories.
`minih.terminal`, `minih.personal-knowledge` and `minih.selection-translate`
are authored in this repository.

| Plugin | Version | Author | License | Upstream |
| --- | --- | --- | --- | --- |
| `minih.terminal` (`Terminal`) | 0.1.4 | minih-git | MIT | this repository |
| `minih.personal-knowledge` (`Personal Knowledge`) | 0.4.0 | minih-git | MIT | this repository |
| `minih.selection-translate` (`Selection Translate`) | 0.1.0 | minih-git | MIT | this repository |
| `cn.star.computer-use` (`Computer Use`) | 0.4.0 | TheFlareStar | MPL-2.0 | not published by the author |
| `local.remote-tools` (`Remote SSH Tools`) | 0.1.0 | jiege6-66 | MIT | `github.com/jiege6-66/pi-desktop-remote-tools` |
| `pi.file-manager` (`File Manager`) | 0.9.0 | Tioit-Wang | not declared by the author | not published by the author |

The redistributed ones are listed with `trust: "community"` and
`verified: false`: the `verified` badge is a claim about a publisher this
repository cannot make on someone else's behalf. A plugin authored here is the
project's own, so the generator marks it `verified` — `FIRST_PARTY` in
`scripts/build-catalog.mjs` is the list, and adding an id to it is a deliberate
act, not a side effect of publishing.

## Adding or updating a plugin

1. Put the plugin directory at `plugins/<id>/` with its `manifest.json`.
2. Build the package:

   ```bash
   pi-plugin pack plugins/<id> --out packages
   ```

   The packer prints the SHA-256 it wrote; `build-catalog.mjs` recomputes it
   from the file, so the catalog cannot drift from the bytes.

3. Regenerate the catalog:

   ```bash
   node scripts/build-catalog.mjs
   ```

4. Run the release gate against the regenerated catalog. It is stricter than
   discovery: every version needs a semantic version, a unique version within
   its plugin, a 64-character SHA-256, a package URL, a positive size, and a
   permissions array, and every package host must be one the client accepts.

   ```bash
   pnpm check:marketplace -- --url ./catalog.json --plugin <id>
   ```

   (run from a Minih-Agent-Desktop checkout, or call
   `node scripts/check-marketplace-catalog.mjs` there directly).

5. Commit the package, the plugin directory, the catalog, and `releases.json`
   in one commit, then push. Bytes and the digest describing them land in the
   same commit, so changing published bytes means rewriting history rather
   than re-uploading a file — which is why branch protection matters here.

## A note on repository size

Committed binaries are permanent: a version removed from `packages/` stays in
history, so every clone pays for every version ever published. That is the
accepted trade for having the artifact and its digest in one tamper-evident
record.
