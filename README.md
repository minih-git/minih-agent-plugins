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
https://gitea.hungraim.com/minih/minih-agent-plugins/raw/branch/main/catalog.json
```

## Plugins published here

One of them was built by someone else and is redistributed here unmodified,
keeping its own `LICENSE` and notice files inside its directory.
`minih.personal-knowledge`, `minih.selection-translate` and
`minih.cache-keepwarm` are authored in this repository.

| Plugin | Version | Author | License | Upstream |
| --- | --- | --- | --- | --- |
| `minih.personal-knowledge` (`Personal Knowledge`) | 0.5.0 | minih-git | MIT | this repository |
| `minih.selection-translate` (`Selection Translate`) | 0.3.2 | minih-git | MIT | this repository |
| `minih.cache-keepwarm` (`Cache keep-warm`) | 0.1.0 | minih-git | MIT | this repository |
| `pi.file-manager` (`File Manager`) | 0.9.0 | Tioit-Wang | not declared by the author | not published by the author |

`minih.personal-knowledge` 0.5.0 adds the conversation archive (ADR 0002 in
its `docs/adr/`): it archives Desktop conversations into `09 Conversations/`
inside the vault, adds `conversation_search` and `conversation_read`, and asks
for three more permissions — `conversation.read`, `agent.complete` and
`models.list`. Its settings panel gains two sections: the archive status with
"sync now" and an editable device name, and the weekly profile candidates with
a model picker. It requires Desktop v1.4.0 or newer
(`engines.minihAgent` is `>=1.4.0`), the first release that publishes
`conversation.read`.

The unreleased 0.6.0 source adds a third vector provider, `host`, which embeds
through an embedding model configured in Desktop (`pi.embeddings.embed`, ADR
0003 in the plugin's `docs/adr/`); until Desktop 1.5.0 is published the option
is disabled and the manifest keeps its current permissions and `engines`.

The redistributed ones are listed with `trust: "community"` and
`verified: false`: the `verified` badge is a claim about a publisher this
repository cannot make on someone else's behalf. A plugin authored here is the
project's own, so the generator marks it `verified` — `FIRST_PARTY` in
`scripts/build-catalog.mjs` is the list, and adding an id to it is a deliberate
act, not a side effect of publishing.

The catalog's authorship badge is not a publisher signature; package
integrity remains checked by SHA-256.

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

5. Publish to the public Gitea repository at
   `https://gitea.hungraim.com/minih/minih-agent-plugins`. The catalog and
   packages must be accessible without signing in; never embed a token in a URL.
   Commit the package, the plugin directory, the catalog, and `releases.json`
   in one commit, then push. Bytes and the digest describing them land in the
   same commit, so changing published bytes means rewriting history rather
   than re-uploading a file — which is why branch protection matters here.

## A note on repository size

Committed binaries are permanent: a version removed from `packages/` stays in
history, so every clone pays for every version ever published. That is the
accepted trade for having the artifact and its digest in one tamper-evident
record.
