# Changelog

## 0.1.1

- Start shells as login shells on macOS and Linux. `~/.zprofile` and
  `~/.profile` are read by login shells only, and a GUI-launched app inherits
  launchd's `/usr/bin:/bin:...` instead of the PATH the user's own terminal
  has, so the first `fnm`/`brew`/`nvm` line in `~/.zshrc` used to fail with
  "command not found".
- The start form now leaves the page once a shell is running. An author
  `display` rule outranked the `hidden` attribute, so the form kept its box,
  stayed visible next to the terminal, and squeezed the panes into the bottom.

## 0.1.0

- First release: sidebar-placed embedded terminal with tabs, search, copy/paste,
  resize, theme adaptation, and a start form that shows the real directory and
  shell.
- Closing a tab ends the shell's whole process tree; disabling, uninstalling,
  reloading, upgrading, or quitting asks the host for confirmation first.
- Ships `node-pty` 1.1.0 with darwin-arm64, darwin-x64, win32-x64 and
  win32-arm64 prebuilds; Linux needs a build on Linux.
