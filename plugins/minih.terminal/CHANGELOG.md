# Changelog

## 0.1.0

- First release: sidebar-placed embedded terminal with tabs, search, copy/paste,
  resize, theme adaptation, and a start form that shows the real directory and
  shell.
- Closing a tab ends the shell's whole process tree; disabling, uninstalling,
  reloading, upgrading, or quitting asks the host for confirmation first.
- Ships `node-pty` 1.1.0 with darwin-arm64, darwin-x64, win32-x64 and
  win32-arm64 prebuilds; Linux needs a build on Linux.
