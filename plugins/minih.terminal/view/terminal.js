/**
 * Terminal page.
 *
 * A contributed view page: sandboxed, no Node, and no Electron IPC. Every byte
 * of shell I/O crosses the sender-bound `window.pluginBridge`, which only ever
 * reaches this plugin's own backend. Nothing here talks to another plugin channel
 * and nothing opens a socket.
 *
 * Flow control is pull-based on the page side: one `terminal.read` is in flight
 * per terminal, and the next one is only sent after xterm's `write` callback has
 * parsed the previous chunk. Combined with the backend pausing the PTY above its
 * high-water mark, a fast producer slows the child down instead of losing output.
 */
(() => {
  "use strict";

  const bridge = window.pluginBridge;
  const COPY = {
    en: {
      newTerminal: "New terminal",
      workingDirectory: "Working directory",
      shell: "Shell",
      start: "Start",
      cancel: "Cancel",
      choose: "Choose…",
      close: "Close terminal",
      search: "Search output",
      next: "Next match",
      previous: "Previous match",
      stopped: "stopped",
      exitCode: "exit {{code}}",
      openFailed: "The terminal could not start.",
      copyFailed: "Could not copy the selection.",
      noShells: "No supported shell was found on this machine.",
      noBridge: "This page only runs inside Minih-Agent-Desktop.",
      tabs: "Terminals",
      emptyHint: "No terminal is running.",
      copy: "Copy",
      paste: "Paste",
      selectAll: "Select all",
      pasteFailed: "Could not paste.",
    },
    "zh-CN": {
      newTerminal: "新建终端",
      workingDirectory: "工作目录",
      shell: "Shell",
      start: "启动",
      cancel: "取消",
      choose: "选择…",
      close: "关闭终端",
      search: "搜索输出",
      next: "下一个匹配",
      previous: "上一个匹配",
      stopped: "已停止",
      exitCode: "退出码 {{code}}",
      openFailed: "终端未能启动。",
      copyFailed: "无法复制所选内容。",
      noShells: "本机未找到受支持的 shell。",
      noBridge: "此页面只能在 Minih-Agent-Desktop 内运行。",
      tabs: "终端",
      emptyHint: "当前没有运行中的终端。",
      copy: "复制",
      paste: "粘贴",
      selectAll: "全选",
      pasteFailed: "无法粘贴。",
    },
  };

  const state = {
    locale: "en",
    platform: "darwin",
    profiles: [],
    home: "",
    workspace: null,
    startDir: "",
    startProfile: "",
    tabs: [],
    activeId: null,
    sequence: 0,
    /** Terminal the open context menu acts on. */
    menuTab: null,
    /** Text the open context menu would copy. */
    menuText: "",
    /** Shell, directory, and auto-open, from the plugin's own settings. */
    defaults: { profileId: null, directory: null, openOnView: true, copyOnSelect: false },
  };

  const elements = {
    tabs: document.getElementById("tabs"),
    panes: document.getElementById("panes"),
    modal: document.getElementById("modal"),
    backdrop: document.getElementById("modal-backdrop"),
    empty: document.getElementById("empty"),
    emptyHint: document.getElementById("empty-hint"),
    emptyStart: document.getElementById("empty-start"),
    start: document.getElementById("start"),
    startDir: document.getElementById("start-dir"),
    startShell: document.getElementById("start-shell"),
    startError: document.getElementById("start-error"),
    startRun: document.getElementById("start-run"),
    startCancel: document.getElementById("start-cancel"),
    chooseDir: document.getElementById("choose-dir"),
    newTerminal: document.getElementById("new-terminal"),
    search: document.getElementById("search"),
    searchInput: document.getElementById("search-input"),
    status: document.getElementById("status"),
    contextMenu: document.getElementById("context-menu"),
    menuCopy: document.getElementById("menu-copy"),
    menuPaste: document.getElementById("menu-paste"),
    menuSelectAll: document.getElementById("menu-select-all"),
  };

  function t(key, values) {
    const catalog = COPY[state.locale] ?? COPY.en;
    const template = catalog[key] ?? COPY.en[key] ?? key;
    if (!values) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  }

  function invoke(channel, payload) {
    if (!bridge?.invoke) return Promise.reject(new Error(t("noBridge")));
    return bridge.invoke(channel, payload);
  }

  function message(error) {
    const text = error?.message ? String(error.message) : String(error ?? "");
    // The backend answers with a coded message; the prefix is noise for a user
    // who can act on the sentence after it.
    return text.replace(/^(PTY_UNAVAILABLE|CWD_MISSING|PROFILE_MISSING|NO_PROFILE|TOO_MANY_TERMINALS|CLOSE_FAILED|CLOSE_TIMEOUT|UNSUPPORTED|INVALID_ARGUMENT|NOT_FOUND|DISPOSED):\s*/, "");
  }

  function showStatus(text) {
    elements.status.textContent = text;
    elements.status.hidden = !text;
  }

  function applyCopy() {
    document.documentElement.lang = state.locale;
    elements.newTerminal.title = t("newTerminal");
    elements.newTerminal.setAttribute("aria-label", t("newTerminal"));
    elements.tabs.setAttribute("aria-label", t("tabs"));
    document.getElementById("start-title").textContent = t("newTerminal");
    document.getElementById("start-dir-label").textContent = t("workingDirectory");
    document.getElementById("start-shell-label").textContent = t("shell");
    elements.chooseDir.textContent = t("choose");
    elements.startRun.textContent = t("start");
    elements.startCancel.textContent = t("cancel");
    elements.emptyHint.textContent = t("emptyHint");
    elements.emptyStart.textContent = t("newTerminal");
    elements.menuCopy.textContent = t("copy");
    elements.menuPaste.textContent = t("paste");
    elements.menuSelectAll.textContent = t("selectAll");
    elements.searchInput.placeholder = t("search");
    document.getElementById("search-next").setAttribute("aria-label", t("next"));
    document.getElementById("search-prev").setAttribute("aria-label", t("previous"));
    for (const tab of state.tabs) renderTab(tab);
  }

  function palette() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      background: read("--term-bg", "#141414"),
      foreground: read("--term-fg", "#e6e6e6"),
      cursor: read("--term-cursor", "#e6e6e6"),
      selectionBackground: read("--term-selection", "rgba(255,255,255,0.24)"),
    };
  }

  function applyAppearance(appearance) {
    const base = appearance?.base === "light" ? "light" : "dark";
    document.documentElement.dataset.base = base;
    state.locale = appearance?.locale?.startsWith("zh") ? "zh-CN" : "en";
    applyCopy();
    const theme = palette();
    for (const tab of state.tabs) tab.term.options.theme = theme;
  }

  // --- start dialog -----------------------------------------------------

  /**
   * Open the dialog over the panes.
   *
   * `state.startDir` / `state.startProfile` already hold the defaults from the
   * plugin's settings, so the dialog opens on an answer the user can accept with
   * one keystroke instead of two choices.
   */
  function renderStart() {
    elements.modal.hidden = false;
    // The dialog is always dismissable: with no terminal behind it, closing
    // falls back to the empty state rather than trapping the user in a form.
    elements.startCancel.hidden = false;
    elements.startDir.textContent = state.startDir || state.home;
    elements.startDir.title = state.startDir || state.home;
    elements.startShell.textContent = "";
    for (const profile of state.profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      // The program name *and* the path it will run: the page never hides which
      // executable a profile points at.
      option.textContent = `${profile.label} — ${profile.file}`;
      elements.startShell.append(option);
    }
    if (state.startProfile && state.profiles.some((profile) => profile.id === state.startProfile)) {
      elements.startShell.value = state.startProfile;
    }
    elements.startError.textContent = state.profiles.length === 0 ? t("noShells") : "";
    elements.startRun.disabled = state.profiles.length === 0;
    if (state.tabs.length === 0) {
      elements.tabs.textContent = "";
    }
    updateEmpty();
  }

  function hideStart() {
    elements.modal.hidden = true;
    elements.startError.textContent = "";
    updateEmpty();
  }

  /**
   * What the page shows when nothing is running and the dialog is closed.
   *
   * The panes stay mounted but give up their box: an empty terminal area behind
   * the hint would only steal the space the hint is centred in.
   */
  function updateEmpty() {
    const empty = state.tabs.length === 0 && elements.modal.hidden;
    elements.empty.hidden = !empty;
    elements.panes.hidden = empty;
  }

  // --- tabs -------------------------------------------------------------

  function renderTab(tab) {
    tab.button.setAttribute("aria-selected", tab.id === state.activeId ? "true" : "false");
    tab.button.dataset.exited = tab.exited ? "true" : "false";
    tab.label.textContent = tab.title;
    const suffix = tab.exited
      ? ` (${tab.exitCode === null ? t("stopped") : t("exitCode", { code: tab.exitCode })})`
      : "";
    tab.button.title = `${tab.title} — ${tab.cwd} — ${tab.shell}${suffix}`;
    tab.close.setAttribute("aria-label", `${t("close")}: ${tab.title}`);
  }

  function activate(id) {
    state.activeId = id;
    for (const tab of state.tabs) {
      const active = tab.id === id;
      tab.pane.hidden = !active;
      renderTab(tab);
      if (active) {
        // A pane that was hidden measured zero; fit it now that it has a box.
        requestAnimationFrame(() => {
          tab.fit.fit();
          pushSize(tab);
          tab.term.focus();
        });
      }
    }
  }

  function listTerminals() {
    return state.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      exited: tab.exited,
      exitCode: tab.exitCode,
    }));
  }

  /**
   * Start a shell.
   *
   * With `fromDefaults` the page sends nothing and the backend applies the
   * user's settings, so auto-open starts a terminal without a single choice.
   * Otherwise the dialog's selection wins, because the user just made it.
   */
  async function openTerminal({ fromDefaults = false } = {}) {
    const cwd = fromDefaults ? "" : state.startDir || state.home;
    const profileId = fromDefaults ? "" : elements.startShell.value || state.startProfile;
    if (profileId) state.startProfile = profileId;
    elements.startError.textContent = "";
    let reply;
    try {
      reply = await invoke("terminal.open", {
        cwd,
        profileId,
        cols: 100,
        rows: 30,
      });
    } catch (error) {
      // Auto-open has no dialog to write into; the status line is where a failed
      // default start has to be visible.
      if (fromDefaults) showStatus(`${t("openFailed")} ${message(error)}`);
      else elements.startError.textContent = `${t("openFailed")} ${message(error)}`;
      updateEmpty();
      return;
    }
    hideStart();
    showStatus("");
    const tab = createTab(reply);
    activate(tab.id);
    pump(tab);
  }

  function createTab(reply) {
    const id = String(reply.id);
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.dataset.terminalId = id;
    pane.setAttribute("role", "tabpanel");
    elements.panes.append(pane);

    const term = new window.Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.24,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: palette(),
    });
    const fit = new window.FitAddon.FitAddon();
    const search = new window.SearchAddon.SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(pane);
    fit.fit();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.addEventListener("click", () => activate(id));
    const label = document.createElement("span");
    label.className = "tab-title";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "\u00d7";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTerminal(id);
    });
    button.append(label, close);
    elements.tabs.append(button);

    const tab = {
      id,
      title: String(reply.title ?? id),
      cwd: String(reply.cwd ?? ""),
      shell: String(reply.shell ?? ""),
      exited: false,
      exitCode: null,
      disposed: false,
      reading: false,
      term,
      fit,
      search,
      pane,
      button,
      label,
      close,
      handleInput: null,
      /** Last non-empty selection, kept because a right-click clears the live one. */
      selection: "",
    };

    term.onData((data) => {
      if (tab.disposed || !data) return;
      void invoke("terminal.write", { id, data }).catch((error) => {
        showStatus(message(error));
      });
    // xterm clears the selection on mousedown, which would leave the menu with
    // nothing to copy; swallow the right-button press before it reaches xterm.
    pane.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
    });
    // Keep the last non-empty selection: the right-click that opens the pane menu
    // clears the live one, and the menu must still copy what was just selected.
    term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text) tab.selection = text;
    });

    term.attachCustomKeyEventHandler((event) => handleKey(tab, event));
    // macOS sends Cmd+C / Cmd+V to the app's Edit menu, and that copy reads a DOM
    // selection this page does not have. The pane therefore carries its own menu,
    // plus select-to-copy for people who expect that from a terminal.
    pane.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(event, tab);
    });
    pane.addEventListener("mouseup", () => {
      if (state.defaults.copyOnSelect && tab.term.hasSelection()) void copySelection(tab);
    });

    state.tabs.push(tab);
    renderTab(tab);
    // A terminal exists now, so the empty state yields its box to the panes.
    updateEmpty();
    return tab;
  }

  function handleKey(tab, event) {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    const isMac = state.platform === "darwin";
    if (key === "f" && (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey) {
      openSearch();
      return false;
    }
    // Ctrl+C stays the shell's interrupt. Copy and paste are the page's own
    // chords because macOS routes Cmd+C / Cmd+V to the app's Edit menu, whose
    // copy reads a DOM selection this page never has; Ctrl+Shift+C and
    // Ctrl+Shift+V are unclaimed and reach the page on every platform.
    const shifted = event.ctrlKey && event.shiftKey;
    const unclaimed = shifted || (isMac && event.metaKey);
    if (key === "c" && unclaimed && tab.term.hasSelection()) {
      void copySelection(tab);
      return false;
    }
    if (key === "v" && unclaimed) {
      void pasteInto(tab);
      return false;
    }
    return true;
  }

  /** Put `text` on the clipboard, reporting a host refusal on the status line. */
  async function copyText(text) {
    if (!text) return;
    try {
      await invoke("clipboard.writeText", { text });
    } catch (error) {
      showStatus(`${t("copyFailed")} ${message(error)}`);
    }
  }

  function copySelection(tab) {
    return copyText(tab.term.getSelection() || tab.selection || "");
  }

  /**
   * Paste the clipboard into the shell.
   *
   * The host's clipboard API is used rather than a DOM paste event: the page has
   * no editable field, and the Edit menu's paste only reaches one that is focused.
   * `term.paste` applies bracketed-paste mode, so a multi-line paste behaves the
   * way the shell expects instead of running each line on arrival.
   */
  async function pasteInto(tab) {
    if (tab.disposed) return;
    try {
      const text = await invoke("clipboard.readText");
      if (typeof text === "string" && text) tab.term.paste(text);
    } catch (error) {
      showStatus(`${t("pasteFailed")} ${message(error)}`);
    }
  }

  /** Show the pane's own menu next to the pointer. */
  function openContextMenu(event, tab) {
    state.menuTab = tab;
    const text = tab.term.getSelection() || tab.selection || "";
    state.menuText = text;
    elements.menuCopy.disabled = !text;
    elements.contextMenu.hidden = false;
    // Kept inside the window: a menu opened at the bottom-right edge would
    // otherwise render half outside the page.
    const box = elements.contextMenu.getBoundingClientRect();
    elements.contextMenu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - box.width - 8))}px`;
    elements.contextMenu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - box.height - 8))}px`;
    elements.menuCopy.focus();
  }

  function closeContextMenu() {
    elements.contextMenu.hidden = true;
    state.menuTab = null;
    state.menuText = "";
  }

  async function closeTerminal(id) {
    const index = state.tabs.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    const tab = state.tabs[index];
    tab.disposed = true;
    try {
      await invoke("terminal.close", { id });
    } catch (error) {
      // The backend says the process did not go away; keep the tab so the user
      // still sees the terminal whose shell survived.
      tab.disposed = false;
      showStatus(message(error));
      return;
    }
    tab.term.dispose();
    tab.button.remove();
    tab.pane.remove();
    state.tabs.splice(index, 1);
    if (state.activeId === id) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)];
      if (next) activate(next.id);
      else {
        state.activeId = null;
        // Closing the last terminal returns to the empty state, not to a form
        // the user just decided not to use.
        updateEmpty();
      }
    }
  }

  /**
   * One pull per step: ask for output, hand it to xterm, and only ask again once
   * xterm has consumed it. This is the page's half of the backpressure contract.
   */
  function pump(tab) {
    if (tab.disposed || tab.exited) return;
    if (tab.reading) return;
    tab.reading = true;
    invoke("terminal.read", { id: tab.id })
      .then((reply) => {
        tab.reading = false;
        if (tab.disposed) return;
        const data = typeof reply?.data === "string" ? reply.data : "";
        const finished = (exitCode) => {
          tab.exited = true;
          tab.exitCode = typeof exitCode === "number" ? exitCode : null;
          renderTab(tab);
        };
        if (!data) {
          if (reply?.exited) finished(reply?.exitCode);
          else pump(tab);
          return;
        }
        tab.term.write(data, () => {
          if (tab.disposed) return;
          if (reply?.exited) finished(reply?.exitCode);
          else pump(tab);
        });
      })
      .catch((error) => {
        tab.reading = false;
        if (tab.disposed) return;
        tab.exited = true;
        renderTab(tab);
        showStatus(message(error));
      });
  }

  function pushSize(tab) {
    if (tab.disposed) return;
    void invoke("terminal.resize", { id: tab.id, cols: tab.term.cols, rows: tab.term.rows }).catch(
      () => undefined,
    );
  }

  // --- search -----------------------------------------------------------

  function openSearch() {
    const tab = activeTab();
    if (!tab) return;
    elements.search.hidden = false;
    elements.searchInput.value = "";
    elements.searchInput.focus();
  }

  function closeSearch() {
    elements.search.hidden = true;
    activeTab()?.term.focus();
  }

  function runSearch(backwards) {
    const tab = activeTab();
    const query = elements.searchInput.value;
    if (!tab || !query) return;
    if (backwards) tab.search.findPrevious(query);
    else tab.search.findNext(query);
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
  }

  // --- wiring -----------------------------------------------------------

  function wire() {
    elements.newTerminal.addEventListener("click", () => {
      showStatus("");
      renderStart();
    });
    elements.emptyStart.addEventListener("click", () => {
      showStatus("");
      renderStart();
    });
    // The backdrop and Escape dismiss the dialog. A modal that can only be left
    // through its own buttons is the kind of trap a dialog invites.
    elements.backdrop.addEventListener("click", () => {
      hideStart();
    });
    // The pane's own copy, paste and select-all: the only paths that do not
    // depend on a keystroke the application menu has already claimed.
    elements.menuCopy.addEventListener("click", () => {
      // `menuText` was captured when the menu opened: xterm clears its live
      // selection on the right-click that opened it.
      const text = state.menuText || state.menuTab?.term.getSelection() || "";
      closeContextMenu();
      void copyText(text);
    });
    elements.menuPaste.addEventListener("click", () => {
      const tab = state.menuTab ?? activeTab();
      closeContextMenu();
      if (tab) void pasteInto(tab);
    });
    elements.menuSelectAll.addEventListener("click", () => {
      const tab = state.menuTab ?? activeTab();
      closeContextMenu();
      if (tab) tab.term.selectAll();
    });
    // A click anywhere outside the menu dismisses it, as does Escape.
    document.addEventListener("mousedown", (event) => {
      if (!elements.contextMenu.hidden && !elements.contextMenu.contains(event.target)) {
        closeContextMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!elements.contextMenu.hidden) {
        event.preventDefault();
        closeContextMenu();
        return;
      }
      if (!elements.modal.hidden) {
        event.preventDefault();
        hideStart();
      }
    });
    elements.chooseDir.addEventListener("click", () => {
      void invoke("terminal.pickDirectory")
        .then((picked) => {
          if (!picked || picked.canceled || !picked.path) return;
          state.startDir = picked.path;
          renderStart();
          elements.startError.textContent = "";
        })
        .catch((error) => {
          elements.startError.textContent = message(error);
        });
    });
    elements.startShell.addEventListener("change", () => {
      state.startProfile = elements.startShell.value;
    });
    elements.startCancel.addEventListener("click", () => {
      hideStart();
    });
    elements.start.addEventListener("submit", (event) => {
      event.preventDefault();
      void openTerminal();
    });
    elements.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch(event.shiftKey);
      }
    });
    document.getElementById("search-next").addEventListener("click", () => runSearch(false));
    document.getElementById("search-prev").addEventListener("click", () => runSearch(true));

    // Window resize, and any layout change of the pane box, refits and tells the
    // PTY, so a TUI redraws at the size it is actually rendered at.
    const observer = new ResizeObserver(() => {
      const tab = activeTab();
      if (!tab || tab.disposed || tab.pane.hidden) return;
      tab.fit.fit();
      pushSize(tab);
    });
    observer.observe(elements.panes);
    window.addEventListener("resize", () => {
      const tab = activeTab();
      if (!tab || tab.disposed) return;
      tab.fit.fit();
      pushSize(tab);
    });
  }

  /**
   * Re-attach terminals this plugin process still owns.
   *
   * The page normally survives a hidden or switched-away route, so this is the
   * recovery path for a page that was rebuilt (a renderer reload, a re-created
   * view) while the shells kept running. The output produced meanwhile is in the
   * backend's bounded buffer, so nothing is lost; what is *not* replayed is the
   * emulator's own scrollback, which never claimed to be a complete snapshot.
   */
  function adoptRunningTerminals(catalog) {
    const running = (catalog?.terminals ?? []).filter((terminal) => !terminal.exited);
    if (running.length === 0) return;
    for (const terminal of running) {
      const tab = createTab({
        id: terminal.id,
        title: terminal.title,
        cwd: terminal.cwd,
        shell: terminal.shell,
      });
      pump(tab);
      state.activeId = tab.id;
    }
    hideStart();
    showStatus("");
    activate(state.activeId);
  }

  /**
   * Start the first terminal of a fresh view, or explain why it cannot.
   *
   * Opening the terminal view is already the user asking for a terminal, so the
   * shipped behaviour starts one with their settings instead of showing a form
   * they would have to answer every time. A machine with no supported shell gets
   * the dialog, because that is where the reason is written down.
   */
  async function startFirstTerminal() {
    if (state.tabs.length > 0) return; // adopting an existing shell drew the page
    if (!state.defaults.openOnView) {
      updateEmpty();
      return;
    }
    if (state.profiles.length === 0) {
      renderStart();
      return;
    }
    await openTerminal({ fromDefaults: true });
  }

  async function bootstrap() {
    if (!bridge?.invoke) {
      showStatus(t("noBridge"));
      elements.startRun.disabled = true;
      return;
    }
    bridge.on?.("appearance:changed", applyAppearance);
    bridge.on?.("workspace:changed", (workspace) => {
      state.workspace = workspace && workspace.path ? workspace : null;
      if (!state.startDir || state.workspaceIsDefault) {
        state.startDir = state.workspace?.path || state.home;
        state.workspaceIsDefault = true;
        if (!elements.modal.hidden) renderStart();
      }
    });

    const [appearance, workspace, catalog] = await Promise.all([
      invoke("app.getAppearance").catch(() => null),
      invoke("workspace.get").catch(() => null),
      invoke("terminal.catalog").catch((error) => {
        showStatus(message(error));
        return null;
      }),
    ]);
    applyAppearance(appearance);
    state.platform = catalog?.platform ?? state.platform;
    state.profiles = catalog?.profiles ?? [];
    state.home = catalog?.home ?? "";
    state.workspace = workspace && workspace.path ? workspace : null;
    state.defaults = {
      profileId: catalog?.defaults?.profileId ?? null,
      directory: catalog?.defaults?.directory ?? null,
      openOnView: catalog?.defaults?.openOnView !== false,
      copyOnSelect: catalog?.defaults?.copyOnSelect === true,
    };
    // The dialog opens on the user's configured answer — their directory, or the
    // project they have open, and their shell — so starting is one keystroke.
    state.startDir = state.defaults.directory || state.workspace?.path || state.home;
    state.workspaceIsDefault = !state.defaults.directory;
    state.startProfile = state.defaults.profileId || state.profiles[0]?.id || "";
    wire();
    adoptRunningTerminals(catalog);
    await startFirstTerminal();
  }

  void bootstrap();
})();
