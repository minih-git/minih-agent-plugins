# LCU Computer Use for Minih

A **Minih 1.1.3+, Apple Silicon macOS** plugin that adapts the LCU Pi extension to
Minih-Agent-Desktop. It does not implement a second computer-use engine or
redistribute the official ChatGPT app or its runtime.

## Prerequisites

- Apple Silicon macOS. This version rejects Windows, Linux and Intel Macs.
- The official, signed ChatGPT app, with its required Accessibility and Screen
  Recording permissions granted by the user.
- LCU installed at `~/.local/share/lcu/current/bin/lcu`.
- A Minih version supporting trusted Agent extensions, session IDs, prompt return
  values, interactive selection and operation cancellation. Tests against current
  Desktop source do not verify an older installed application.

Adapter source is pinned to LCU commit
`7fbf748f69dacc8c8d2a634a45f7d3df14866908` in `vendor/upstream.json`. Compatibility
still depends on the locally installed LCU and ChatGPT versions.

## Install

1. Follow upstream `docs/INSTALLATION.md` to download a `darwin-arm64` release,
   verify its matching SHA-256 file and extract it.
2. From that release, install only the runtime:

   ```sh
   ./scripts/install.sh --runtime-only
   ~/.local/share/lcu/current/bin/lcu doctor
   ```

   Complete the upstream permission guidance yourself. `doctor` can probe the
   desktop; run it only when you intend to verify desktop access. Do not disable
   security checks or run `lcu setup --agent pi` for Minih: that registers Pi CLI.
3. In Minih 1.1.3+, open **Extensions → Marketplace**, search **LCU Computer Use**
   (or `minih.lcu`), and install version **0.1.2**. Review and explicitly grant
   `agent.extension`, which runs trusted code inside the Agent process. A local
   `minih.lcu-0.1.2.piplug` import or **Load Development Plugin** remains available.
4. Enable the plugin for the intended project and start a **new Agent session**.
   Existing sessions can retain the old extension module and tool catalog.
5. Ask LCU to screenshot a non-sensitive target window without input. Approve the
   original app request yourself. After that succeeds, test an explicitly
   authorized desktop action and Minih's normal Stop control.

The plugin does not install dependencies automatically. Successful installation
and fixture screenshots are not real desktop acceptance. Actual screenshots can
reach the selected model/provider; do not use sensitive windows casually.

For a different LCU location, set the upstream variable in the Agent environment:

```sh
export LCU_MCP_COMMAND='["/absolute/path/to/lcu"]'
```

The executable path must be absolute. Arguments are passed directly, never
through a shell; `~`, shell variables and pipes are not expanded. Finder-launched
applications may not inherit terminal exports. Prefer the default install path.

## Behavior contract

- Register the original `js` and `js_reset` schemas during extension loading,
  **before Desktop snapshots the first tool catalog**. Preserve the original
  descriptions after a searchable `LCU computer use` / `cua_repl` prefix. Internal
  `turn_ended` and module-directory tools are not model-visible.
- Return original runtime instructions plus a short LCU discovery guide through
  Desktop's prompt result on each turn. It maps LCU and `cua_repl` to `js` and
  `js_reset`, and directs ToolSearch to activate them. No separate Skill or
  additional permission is required. Never rely on mutating prompt-options input.
- Bound cold connection startup below Desktop's factory budget. Close failed
  startup connections and publish no placeholder tools. With a valid upstream
  surface cache, register its descriptors immediately and connect on first use.
- Preserve original image bytes, text and tool-error behavior.
- Use the real host session ID and the upstream adapter's per-agent-run turn ID.
  Model rounds share that turn; separate sessions have separate clients.
- Map completion to `Stop`, abort/error to `Interrupt`. Failed cleanup remains
  pending and must be retried before the next desktop action.
- Forward app/site consent without treating Minih's auto mode as blanket app approval.
  Allow once is never remembered; session consent is scoped to this extension's
  session; Always allow is saved and verified through the original LCU app CLI.
- Refuse control of Minih (`org.hmini.agent`) and upstream protected hosts. Refuse
  `LCU_ALLOW_AGENT_HOST_APPROVAL=1`.
- Honor operation cancellation and close connections on shutdown.

`/lcu stop` forwards the original private per-app Stop action during an active
turn. `/lcu pick` is explicitly unavailable because Desktop's editor extension
API is incomplete; name the target in your message. Chrome and audio are not
enabled or accepted as tested features by this version.

## App approvals

Choose **Always allow** only for apps you want every LCU session to control.
The plugin invokes `lcu apps allow <exact-bundle-id>` and the original owner
authentication prompt (Touch ID or account password). It returns permanent
acceptance only after `lcu apps --json` confirms the saved entry. Authentication
cancel/failure and missing or corrupt inventory stay observable and grant no
access for that request. Existing grants are read again for every approval;
no second permanent whitelist is created or silently restored after revocation.

**Allow for this session** is reused across turns but not other sessions or
extension reloads. Allow once, Decline and dismissal are never cached. Original
forbidden-app and offered-scope checks run before any remembered grant is reused.
Browser-origin prompts are unchanged. Minih's auto mode does not select consent.

Review or revoke permanent access using the existing LCU owner-authenticated CLI:

```sh
~/.local/share/lcu/current/bin/lcu apps --json
~/.local/share/lcu/current/bin/lcu apps revoke com.example.app
```

Upgrading does not replay historical Always-allow clicks. If an earlier version
never saved the grant, select it once again and complete owner authentication.

## Source and checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run verify:host -- /absolute/path/to/Minih-Agent-Desktop
npm run verify:discovery -- /absolute/path/to/Minih-Agent-Desktop
npm run verify:marketplace -- /absolute/path/to/host-core /absolute/path/to/catalog.json /absolute/path/to/Minih-Agent-Desktop
pi-plugin check .
pi-plugin pack . --out /absolute/path/to/local-packages
```

Dependencies are needed only when building from source. `agent/index.mjs` bundles
14 runtime dependencies; plugin installation needs no npm, network or compiler.
`agent/build.json` records its checksum and dependencies. The build verifies
vendored hashes and generates `THIRD_PARTY_NOTICES.md` from bundled licenses.

`vendor/lcu` retains upstream files unchanged. Guarded build adaptations in
`scripts/desktop-adapter.mjs` propagate startup/operation cancellation and make
starting transports visible to `close()`. This is not a byte-identical upstream
bundle. `src/extension.mjs` owns early registration, searchable descriptions,
discovery guidance, error-end mapping, host protection and command compatibility.

Tests run the final bundle against a local MCP fixture, covering schemas,
instructions, images/errors, approval/denial/dismissal, protected hosts, cleanup
retry, private Stop, cancellation, child exit and bounded startup. The host check
uses the real `TrustedExtensionRunner` for session isolation and permanent
consent/save/reload/revocation. Authorization tests keep all grants in scratch
and mock only the CLI/native authentication edge; no real grant is changed.

The discovery regression uses the real `DesktopAgentRuntime` and a local SSE
provider: the first request must advertise both LCU tools; `LCU`, `cua_repl` and
`js` searches must activate them; a screenshot must reach the next model request;
normal completion must send Stop. The same initial-directory assertion fails on
0.1.0. These checks do not launch Electron, call a paid model or control a desktop.

## Distribution and licensing

Version 0.1.2 is distributed through this project's existing marketplace catalog,
with SHA-256 verification and an explicit `agent.extension` grant. The catalog's
first-party badge identifies the maintainer; it is not a publisher signature or
an exemption from app/site consent. Signing support remains a future host feature.
The dependency and operating-system prerequisites above apply to marketplace and
local installs alike.

LCU is MIT licensed, copyright Amont Labs; see `vendor/lcu/LICENSE`. This wrapper
is MIT licensed; see `LICENSE`. Dependencies retain their own notices. OpenAI app
binaries, runtime packages and instructions remain subject to their own terms and
are obtained from the user's local installation, not included in the plugin.

Upstream: https://github.com/amontlabs/lcu
