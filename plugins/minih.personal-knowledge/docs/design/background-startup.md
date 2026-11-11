# Background vault startup

Plugin readiness must not depend on a complete vault scan. Desktop waits for
`onLoad` before acknowledging initialization and imposes a 15-second deadline.
MCP connection setup has its own shorter deadline.

`onLoad` registers host-backed retrieval tools when required, then schedules
vault warm-up for the next event-loop turn and returns. A shared initialization
promise builds the in-memory index and ontology, starts conversation sync and
the profile scheduler, and only then publishes the ready state. The next
vault-dependent panel request or manual conversation sync retries this entire
sequence after a failure, so recovering note access also restores the timers.
Settings channels that do not need the vault remain independent.

The shared `VaultIndex` applies `archiveConfig` from the conversation layout:
`09 Conversations/_raw` and `09 Conversations/_daily` are always excluded,
including when an existing user configuration does not list them. L2 summaries
remain indexed. No user configuration or archived file is rewritten for this
rule.

Concurrent panel channels share one service initialization promise. The service
reuses the already initialized view index and ontology; failed service setup
clears the pending promise for a later retry. The MCP process owns a separate
index because it is a separate process, but creates its service only for the
first tool invocation. `initialize`, `tools/list`, and `ping` do not wait for a
vault scan. Concurrent tool calls share initialization; failures return an MCP
tool error and the next invocation can retry. Host-backed retrieval ownership
and the read-only write guard are preserved.

Unload cancels a scheduled warm-up or aborts an in-flight scan, drains startup
and service initialization, then stops timers and clears state. Directory
traversal checks cancellation between filesystem operations; note reads receive
the abort signal. An already pending filesystem stat or directory read still
has to return before its next cancellation checkpoint. Cancelled work cannot
publish state or start a syncer after unload. No persistent index or format
migration is introduced.

Regression coverage:

- `tests/startup.test.mjs`: non-blocking readiness, shared first access and
  index reuse, archive exclusions without configured ignore rules, cancellation
  before and during warm-up, reload, and recovery of conversation sync after a
  failed scan.
- `tests/mcp-startup.test.mjs`: real MCP subprocess handshake and discovery,
  responsive `ping` during a held scan, concurrent tool requests, and retry
  after an initialization error, using an isolated temporary vault.
