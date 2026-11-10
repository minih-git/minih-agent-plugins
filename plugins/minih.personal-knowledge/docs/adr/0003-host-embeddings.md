# ADR 0003: Embeddings from the app's own models, and what the panel says first

- Status: Accepted (2026-11-10); published as 0.6.0
- Plugin: `minih.personal-knowledge`, 0.6.0
- Related (Minih-Agent-Desktop): `plugin-embeddings` ADR (Desktop 1.5.0),
  `docs/spec/07-plugins/03-plugin-api.md` § embeddings, permission
  `embeddings.run`
- Depends on: ADR 0001 (ontology, hybrid retrieval), ADR 0002 (conversation
  archive)

## Context

The vector channel could only reach an endpoint the user configured by hand:
provider, base URL, model name, and the *name* of an environment variable
holding the key. A user who already configured an embedding model in Desktop —
their router serves one — had to copy the URL and export the key again in their
shell, and the plugin never saw the provider credentials by design.

This ADR records the plugin side of using the app's own model, and the second
half of the same complaint: the panel reported the remote-address guard as an
English error after a click, which reads as "it failed before I did anything".

The host side (`pi.embeddings.embed`, `models.list` with a `kind`) is developed
in parallel against the plan; this ADR fixes the plugin's assumptions so the two
halves can be checked against each other.

## Decision

### 1. A third provider: `host`

`embedding.json` gains `provider: "host"` with `modelKey`
(`${providerId}/${modelId}`). In that mode `baseUrl`, `apiKeyEnv`, and
`allowRemote` are not used, not validated, and not stored; `model` follows the
model part of the key. **An existing file without `modelKey` keeps behaving
exactly as before** — the default stays the local Ollama, so nobody's vectors
change because the plugin learned a new mode.

`EmbeddingClient` grows a host branch:

- `pi.embeddings.embed({ modelKey, texts })`, 64 texts per call (the host limit)
  and 8 KiB per text; an oversized text is refused locally rather than sent.
- Vectors are L2-normalized like every other channel, so the index file format
  and the cosine search stay uniform.
- Host error codes map onto the reasons the plugin already reports:
  `MODEL_NOT_FOUND`→`MODEL_MISSING`, `MODEL_NOT_EMBEDDING`→`MODEL_NOT_EMBEDDING`,
  `UNSUPPORTED_PROVIDER`→`EMBEDDING_UNSUPPORTED_PROVIDER`,
  `PROVIDER_UNAUTHORIZED`→`EMBEDDING_AUTH_FAILED`,
  `PROVIDER_RATE_LIMITED`/`RATE_LIMITED`→`EMBEDDING_RATE_LIMITED`,
  `NETWORK_ERROR`→`EMBEDDING_UNREACHABLE`, `INVALID_ARGUMENT`→
  `EMBEDDING_CONFIG_INVALID`, `TIMEOUT` and anything unknown→`EMBED_FAILED`.
  The host code is kept as `error.hostCode` for the details view.
- The index identity becomes `host:<modelKey>` (dimensions appended as before),
  so switching the model invalidates the index exactly as switching a local
  model does.

### 2. Who computes a vector, and why

`pi` exists only in the plugin's main process. The MCP server is a separate
child process that Desktop spawns with a minimal environment (`PI_PLUGIN_ID`
plus a PATH-style allowlist) and talks to the host over stdio JSON-RPC; there
is no host bridge in it. The authentication token file that already sits next to
the skills is a Desktop-side channel for *plugins calling the desktop*, not a
path from an MCP child back into `pi`.

So the tools moved rather than inventing an IPC surface. `pi.agent.registerTool`
registers a tool that **runs in the plugin main process**, which is the one
place that holds `pi.embeddings`:

- **Host mode**: the main process registers `knowledge_search` and
  `conversation_search` as agent tools, computes the query vector with
  `pi.embeddings.embed`, and answers through the same `KnowledgeService`, the
  same index, and the same vector file the MCP server uses.
- **Other providers** (Ollama, OpenAI-compatible): nothing is registered. The
  MCP server answers both tools because it can embed its own queries.
- **The MCP server withholds them in host mode.** It reads `embedding.json` at
  startup (the same file, the same validator) and, when the provider is
  `host`, leaves both tools out of `tools/list`; a `tools/call` for either name
  answers with an error that says where the tool now lives. Names differ anyway
  (`plugin_<id>_<tool>` versus `plugin_<id>_<serverId>_<tool>`), but the point
  is that the model should not have to choose between a vector-less copy and a
  good one.
- **The switch is not instant on the MCP side.** The host reads `tools/list`
  once per MCP connection and ignores `notifications/tools/list_changed`, and no
  plugin API restarts that connection. Entering host mode registers here at
  once while the MCP copies linger until the plugin or the app is reloaded;
  leaving it keeps the registered tools until that reload, because removing
  them while the MCP server still withholds them would leave the agent with no
  retrieval tool at all. The panel says so after such a save, and the rule it
  follows is "a duplicate is tolerable, a gap is not".
- One index, two writers, still safe: `ensureVectors` never runs for a host
  model in a process without `pi.embeddings` (`#cannotEmbedHere`), so the MCP
  side only reads what the main process wrote and never reports the other
  side's absence as its own failure. A search reloads the on-disk rows when
  this process has none, so a vector written a moment ago is used.

The identity comparison had to learn the second shape: a host identity is
`host:<modelKey>|dims` (two parts) where a direct endpoint has
`provider|baseUrl|model|dims` (four). Comparing "everything before the
dimensions" handles both.

Registering a tool needs `agent.tool.register`, which this version does not
declare yet (§4): the tools stay unregistered on a host that has not granted
it, and the MCP server still lists its own copies (it only withholds them when
the provider is `host`), so the agent keeps a working, if purely lexical,
retrieval tool.

The visible consequence, stated so it is not a surprise: in host mode the
ranked search inside an agent session is only as fresh as the last index pass
by the main process. `kg.index.status` shows the pending count, and a settings
change or a panel open triggers one in the background.

### 3. The panel explains before it sends

- While a base URL is typed, `inspectEndpointForm` decides the state: a
  non-loopback address without `allowRemote` is a hint that highlights the
  checkbox; a non-https remote address is a hint too. Save and Test do not send
  a request in either state; they focus the control the message is about.
- An empty address is not an error yet. A malformed one is explained, not
  shouted.
- Every `EMBEDDING_*` / `OLLAMA_*` code the backend can return has a sentence in
  both languages (`embedReason*`); the panel shows the sentence and keeps the
  code in the element's `title`. The same applies to `settingsError` on load.
- In host mode the endpoint fields disappear and a model dropdown appears
  (`kg.models.listEmbedding`, which passes `kind: "embedding"`). An empty list
  explains where to add a model; a host without `pi.embeddings` disables the
  option and names Desktop 1.5.0.

### 4. Permissions and versions

`embeddings.run`, `agent.tool.register`, and `engines.minihAgent >= 1.5.0` are
**not** declared yet.
Declaring an unknown permission makes today's hosts refuse the manifest, so P1
ships the code and the panel with the host option disabled on a host that
cannot honour it; P2 flips the manifest once Desktop 1.5.0 is published.

### 5. Batches and the call budget

`splitHostBatches` cuts on the host's three limits at once — 64 entries, 8 KiB
per text (UTF-8 bytes, so a CJK character costs three), 256 KiB per call — and
drops blank texts, which the host refuses and which carry nothing to embed. A
full page of maximum-size texts therefore becomes two calls, not one.

Calls are spaced so at most 120 start in any minute. A `RATE_LIMITED` or
`PROVIDER_RATE_LIMITED` answer is transient: the call backs off linearly and
retries up to four times before the run reports
`EMBEDDING_RATE_LIMITED`. Other errors are never retried.

## Consequences

- An existing install keeps the local Ollama; nothing changes until the user
  picks "use a model from the app".
- A host model spends the user's quota. The panel says that next to the
  dropdown, and the existing remote-send confirmation still applies on the
  first save.
- Agent-time vector search in host mode is eventually consistent: it catches up
  after the main process has embedded the changed chunks.
- The MCP server never needs a new host API, so no companion change is required
  on Desktop beyond `pi.embeddings.embed` itself.

## Open points for the Desktop side

- `models.list({ kind: "embedding" })` must actually filter; the plugin filters
  again on its side for a host that ignores the argument.
- The limits are the published ones (64 texts, 8 KiB per text, 256 KiB per
  call, all UTF-8 bytes; 120 calls per minute). The plugin splits on all three
  and spaces its calls inside the allowance; a host that tightens them should
  say so in the error, which is reported verbatim.
- A host that reports `dims` per call lets the plugin size its index; the plugin
  currently takes the first vector's length and validates every later batch
  against it.
