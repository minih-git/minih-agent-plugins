# Background vault startup

Plugin readiness must not depend on a complete vault scan. Desktop waits for
`onLoad` before acknowledging initialization and imposes a 15-second deadline.

`onLoad` registers host-backed retrieval tools when required, then schedules
vault warm-up for the next event-loop turn and returns. Warm-up builds the
in-memory vault index and ontology before starting conversation sync and the
profile scheduler. This happens after installation, enablement, and each
application restart; no persistent index or format migration is introduced.

The first panel request that needs the vault shares the same initialization
promise and waits for real data. Settings channels that do not need the vault
remain independent. Failed scans are logged, clear the pending promise, and
can be retried by the next vault-dependent request.

Unload cancels a scheduled warm-up or aborts an in-flight scan, drains the
startup task, then stops timers and clears state. Directory traversal checks
cancellation between filesystem operations; note reads receive the abort
signal. An already pending filesystem stat or directory read still has to
return before its next cancellation checkpoint. Cancelled work cannot publish
state or start a syncer after unload.

Regression coverage: `tests/startup.test.mjs` exercises non-blocking readiness,
shared first access, cancellation before and during warm-up, reload, and retry
after a failed scan, using an isolated temporary vault and controlled promises.
