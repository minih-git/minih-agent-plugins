# Changelog

## 0.1.2

- Publish through the existing Minih plugin marketplace for Minih 1.1.3+ on Apple Silicon macOS, retaining the explicit trusted-code grant and app approval flow.

- Persist Always allow through LCU's existing owner-authenticated app CLI, then verify the canonical inventory before accepting.
- Reuse session approval across turns without leaking it to another session; do not remember Allow once, denial or dismissal.
- Read permanent grants afresh so external revocation takes effect; keep protected-host and offered-scope restrictions ahead of reuse.
- Report authentication/save failures instead of pretending grants were remembered, and cancel the authentication process tree on Stop or unload.
- Cover persistence, reload, revocation, concurrency, malformed app IDs, save failures and cancellation with protocol and real-runner regressions.

## 0.1.1 (local-only)

- Fix first-turn discovery by registering the upstream surface during extension loading, before Desktop snapshots the catalog.
- Make `LCU`, `cua_repl` and exact tool names searchable, and inject a short tool-name/discovery guide alongside original instructions without adding permissions.
- Bound cold startup below Desktop's factory timeout and close failed connections without publishing placeholder tools.
- Add a regression through the real Desktop runtime, local SSE provider, ToolSearch, image delivery and turn cleanup. Version 0.1.0 fails the same first-directory assertion.

## 0.1.0 (unreleased, local-only)

- Package the pinned LCU Pi adapter as a trusted Minih Agent extension for Apple Silicon macOS.
- Adapt prompt returns, error turn endings, startup cancellation and private Stop to Desktop.
- Preserve original tool schemas, screenshots, errors and user approvals; block control of Minih itself.
- Bundle runtime dependencies and retain source hashes and third-party licenses.
- Cover the protocol boundary and the real Minih extension runner without using a live desktop or model.

Versions 0.1.0 and 0.1.1 were local-only; 0.1.2 is the first marketplace release.
LCU runtime installation and real desktop acceptance remain separate.
