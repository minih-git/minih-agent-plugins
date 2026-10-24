---
name: obsidian-knowledge
description: Retrieve and maintain the user's Obsidian knowledge when work depends on existing projects, preferences, decisions, or infrastructure. Save confirmed durable changes; skip self-contained tasks that need no prior context.
---

# Obsidian Knowledge

Use the vault configured in the Personal Knowledge plugin settings (default `~/Documents/Knowledge`). This skill owns the retrieval and write-back workflow; the Personal Knowledge plugin supplies its MCP tools.

## Retrieve enough context

1. Reuse relevant notes already read in this task unless the topic or evidence has changed. Otherwise call `knowledge_context` with the actual working directory and a narrow topic when its MCP tool is available. Start with a modest response budget, such as `maxChars: 6000`; this is a starting point, not a hard cap.
2. Prefer canonical and exact project or decision notes over indexes and historical summaries. A complete note returned by context is sufficient for reading; call `knowledge_read` only for missing or truncated relevant content, freshness needs, or a pending write. Use `knowledge_search` for specific unresolved names or questions.
3. Stop when the context supports the task. A narrow search with no relevant matches is a valid result; expand only when missing knowledge could change a material decision. Do not load unrelated history or follow every link returned by a broad route.
4. Verify drift-prone claims that affect the current conclusion or operation against code, runtime, or current external evidence. A source check does not prove production state. Briefly identify material reliance on notes that were not live-verified.

If MCP retrieval is unavailable or fails, use `scripts/search-vault.sh` with a few narrow keywords or `rg` against exact vault paths. If knowledge remains unavailable, continue work that does not depend on it and explain any material limitation; pause only the decisions that require the missing facts. Do not repeatedly retry an unchanged failure.

## Write only useful changes

The user authorizes ongoing maintenance of confirmed, durable personal or project facts: changed preferences, stable boundaries or technology choices, accepted decisions, assets and topology, and reusable validated workflows. Do not write duplicates, speculation, generic advice, transient logs or measurements, or unaccepted proposals. An unchanged fact needs no rewrite or date refresh.

When there is an information delta:

1. Find the canonical destination and update it rather than create a duplicate. Read `references/routing.md` when destination or metadata is unclear. Current user instructions take precedence; retain meaningful prior decisions with dates and sources.
2. Preserve frontmatter, unrelated content, and wikilinks. Refresh `updated` for content changes; set `verified` and `verification_scope` only for claims actually checked. A partial check must not imply that the whole note was reverified. Keep stable facts separate from dated snapshots and use applicable stability metadata from the routing reference.
3. Immediately before a MCP write, read the target and keep its SHA-256. Prepare the full replacement, pass the hash to `knowledge_write`, inspect `dryRun: true`, then apply `dryRun: false`. For new notes use `create: true`. On a stale hash, reread and reconcile rather than overwrite.
4. Read back the changed note and check relevant links or index discoverability. Add an index link when needed, not as a reason to rewrite unrelated indexes.

When MCP writing is unavailable, use a safe filesystem edit of the exact note, checking for concurrent changes and preserving a backup for material rewrites. A permission or safety rejection is not authorization to bypass it with another tool. Do not bulk-rewrite the vault without explicit user authorization.

## Security

Never store or echo passwords, private keys, tokens, cookies, recovery codes, or complete credentials. Record only safe credential locations, owners, and retrieval or rotation procedures. Avoid exposing secrets encountered during retrieval in outputs or artifacts.
