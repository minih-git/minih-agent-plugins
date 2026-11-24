# Changelog

## 0.1.0

- Move model-composed session titles out of the Desktop core into an optional plugin.
- Add native model, thinking-level, enable and compaction-refresh settings.
- Preserve first-prompt fallback, manual-title compare-and-set protection, bounded paste input and checkpoint refreshes.
- Serialize same-session requests, bound failed first-title attempts and discard late results on disable/unload.
- Require explicit `session.autoTitle`, `session.titleContext`, `models.list` and `agent.complete` grants.
