# Knowledge routing

## Where each kind of knowledge belongs

Preferences and corrective feedback live in Desktop learned memory, not in the
vault. Each kind of knowledge has exactly one authority (ADR 0001 §9):

| Knowledge | Authority | How it reaches a session |
| --- | --- | --- |
| Hard rules for every task | `AGENTS.md` | System prompt |
| Preferences and corrective feedback | Desktop learned memory (`MemoryRemember`, memory manager) | Session-start index and `MemorySearch` |
| Projects, topics, environments, decisions, events, procedures | Obsidian vault | `knowledge_context` on demand |
| Loose facts and references not yet part of a note | Learned memory, promoted to the vault when mature | Index and `MemorySearch` |
| Conversation evidence | Desktop transcripts | Session history search |

Knowledge moves in one direction: a mature `fact` or `reference` memory is
promoted into a vault note (the Knowledge Universe view drafts it under
`00 Inbox/`); vault content is never copied back into memory. Do not create new
preference notes in the vault; `02 Areas/领域 - 个人开发与协作偏好.md` is dated
history pending migration, not a destination.

## Canonical destinations

| Knowledge type | Canonical destination |
| --- | --- |
| Common technology stacks, tools, and validation habits | `03 Resources/Engineering/资料 - 技术栈与工程工具.md` |
| Project catalog | `01 Projects/项目总览.md` |
| Project introduction and stable boundary | `01 Projects/项目 - <name>.md` |
| Detailed project architecture | `01 Projects/<name>/` |
| Accepted decisions | project decision note plus `01 Projects/决策索引.base` |
| Server ownership and deployment inventory | `03 Resources/Deploy/资料 - 服务器资产与部署清单.md` |
| EasyTier topology | `03 Resources/Deploy/资料 - EasyTier 网络拓扑与节点清单.md` |
| General knowledge conventions | `08 Standards/知识库规范.md` |
| Knowledge review dashboard | `08 Standards/知识库仪表盘.base` |

## Minimum metadata

Use these properties for durable knowledge when applicable:

- `updated`: last content change date.
- `verified`: last date the claimed fact was actually checked.
- `verification_scope`: `source`, `runtime`, `user-confirmed`, or a clear combination.
- `stability`: `stable`, `mixed`, `volatile`, or `historical`.
- `review_interval`: `monthly`, `quarterly`, `on-change`, or `none`.
- `project`: wikilink to the canonical project overview for project topic notes.

Do not treat `updated` as proof that a fact was verified. A source-code check does not prove current production runtime state.

## Durable versus transient

Write durable knowledge:

- explicit user preferences and repeated working agreements;
- repo identity, purpose, boundaries, technology choices, and stable commands;
- accepted architecture or product decisions;
- verified deployment topology, ownership, and reusable runbooks;
- recurring failure patterns with proven causes and fixes.

Do not persist as stable truth:

- current online/offline state without a verification date;
- one-time command output, latency, disk usage, traffic, or test counts;
- speculative diagnoses or plans not yet accepted;
- current versions, prices, laws, or provider behavior without a dated source;
- secrets or authentication material.

## Storage rules (ADR 0001 §4)

1. An entity note states what is true now and may be edited in place.
2. An event note records one dated event. After the event closes it is only
   appended to, and it links to its entities through `project` and `affects`.
3. An entity note above 24,000 characters is a defect. Its dated logs move to
   event notes, and the entity keeps a summary plus links.
4. Typed relations go in frontmatter. Body wikilinks remain weak links.
5. Each fact has one authority (see the table above). Other places link to it.

## Update rules

- Keep one canonical fact source and link to it elsewhere.
- Preserve disagreement or history with dates instead of overwriting silently.
- Use `status`, `updated`, `verified`, or dated sections to show freshness.
- Prefer a concise project introduction plus linked deep notes over one oversized document.
- Review `volatile` knowledge monthly or immediately before an operation, and `mixed` knowledge quarterly or after a major redesign.
- Use the knowledge dashboard to find active notes that are missing verification or are past their review window.
