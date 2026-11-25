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
`minih.personal-knowledge`, `minih.selection-translate`,
`minih.cache-keepwarm` and `minih.inbox-mail` are authored in this repository.

| Plugin | Version | Author | License | Upstream |
| --- | --- | --- | --- | --- |
| `minih.personal-knowledge` (`Personal Knowledge`) | 0.7.2 | minih-git | MIT | this repository |
| `minih.selection-translate` (`Selection Translate`) | 0.3.2 | minih-git | MIT | this repository |
| `minih.cache-keepwarm` (`Cache keep-warm`) | 0.1.0 | minih-git | MIT | this repository |
| `minih.inbox-mail` (`Inbox mail`) | 0.5.0 | minih-git | MIT | this repository |
| `minih.session-titles` (`Session Titles`) | 0.1.0 | minih-git | MIT | this repository |
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

0.6.0 adds a third vector provider, `host`, which embeds through an embedding
model configured in Desktop (`pi.embeddings.embed`, ADR 0003 in the plugin's
`docs/adr/`). It requires Desktop v1.5.0 or newer (`engines.minihAgent` is
`>=1.5.0`) and adds two permissions: `embeddings.run` and
`agent.tool.register`. In that mode the plugin's main process serves
`knowledge_search` and `conversation_search` itself, because only it can reach
the app's embedding model.

0.7.0 removes the last reason to also install Obsidian: the drawer renders a
note as Markdown instead of raw text, its wikilinks open in place (or are drawn
as missing), and the settings panel gains a knowledge dashboard that derives
the vault's two `.base` tables ("活跃项目", "待复核知识") with the same rules.
Obsidian stays optional — the vault is read as plain Markdown, nothing is
written for the dashboard, and "copy Obsidian link" remains as a secondary
action. It adds one permission, `shell.openExternal`, for http(s) links found
in a note. The design is `docs/design/obsidian-independence.md` in the plugin.

0.7.1 fixes startup for large or cloud-backed vaults: plugin activation and
MCP discovery no longer wait for a vault scan. Raw transcripts and daily
roll-ups stay out of every index, a failed scan can recover the archive and
profile scheduler on retry, and concurrent settings requests share one service
and the view's index. It keeps the same permissions, Desktop requirement, and
stored formats. See `docs/design/background-startup.md` in the plugin.

0.7.2 also fixes the first view load: the page polls real vault progress before
requesting its graph, so cloud hydration is not held inside a 30-second bridge
call. Read failures show the real error with retry, never demo data. File reads
use a bounded parallel batch, and vault configuration stays available while
indexing. No permission or data-format changes are needed.

`minih.inbox-mail` 0.5.0 is the resident assistant's first information source
and a small mail client of its own: it watches your mailboxes and writes what
arrives into the notification centre — one alert for a message from an
important sender, matching one of your keywords or marked urgent by its own
headers, and one rolling digest per account for the rest. Each account is
either one of the providers the plugin names or a mail server you type in
yourself — IMAP or POP3, TLS or STARTTLS, on the port you gave — and that
endpoint belongs to the credential instance, so the app injects the password
only into the server saved with the account and the plugin cannot redirect it.
There is no mailbox limit in the plugin (the app keeps its own bound of 100),
and no connection outlives a check: every account is polled in one short
session every three minutes, at most four at a time.

The Inbox panel is laid out like a mail client: three columns from 1100 px
wide, a list grouped by day with a one-line preview of every message that is
stored with it, search and filter, load older mail, and keyboard shortcuts. A
body is downloaded only when you open that message — opening is what marks
that one message read — and star, delete or archive only the message you
clicked. A POP3 mailbox has no server flags, so read there is a mark kept on
this computer, a delete asks in the panel first, and no star is offered.

0.5.0 also writes mail. Write composes a message with recipient chips for
To/Cc/Bcc, subject, body, attachments and a running size; reply, reply to all
and forward start from the message you already have open; Send goes through
the app's own SMTP session (`mail.send`), which logs in with the account's own
password, keeps Bcc in the envelope, files a copy in the account's Sent folder
and never hands the plugin the password, the socket or the server's reply. An
attachment's Save fetches exactly that part and hands it to the host's save
dialog (`pi.fs.saveAs`), 50 MiB at most, one dialog at a time, nothing written
into the plugin's data folder. An HTML body is shown as it arrives inside a
scriptless, origin-less sandbox that loads nothing remote.

Collecting, deciding, notifying, composing and sending call no model, so
nothing you receive or write reaches an AI provider. It needs Desktop v1.11.0
or newer (`engines.minihAgent` is `>=1.11.0`): `mail.send` and `pi.fs.saveAs`
are host capabilities that arrived in 1.11.0, and the marketplace now enforces
the declared floor, so a 1.10.x app is not offered this version. The host
still performs every sign-in, so the plugin never receives a password.

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

## Session Titles

`minih.session-titles` moves model-composed session naming into an optional
plugin with native model, thinking-level and compaction-refresh settings. It
requires the Desktop title-plugin migration (target range `>=1.8.1`) and explicit
`session.autoTitle`, `session.titleContext`, `models.list` and `agent.complete`
grants. Without it the host keeps its free first-prompt fallback. See the
[plugin README](plugins/minih.session-titles/README.md) for compatibility, retry
limits, privacy boundaries and test commands. This does not change the shared
model transport or claim to repair an existing connection failure.

## A note on repository size

Committed binaries are permanent: a version removed from `packages/` stays in
history, so every clone pays for every version ever published. That is the
accepted trade for having the artifact and its digest in one tamper-evident
record.
