"use strict";

/**
 * Answer me with HTML — panel script.
 *
 * The panel only draws and asks; every file operation happens in the plugin
 * process over `am.*` channels (`main.js` → `onPanelInvoke`). The host gives a
 * panel no Node, so this file never touches the disk itself.
 *
 * Destructive actions are two-step inside the panel: the first click arms the
 * button, the second one runs it. A panel gets no host dialog, and deleting a
 * page on a single click is the one behaviour a gallery must not have.
 */

const bridge = window.pluginBridge;

const STRINGS = {
  "zh-CN": {
    title: "用 HTML 回答",
    refresh: "刷新",
    reveal: "打开页面目录",
    clean: "清理旧页面",
    cleanAll: "全部清理",
    cleanDays: "清理 {days} 天前的页面（天数在插件设置里改）",
    pagesTitle: "已生成的页面",
    empty: "还没有页面。让 Agent 解释一个流程、做个对比或排查一个问题，它就会写一页 HTML。",
    cardPages: "页面",
    cardVideos: "视频",
    cardCache: "配音缓存",
    cardTotal: "合计",
    pathLabel: "页面目录",
    open: "打开",
    copy: "复制路径",
    del: "删除",
    confirmDelete: "确认删除？",
    confirmCleanAll: "确认全部清理？",
    countText: "{n} 个页面 · {size}",
    countTruncated: "显示最近 {shown} 个，共 {n} 个",
    tempCount: "其中临时目录 {n} 个 · {size}",
    tempFolder: "临时目录",
    copied: "已复制页面路径",
    deleted: "已删除 {name}",
    justNow: "刚刚",
    note: "页面由内置的 am CLI 生成。主题、自动打开、字号等设置用 am config 修改；清理天数在插件设置里改。",
    version: "am {version}",
    loadFailed: "无法读取页面目录",
    noBridge: "pluginBridge 不可用：请从 Minih-Agent-Desktop 里打开这个面板。",
  },
  en: {
    title: "Answer me with HTML",
    refresh: "Refresh",
    reveal: "Open pages folder",
    clean: "Clean old pages",
    cleanAll: "Clean everything",
    cleanDays: "Clean pages older than {days} days (the age is a plugin setting)",
    pagesTitle: "Pages",
    empty: "No pages yet. Ask the Agent to explain a flow, compare options or diagnose a problem and it writes one.",
    cardPages: "Pages",
    cardVideos: "Videos",
    cardCache: "Voice cache",
    cardTotal: "Total",
    pathLabel: "Pages folder",
    open: "Open",
    copy: "Copy path",
    del: "Delete",
    confirmDelete: "Delete this page?",
    confirmCleanAll: "Delete every page and video?",
    countText: "{n} pages · {size}",
    countTruncated: "newest {shown} of {n}",
    tempCount: "{n} of them in the temporary folder · {size}",
    tempFolder: "temporary folder",
    copied: "Page path copied",
    deleted: "Deleted {name}",
    justNow: "just now",
    note: "Pages are written by the bundled am CLI. Change the theme, auto-open and text size with am config; the clean-up age is a plugin setting.",
    version: "am {version}",
    loadFailed: "Cannot read the pages folder",
    noBridge: "pluginBridge is unavailable: open this panel from Minih-Agent-Desktop.",
  },
};

let strings = STRINGS["zh-CN"];
let state = null;
let list = null;
let busy = false;

const el = (id) => document.getElementById(id);

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatWhen(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return strings.justNow;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function setStatus(message, isError = false) {
  const status = el("status");
  clearTimeout(setStatus.timer);
  if (!message) {
    status.hidden = true;
    status.textContent = "";
    return;
  }
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));
  if (!isError) setStatus.timer = setTimeout(() => setStatus(""), 4000);
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message || "unknown error";
}

function invoke(channel, payload) {
  return bridge.invoke(channel, payload);
}

function applyStrings() {
  document.documentElement.lang = strings === STRINGS.en ? "en" : "zh-CN";
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const text = strings[node.dataset.i18n];
    if (text) node.textContent = text;
  }
  document.title = strings.title;
}

function card(label, value) {
  const node = document.createElement("div");
  node.className = "card";
  const labelNode = document.createElement("div");
  labelNode.className = "card-label";
  labelNode.textContent = label;
  const valueNode = document.createElement("div");
  valueNode.className = "card-value";
  valueNode.textContent = value;
  node.append(labelNode, valueNode);
  return node;
}

function renderSummary() {
  const summary = el("summary");
  summary.replaceChildren();
  if (!state) return;
  const used = state.usage || {};
  summary.append(
    card(strings.cardPages, `${used.pages?.count ?? 0} · ${formatBytes(used.pages?.bytes)}`),
    card(strings.cardVideos, `${used.videos?.count ?? 0} · ${formatBytes(used.videos?.bytes)}`),
    card(strings.cardCache, formatBytes(used.cache?.bytes)),
    card(strings.cardTotal, formatBytes(used.total)),
  );
  const row = document.createElement("div");
  row.className = "path-row";
  const label = document.createElement("span");
  label.className = "card-label";
  label.textContent = strings.pathLabel;
  const pathNode = document.createElement("span");
  pathNode.className = "path";
  pathNode.textContent = state.pagesDir;
  pathNode.title = state.pagesDir;
  row.append(label, pathNode);
  summary.append(row);
  el("version").textContent = strings.version.replace("{version}", state.version ?? "—");
  el("clean").title = strings.cleanDays.replace("{days}", String(state.cleanupDays ?? ""));
}

/**
 * Wire a button so its first click arms it and its second click runs `run`.
 * The armed state clears itself after a few seconds, and the row this button
 * belongs to is rebuilt on every refresh, so no listener outlives its page.
 */
function confirmThen(button, question, run) {
  const label = button.textContent;
  let armed = false;
  let timer = null;
  const reset = () => {
    armed = false;
    clearTimeout(timer);
    button.classList.remove("armed");
    button.textContent = label;
  };
  button.addEventListener("click", async () => {
    if (busy) return;
    if (!armed) {
      armed = true;
      button.classList.add("armed");
      button.textContent = question;
      timer = setTimeout(reset, 5000);
      return;
    }
    reset();
    await run();
  });
}

function pageRow(page) {
  const item = document.createElement("li");
  item.className = "page";

  const main = document.createElement("div");
  main.className = "page-main";
  const title = document.createElement("div");
  title.className = "page-title";
  title.textContent = page.title || page.name;
  const meta = document.createElement("div");
  meta.className = "page-meta";
  const where = page.root === "temp" ? `${strings.tempFolder} · ` : "";
  meta.textContent = `${where}${formatWhen(page.modifiedAt)} · ${formatBytes(page.bytes)} · ${page.name}`;
  meta.title = page.name;
  main.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "page-actions";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = strings.open;
  openButton.addEventListener("click", async () => {
    try {
      await invoke("am.openPage", { root: page.root, name: page.name });
    } catch (error) {
      setStatus(describeError(error), true);
    }
  });

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = strings.copy;
  copyButton.addEventListener("click", async () => {
    try {
      await invoke("am.copyPath", { root: page.root, name: page.name });
      setStatus(strings.copied);
    } catch (error) {
      setStatus(describeError(error), true);
    }
  });

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger";
  deleteButton.textContent = strings.del;
  confirmThen(deleteButton, strings.confirmDelete, async () => {
    busy = true;
    try {
      list = await invoke("am.deletePage", { root: page.root, name: page.name });
      renderPages();
      setStatus(strings.deleted.replace("{name}", page.name));
    } catch (error) {
      setStatus(describeError(error), true);
    } finally {
      busy = false;
    }
  });

  actions.append(openButton, copyButton, deleteButton);
  item.append(main, actions);
  return item;
}

function renderPages() {
  const container = el("pages");
  container.replaceChildren();
  const pages = list?.pages ?? [];
  el("empty").hidden = pages.length > 0;
  el("note").textContent = strings.note;
  if (!list) {
    el("count").textContent = "";
    return;
  }
  el("count").textContent = list.truncated
    ? strings.countTruncated.replace("{shown}", String(pages.length)).replace("{n}", String(list.total))
    : strings.countText.replace("{n}", String(list.total)).replace("{size}", formatBytes(list.bytes));
  const spare = (list.roots ?? []).find((root) => root.id === "temp");
  if (spare?.count) {
    el("count").textContent += ` · ${strings.tempCount
      .replace("{n}", String(spare.count))
      .replace("{size}", formatBytes(spare.bytes))}`;
  }
  for (const page of pages) container.append(pageRow(page));
}

async function refresh() {
  try {
    state = await invoke("am.state");
    if (String(state.locale ?? "").toLowerCase().startsWith("en")) strings = STRINGS.en;
    applyStrings();
    renderSummary();
    list = await invoke("am.pages");
    renderPages();
  } catch (error) {
    setStatus(`${strings.loadFailed}: ${describeError(error)}`, true);
  }
}

async function runClean(all) {
  busy = true;
  try {
    list = await invoke("am.clean", { all });
    renderPages();
    await refresh();
    setStatus(all ? strings.cleanAll : strings.clean);
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    busy = false;
  }
}

function wire() {
  el("refresh").addEventListener("click", () => void refresh());

  el("reveal").addEventListener("click", async () => {
    try {
      await invoke("am.reveal");
    } catch (error) {
      setStatus(describeError(error), true);
    }
  });

  el("clean").addEventListener("click", () => void runClean(false));
  confirmThen(el("clean-all"), strings.confirmCleanAll, () => runClean(true));
}

document.addEventListener("DOMContentLoaded", () => {
  if (!bridge || typeof bridge.invoke !== "function") {
    setStatus(STRINGS["zh-CN"].noBridge, true);
    return;
  }
  wire();
  void refresh();
});
