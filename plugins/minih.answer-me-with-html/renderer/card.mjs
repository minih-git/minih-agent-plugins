/**
 * Answer me with HTML — renderer slot: the page card.
 *
 * The skill ends its reply with a fenced block:
 *
 *   ```minih.answer-me-with-html:page
 *   /Users/you/.answer-me-with-html/pages/Topic-20261021-095532.html
 *   ```
 *
 * The host hands that fence to this module, which draws one card in the reply:
 * the page title, where it lives, its size and time, and two buttons that reach
 * the plugin process over `plugin.call` (`onRendererCall` in `main.js`). The
 * card replaces the bare path a reply used to end with.
 *
 * Why a card and not the page itself: the host renderer's Content-Security-
 * Policy is `default-src 'self'` with no `frame-src`, so a page from another
 * folder cannot be embedded as an iframe in the reply. The card is what a slot
 * can draw; the page opens in one click.
 *
 * This module runs inside the app's own document with the app's own React
 * (through the window's import map), so it uses the host's `--ds-*` design
 * tokens and nothing else. A crash here is contained by the host, which falls
 * back to showing the fence as a code block.
 */
import { createElement as h, useEffect, useState } from "react";

/** The running load's `pi`; the host hands a fresh one per load. */
let host = null;

const CARD_CSS = `
.am-page-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ds-border-default);
  border-radius: var(--radius-md, 10px);
  background: var(--ds-surface-sunken, transparent);
  color: var(--ds-text-primary);
  font-size: 12px;
  line-height: 1.5;
}
.am-page-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.am-page-card__mark {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--ds-border-default);
  border-radius: 999px;
  color: var(--ds-text-muted);
  font-size: 11px;
  letter-spacing: .02em;
}
.am-page-card__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 560;
  font-size: 13px;
}
.am-page-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--ds-text-muted);
  font-variant-numeric: tabular-nums;
}
.am-page-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.am-page-card__btn {
  padding: 2px 10px;
  border: 1px solid var(--ds-border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--ds-text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.am-page-card__btn:hover:not(:disabled) {
  border-color: var(--ds-accent);
  color: var(--ds-accent);
}
.am-page-card__btn:disabled {
  opacity: .55;
  cursor: default;
}
.am-page-card__btn--primary {
  border-color: var(--ds-accent);
  color: var(--ds-accent);
}
.am-page-card__note {
  color: var(--ds-text-muted);
  overflow-wrap: anywhere;
}
.am-page-card__note--error {
  color: var(--ds-danger, var(--ds-text-primary));
}
.am-page-card__path {
  color: var(--ds-text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  overflow-wrap: anywhere;
}
`;

/** The absolute page path in a fence body: its first non-empty line. */
function pagePathOf(source) {
  const line = String(source ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return (line ?? "").replace(/^`+|`+$/g, "").trim();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatWhen(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Where the page lives, in the reader's words. */
function folderLabel(folder) {
  if (folder === "temp") return "临时目录";
  if (folder === "other") return "其他位置";
  return "页面库";
}

function button(label, onClick, { primary = false, disabled = false } = {}) {
  return h(
    "button",
    {
      type: "button",
      className: `am-page-card__btn${primary ? " am-page-card__btn--primary" : ""}`,
      onClick,
      disabled,
    },
    label,
  );
}

export function PageCard({ source }) {
  const pagePath = pagePathOf(source);
  const [info, setInfo] = useState(pagePath ? { status: "loading" } : { status: "empty" });
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!pagePath) return undefined;
    let live = true;
    host
      .dispatch("plugin.call", { method: "pageInfo", args: { path: pagePath } })
      .then(
        (value) => live && setInfo(value?.ok ? { status: "ready", ...value } : { status: "error", error: value?.error }),
        (error) => live && setInfo({ status: "error", error: error?.message ?? String(error) }),
      );
    return () => {
      live = false;
    };
  }, [pagePath]);

  const call = (method, onDone) => {
    setNote("");
    host.dispatch("plugin.call", { method, args: { path: pagePath } }).then(
      (value) => onDone?.(value),
      (error) => setNote(error?.message ?? String(error)),
    );
  };

  const ready = info.status === "ready";
  const title = ready ? info.title || info.name : "HTML 页面";
  const meta = ready
    ? [folderLabel(info.folder), formatBytes(info.bytes), formatWhen(info.modifiedAt)].filter(Boolean)
    : [];

  // A card with no usable page is a notice, not an action bar: the buttons only
  // appear once the plugin has confirmed a real file behind the path.
  const actions = ready
    ? h(
        "div",
        { className: "am-page-card__actions" },
        button(
          "打开页面",
          () =>
            call("openPage", (value) =>
              setNote(
                value?.where === "app"
                  ? "已在应用内置浏览器打开"
                  : "已用系统浏览器打开：应用内浏览面板没打开，这是退路",
              ),
            ),
          { primary: true },
        ),
        button("复制路径", () => call("copyPath", () => setNote("路径已复制"))),
      )
    : null;

  return h(
    "div",
    { className: "am-page-card", "data-am-page-card": info.status },
    h(
      "div",
      { className: "am-page-card__head" },
      h("span", { className: "am-page-card__mark" }, "HTML"),
      h("span", { className: "am-page-card__title", title: pagePath }, title),
    ),
    meta.length ? h("div", { className: "am-page-card__meta" }, meta.map((part, index) => h("span", { key: index }, part))) : null,
    actions,
    info.status === "loading" ? h("div", { className: "am-page-card__note" }, "读取中…") : null,
    info.status === "error"
      ? h("div", { className: "am-page-card__note am-page-card__note--error" }, `打不开：${info.error}`)
      : null,
    info.status === "empty" ? h("div", { className: "am-page-card__note" }, "这个块里没有页面路径。") : null,
    note ? h("div", { className: "am-page-card__note" }, note) : null,
    // The file name only: the folder is already in the meta line above, and a
    // full path across the reply is the thing this card exists to replace.
    pagePath ? h("div", { className: "am-page-card__path", title: pagePath }, pagePath.split("/").pop()) : null,
  );
}

export function onLoad(pi) {
  host = pi;
  pi.ui.injectStyle(CARD_CSS);
  pi.slots.register({ slot: "blockRenderer", language: `${pi.plugin.id}:page`, component: PageCard });
}
