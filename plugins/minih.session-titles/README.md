# Session Titles

Generates concise session titles from the first request using a model selected
in **Plugins → Session Titles → Settings**. Empty model selection uses the
session's model, or the host default when the session has no model. An explicitly
selected unavailable model is never silently replaced.

## Requirements

Requires the Desktop build containing the title-plugin migration (target host
range `>=1.8.1`). Desktop 1.8.0 does not implement the new lifecycle events and
`session.titleContext` permission. Installing this plugin alone into an older
host is not a supported upgrade path. The host and plugin changes ship together.
The engine range is compatibility metadata, not a client-enforced version gate.
An older SDK rejects the unknown permission; its error may not mention the
required version. Upgrade the host first, then install the plugin.

## Settings

- **Generate session titles**: enabled by default. Disabling the plugin or this
  switch keeps the host's free first-prompt fallback only.
- **Title model**: native model picker, using configured ready chat models.
- **Thinking level**: defaults to `off`; an unsupported level becomes `off`.
- **Refresh titles after context compaction**: enabled by default. A new
  summarized checkpoint can update an automatic title as the subject changes.

The old Desktop `sessionTitle` preferences remain stored but inert. Configure
the model here; the plugin does not copy private host preferences or install
itself automatically. Existing titles and manual choices are never migrated or
deleted.

## Behavior and permissions

The plugin listens for `session:promptSent`, `session:turnEnded`, and
`session:compacted`. Naming always reads the first persisted request rather than
the latest message. Same-session work is serialized; a settled turn waits for a
running attempt before retrying a failure. First-title calls are capped at three
per session/model/thinking configuration per activation. A bounded 1,000-entry
retry cache may evict old sessions, and reload resets it. Successful compaction
refreshes are deduplicated per checkpoint in a separate 1,000-entry cache.

`session.autoTitle` supplies bounded first-turn context and a compare-and-set
update. `session.titleContext` adds bounded excerpts of that session's own pasted
text, reference names (not file contents), and the matching current compaction
summary. A stale checkpoint is rejected again before a refresh write. Manual
renames win every title race. Unloading or switching generation off prevents
late completions from writing titles.

`models.list` supplies the configured catalog. `agent.complete` sends only
naming material to the selected model through the host and consumes model quota.
The plugin has no file/network permissions, provider credentials, tools or full
transcript access. It keeps the user's language and caps titles at 80 Unicode
code points. Errors retain the fallback and log only operation metadata/error
codes, never request text or credentials.

This migration changes feature ownership, not the shared `agent.complete`
transport. It does not claim to fix an existing model connection problem.

## Development

```sh
node --test plugins/minih.session-titles/tests/*.test.mjs
```

The Desktop request worktree additionally covers permissions, bounded context,
real plugin-process event delivery and host-backed title writes.
