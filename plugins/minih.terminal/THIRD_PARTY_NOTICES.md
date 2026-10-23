# Third-party notices

This plugin bundles the following packages, unmodified, so that enabling it needs
no install step or download:

| Package | Version | License | What is bundled |
|---|---|---|---|
| [`node-pty`](https://github.com/microsoft/node-pty) | 1.1.0 | MIT | `vendor/node-pty` — its `lib/` plus the published prebuilt binaries for darwin-arm64, darwin-x64, win32-x64 and win32-arm64. Debug symbols and the legacy winpty shim are dropped; `conpty/` (the console host) is kept. |
| [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) | 5.5.0 | MIT | `view/vendor/xterm.js`, `view/vendor/xterm.css` |
| [`@xterm/addon-fit`](https://github.com/xtermjs/xterm.js) | 0.10.0 | MIT | `view/vendor/addon-fit.js` |
| [`@xterm/addon-search`](https://github.com/xtermjs/xterm.js) | 0.15.0 | MIT | `view/vendor/addon-search.js` |

Each package keeps its own license text inside its published distribution; the
prebuilt `node-pty` binaries are the ones `node-pty` itself publishes for those
platforms, not locally compiled artifacts.
