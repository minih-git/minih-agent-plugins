# Changelog

## 0.1.6

- The last terminal line no longer sits against the bottom edge: the terminal
  keeps a 14px safe area below its rows. The gap comes from the pane's box, not
  from its padding, because xterm sizes its rows from that box including padding
  and would overflow a padded pane.

## 0.1.5

- Selecting text is visible again in the light theme. The terminal theme handed
  xterm a `color-mix(...)` value for the selection; xterm parses its own colors
  and cannot read CSS functions, so it degraded to opaque white — white on a
  white background, i.e. no highlight at all. The palettes now use plain rgba,
  and a test keeps the terminal theme to values xterm can parse.

## 0.1.4

- Pasting with Cmd+V inserted the text twice. The page answered the keystroke and
  the app's Edit menu pasted it as well, so the shell received both. The page now
  leaves Cmd+V to the Edit menu and pastes only on Ctrl+Shift+V and from the
  right-click menu.
- Focus returns to the shell after the dialog or the menu closes, so Cmd+V has
  somewhere to land instead of a button that just handled a click.

## 0.1.3

- Copy and paste work on macOS again. The app's Edit menu owns Cmd+C / Cmd+V and
  its copy reads a DOM selection the terminal does not have, so macOS users could
  select text but never copy it. The pane now has its own right-click menu
  (Copy / Paste / Select all), copies with Ctrl+Shift+C and pastes with
  Ctrl+Shift+V, and a right-click no longer throws the selection away.
- `copyOnSelect` setting: copying as soon as text is selected, off by default.
- The plugin now also asks for `clipboard.read`, because pasting is a clipboard
  read and the previous permission set only allowed writing.

## 0.1.2

- The New terminal form is a dialog over the terminal instead of a block above
  it, so opening it no longer resizes the shell you are looking at. Escape, the
  backdrop, and Cancel all dismiss it.
- Opening the view starts a terminal with your defaults instead of asking first.
  Shell, working directory, and whether to auto-open are configured once in the
  plugin's settings; "Auto" keeps using the first shell found on the machine.
- With no terminal running the page shows a one-line empty state and a single
  button, rather than a form that has to be answered.

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
