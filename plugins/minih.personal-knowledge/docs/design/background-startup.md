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

## View readiness (0.7.2)

`kg.status` returns immediately with `{ state, phase, completed, total, error? }`.
`state` is `loading`, `ready`, or `error`; `phase` is `discover`, `read`,
`services`, or `ready`. Progress counts files actually processed; it does not
promise cloud-download completion times. The first status call can request
`refresh: true`, which prepares the current index and optional learned-memory
satellites in the background. Later polls do not restart that work. A failed
attempt stays visible until a call explicitly sets `retry: true`.

The view bridge shares one readiness wait among concurrent vault-dependent
requests before starting each operation's normal 30-second RPC budget. Each
status call retains its own timeout; the healthy scan itself has no 30-second
view deadline. Loading remains real progress, errors remain errors, and an
installed view never replaces a host failure with fixture data. Standalone
previews without a bridge may still use labelled fixtures. Page teardown stops
polling. The graph reuses its prepared memory snapshot instead of repeating
the host calls inside the timed graph request.

The index reads at most eight files concurrently, forwards the abort signal to
reads, and drains the remaining readers before reporting the first error.
Traversal ordering is preserved when the batch finishes. The refresh throttle
starts at successful completion so a slow initial scan is not immediately
repeated. `kg.config.get` reads configuration independently; its note count is
`null` until a real index is available.

Regression coverage:

- `tests/startup.test.mjs`: non-blocking readiness, shared first access and
  index reuse, archive exclusions without configured ignore rules, cancellation
  before and during warm-up, reload, and recovery of conversation sync after a
  failed scan.
- `tests/mcp-startup.test.mjs`: real MCP subprocess handshake and discovery,
  responsive `ping` during a held scan, concurrent tool requests, and retry
  after an initialization error, using an isolated temporary vault.
- `tests/vault-loading.test.mjs`: responsive status/configuration during a held
  scan and memory preparation, persistent errors, explicit retry, and refresh.
- `tests/vault-progress.test.mjs`: bounded concurrent reads, cancellation and
  drain after failure, accurate progress, and completion-based throttling.
- `tests/view-loading.test.mjs`: shared readiness beyond 30 seconds, independent
  configuration, preserved operation timeouts, explicit recovery, disconnection,
  and disposal without stale results or polling timers.
