# minih.terminal — optional embedded terminal

An embedded terminal for Minih-Agent-Desktop: local interactive shells in tabs,
opened from an entry near the top of the left sidebar, rendered in the main
content area.

The terminal is a manual surface. It registers no Agent tool, agent extension,
MCP server, or prompt injection, and nothing it shows is attached to a chat,
logged, or uploaded.

## What it does

- Starts a real local shell from the profiles installed on this machine:
  PowerShell, `pwsh`, `cmd`, or Git Bash on Windows; the user's login shell,
  zsh, bash, or sh on macOS and Linux. The start form always shows the executable
  and the working directory before anything is spawned.
- Opens in the active local project directory, and offers the host's own folder
  picker or the home directory when that is not what you want. A path that does
  not exist on this machine (a remote project) is refused by name.
- Keeps terminals alive across chat switches, hiding the page, and minimizing the
  window. Closing a tab ends that terminal **and the jobs it started**: the close
  signals the shell's whole process tree and escalates, so it does not depend on
  the shell's own exit behaviour. A close that cannot confirm the process is gone
  is reported as a failure instead of claiming a cleanup that did not happen.
- Ends every terminal when the plugin is disabled, uninstalled, reloaded, or
  upgraded — and the host asks first: its confirmation names this plugin and how
  many shells are still running, and cancelling leaves every shell, the plugin,
  and the page exactly as they were. The same disclosure rides on the existing
  quit prompt.
- Handles search, copy/paste, resize, Chinese IME and wide characters, and the
  app's light/dark theme.

## What ships in this directory

`plugins/minih.terminal/` is the plugin **as it installs**: the host never runs
`npm install`, a compiler, or downloaded code when a user enables a plugin, so
the native module and the browser assets are committed here.

```text
manifest.json      sidebar-placed view, permissions, localized safety notes
main.js            panel-bridge channels; the plugin's whole public surface
lib/               PTY engine (bounded buffers, flow control, cleanup) and shell catalog
view/              the sandboxed page: xterm.js, tabs, search, copy/paste
view/vendor/       xterm.js 5.5.0 and its fit/search addons
vendor/node-pty/   node-pty 1.1.0 plus the per-platform prebuilt binaries
scripts/           refresh the vendored runtime, verify it in a real utility process
tests/             real-PTY, flow-control, per-shell cleanup, owner-death, packaging fixtures
```

## Rebuild the vendored runtime

```bash
cd plugins/minih.terminal
pnpm install          # once: xterm + node-pty dev dependencies
node scripts/build.mjs                 # refresh view/vendor + vendor/node-pty
node scripts/build.mjs --require-platforms darwin-arm64,darwin-x64,win32-x64,win32-arm64,linux-x64,linux-arm64
                                       # release gate: refuses (and writes nothing)
                                       # when a required platform has no asset
```

`build` prints the PTY platforms it carries and, when one is missing, says the
result is **a development build for a platform subset, not a three-platform
delivery**. Debug symbols (`.pdb`) and the legacy winpty shim are dropped; the
macOS `spawn-helper` keeps its executable bit, without which a spawn fails with a
bare `posix_spawnp failed`.

## Tests

```bash
node --test tests/*.test.mjs
```

They run against this directory as committed — no install needed, because the
tests use the vendored runtime, which is exactly what an installed plugin uses.
They cover: real PTY input/output/exit, resize reaching the shell, bounded
chunked reads, high-water pause/resume, Unicode that must not split, per-shell
job cleanup on close, owner-death on crash, the shell catalog, the packaging
selection fixtures, and the manifest decisions this repository publishes.

## Package and publish

Packages are store-only `.piplug` archives, built with the desktop project's own
packer so the format matches what the host extracts:

```bash
node ../../../Minih-Agent-Desktop/packages/plugin-devkit/dist/cli.js \
  pack . --out ../../packages
node ../../scripts/build-catalog.mjs      # regenerate catalog.json + releases.json
```

(The devkit CLI path depends on where the desktop checkout lives.) `pack` also
reports `permission.unused` for `clipboard.write`: the permission is used from the
page (`pluginBridge.invoke("clipboard.writeText")`), and the checker only scans
`main.js`.

## Platform delivery status

A package is only as complete as the native assets it carries. `node-pty@1.1.0`
publishes prebuilds for darwin (x64, arm64) and win32 (x64, arm64) and none for
Linux, so a build made on macOS or Windows carries four of the six targets.

| Platform | Assets here | Verification |
|---|---|---|
| darwin-arm64 | prebuild | **run** on the maintainer's machine: unit tests, real PTY, Electron utility process, owner-death |
| darwin-x64 | prebuild | **NOT RUN** — same binary family, no x64 machine |
| win32-x64, win32-arm64 | prebuild (conpty) | **NOT RUN** — no Windows machine |
| linux-x64, linux-arm64 | none in this build | **NOT RUN and NOT DELIVERABLE** from macOS/Windows |

A Linux build has to happen on Linux, because `node-pty` compiles there:

```bash
# on Linux, in plugins/minih.terminal
npm_config_build_from_source=1 pnpm rebuild node-pty   # writes node-pty/build/Release
node scripts/build.mjs                                 # packages build/Release as <platform>-<arch>
```

## Verify the native payload where it runs

The plugin backend is an Electron `utilityProcess`, not a plain `node` process,
so loading `node-pty` under `node` proves nothing about the installed plugin.
Point the check at the Electron binary the release is built against:

```bash
node scripts/verify-electron.mjs --electron <path to Electron>
```

It exits 0 only when the utility process loads the vendored `node-pty`, spawns a
real shell through it, receives that shell's output, and closes the terminal.

## Known limits

- A crash ends the shell because the PTY master closes with the process, which
  hangs up the session. Whether the shell's background jobs follow is the shell's
  own policy: bash and zsh resend SIGHUP to their jobs on exit, while a
  dash-like `sh` does not hang up its jobs, so on a crash such a shell can leave a
  background job behind. That is why the terminal starts the user's interactive
  shell rather than a bare `sh`, and why the guaranteed path is the explicit one:
  closing a tab or disabling the plugin signals the process tree. A guarantee that
  covers every shell on a crash would need a host-owned PTY, which the desktop
  ADR deliberately excluded.
- The interruption prompt is answered from memory at the moment it is asked. A
  terminal that exits between the prompt and the teardown is reported as finished,
  and a plugin that cannot answer within two seconds is treated as having nothing
  running.
- Scrollback is bounded (5000 lines per terminal) and there is no session
  persistence: a reloaded plugin starts with no terminals.
