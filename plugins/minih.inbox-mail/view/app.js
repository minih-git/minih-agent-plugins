/**
 * The Inbox panel: mailboxes on the left, the unified list in the middle, one
 * message on the right.
 *
 * Everything here is a view of state the plugin owns. The page never decides what
 * a mailbox is, never decides that a message is read, and never holds a body it
 * fetched: it asks the plugin (`window.pluginBridge.invoke`) and renders the
 * answer. The rules that can be stated without a document — day groups, short
 * times, search, avatars, the keyboard map — live in `model.js`, so this file is
 * about showing them and nothing else.
 *
 * The two things it does own are the ones that need a document: the sanitized
 * frame and the reading controls. Both are bounded by the same rule as before —
 * `sandbox=""`, the frame's own CSP, remote images blocked until asked for, links
 * handed to the host.
 *
 * The panel polls because the host has no plugin → panel push channel; a five
 * second tick is the difference between "mail appears" and "reload the panel",
 * and it costs one bridge call.
 */

import {
  FILTERS,
  attachmentMeta,
  avatarColor,
  fileKind,
  fullTime,
  groupMessages,
  initials,
  keyboardAction,
  recipientSummary,
  sameMessage,
  shortTime,
  stepIndex,
  visibleMessages,
} from "./model.js";
import { bodyMode, buildFrameDocument, classifyLink, FRAME_SANDBOX, linkifyText } from "./policy.js";
import { bindFrame } from "./frame.js";
import { linkDisguise, parseMailto } from "./links.js";
import { prepareBody } from "./sanitize.js";
import { createComposer } from "./compose.js";
import { codeText, strings } from "./strings.js";

const POLL_MS = 5000;
const BODY_LIMIT_LABEL = "1 MiB";
/** Below this the panel is one column and the reading pane takes the screen. */
const NARROW = "(max-width: 699px)";
/** How long a "moved to the trash" line stays up. */
const NOTICE_MS = 5000;

const state = {
  locale: "en",
  theme: "dark",
  snapshot: null,
  accountId: "all",
  filter: "all",
  query: "",
  selected: null,
  reader: null,
  banner: null,
  notice: null,
  busy: false,
  loadingOlder: false,
  sidebar: true,
  /** The account whose "⋯" menu is open, if any. */
  menu: null,
  /** The account whose removal is being confirmed, if any. */
  confirming: null,
  /** The message a POP3 delete is waiting on, if any. */
  confirmDelete: null,
  /**
   * The attachments being saved right now, as `accountId:key:index`.
   *
   * One save dialog exists per plugin, so a second click while one is open would
   * be refused by the host; disabling the card is what says so before the click.
   */
  downloading: new Set(),
};

let noticeTimer = null;
/** The composer, created once in `wire()`. */
let composer = null;

const nodes = {
  app: document.getElementById("app"),
  title: document.getElementById("page-title"),
  counts: document.getElementById("counts"),
  sidebar: document.getElementById("btn-sidebar"),
  banner: document.getElementById("banner"),
  compose: document.getElementById("btn-compose"),
  composeLayer: document.getElementById("compose"),
  check: document.getElementById("btn-check"),
  add: document.getElementById("btn-add"),
  accounts: document.getElementById("accounts"),
  accountsTitle: document.getElementById("accounts-title"),
  accountsHint: document.getElementById("accounts-hint"),
  accountList: document.getElementById("account-list"),
  accountsEmpty: document.getElementById("accounts-empty"),
  search: document.getElementById("search"),
  searchClear: document.getElementById("btn-search-clear"),
  filters: document.getElementById("filters"),
  groups: document.getElementById("groups"),
  messagesEmpty: document.getElementById("messages-empty"),
  listFoot: document.getElementById("list-foot"),
  older: document.getElementById("btn-older"),
  reader: document.getElementById("reader"),
  back: document.getElementById("btn-back"),
  readerEmpty: document.getElementById("reader-empty"),
  readerState: document.getElementById("reader-state"),
  readerMessage: document.getElementById("reader-message"),
  readerSubject: document.getElementById("reader-subject"),
  readerPeople: document.getElementById("reader-people"),
  readerMeta: document.getElementById("reader-meta"),
  readerActions: document.getElementById("reader-actions"),
  readerNotice: document.getElementById("reader-notice"),
  readerBody: document.getElementById("reader-body"),
  readerExtras: document.getElementById("reader-extras"),
  readerLinkStatus: document.getElementById("reader-link-status"),
  confirm: document.getElementById("confirm"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmBody: document.getElementById("confirm-body"),
  confirmYes: document.getElementById("confirm-yes"),
  confirmNo: document.getElementById("confirm-no"),
};

function t() {
  return strings(state.locale);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      for (const [name, data] of Object.entries(value)) node.dataset[name] = String(data);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * A 16×16 line icon.
 *
 * Inline SVG rather than a font or an image: the panel's CSP allows no remote
 * source and no `data:` image in a button, and a vector keeps its weight in both
 * themes. `currentColor` is what lets one icon serve a quiet button and a red
 * destructive one.
 */
const ICONS = {
  menu: '<circle cx="3" cy="8" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="13" cy="8" r="1.6"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  star: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8-2.8-2.7 3.8-.5z"/>',
  starFilled: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8-2.8-2.7 3.8-.5z" fill="currentColor"/>',
  mailOpen: '<path d="M2.5 5.5 8 9l5.5-3.5"/><rect x="2" y="3.5" width="12" height="9" rx="1.5"/>',
  inbox: '<path d="M2.5 9.2 4.2 3.9h7.6l1.7 5.3"/><path d="M2.5 9.2h3.1l.9 1.5h3l.9-1.5h3.1v2.9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M4 5.5l4 3 4-3"/>',
  trash: '<path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5"/>',
  archive: '<rect x="2" y="3.5" width="12" height="3" rx="1"/><path d="M3.5 6.5v5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-5M6.5 9h3"/>',
  images: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 10.5 6 7.5l2.5 2 2-1.5 3 2.5"/><circle cx="5.5" cy="6.2" r=".9"/>',
  code: '<path d="M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5"/>',
  text: '<path d="M3 4.5h10M3 7.5h10M3 10.5h6"/>',
  paperclip: '<path d="M10.5 4.5 5.6 9.4a1.7 1.7 0 0 0 2.4 2.4l5.3-5.3a2.9 2.9 0 0 0-4.1-4.1L3.9 7.7"/>',
  external: '<path d="M9 3h4v4M13 3 8 8"/><path d="M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5"/>',
  reply: '<path d="M6.5 5 3 8l3.5 3"/><path d="M3 8h6a3.5 3.5 0 0 1 3.5 3.5V13"/>',
  replyAll: '<path d="M6.5 5 3 8l3.5 3"/><path d="M9.5 5 6 8l3.5 3"/><path d="M6 8h4.5a3 3 0 0 1 3 3V13"/>',
  forward: '<path d="M9.5 5 13 8l-3.5 3"/><path d="M13 8H7a3.5 3.5 0 0 0-3.5 3.5V13"/>',
  download: '<path d="M8 2.5v7M5 7l3 3 3-3"/><path d="M3 12.5h10"/>',
};

function icon(name) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML =
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
  return span;
}

/** One icon button. The label is both the tooltip and the accessible name. */
function iconButton(name, label, onClick, extra = {}) {
  const node = el("button", {
    type: "button",
    class: `icon-btn${extra.className ? ` ${extra.className}` : ""}`,
    title: label,
    "aria-label": label,
    "aria-pressed": extra.pressed === undefined ? undefined : String(extra.pressed),
    onClick,
  });
  node.append(icon(name));
  return node;
}

function button(label, { onClick, quiet = false, primary = false, title, iconName } = {}) {
  const node = el("button", {
    type: "button",
    class: `btn${quiet ? " btn-quiet" : ""}${primary ? " btn-primary" : ""}`,
    title,
    "aria-label": title ?? label,
    onClick,
  });
  if (iconName) node.append(icon(iconName));
  node.append(el("span", { text: label }));
  return node;
}

/**
 * One bridge call.
 *
 * A plugin answer of `{ ok: false, code }` becomes a coded error here: the panel
 * maps codes to sentences, and a host-level rejection (a channel the host refuses,
 * an unloaded plugin) is passed through with whatever code it carries.
 */
async function call(channel, payload) {
  const bridge = globalThis.window?.pluginBridge;
  if (!bridge || typeof bridge.invoke !== "function") {
    throw Object.assign(new Error("bridge unavailable"), { code: "PLUGIN_NOT_LOADED" });
  }
  const result = await bridge.invoke(channel, payload ?? {});
  if (result && typeof result === "object" && result.ok === false) {
    throw Object.assign(new Error(result.message ?? result.code), { code: result.code ?? "FAILED" });
  }
  return result ?? {};
}

function describe(error, fallback) {
  return codeText(state.locale, error?.code, fallback ?? t().codes.FAILED);
}

function setBanner(message, isError = false) {
  state.banner = message ? { message, isError } : null;
  nodes.banner.textContent = message ?? "";
  nodes.banner.classList.toggle("is-hidden", !message);
  nodes.banner.classList.toggle("is-error", Boolean(message) && isError);
}

/** A short-lived line under the topbar: "moved to the trash", "archived". */
function setNotice(message, isError = false) {
  if (noticeTimer) clearTimeout(noticeTimer);
  state.notice = message ? { message, isError } : null;
  setBanner(message, isError);
  if (!message) return;
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (state.notice?.message === message) {
      state.notice = null;
      setBanner(null);
    }
  }, NOTICE_MS);
}

function applyAppearance(appearance) {
  const theme = appearance?.base === "light" ? "light" : appearance?.base === "dark" ? "dark" : null;
  if (theme) state.theme = theme;
  else if (globalThis.matchMedia?.("(prefers-color-scheme: light)").matches) state.theme = "light";
  if (typeof appearance?.locale === "string" && appearance.locale) state.locale = appearance.locale;
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = state.locale;
  renderStatic();
  render();
  // The composer is a second surface with its own sentence per control; a locale
  // change has to reach it too, without dropping the half-written message.
  composer?.relabel();
}

async function loadAppearance() {
  try {
    applyAppearance(await call("app.getAppearance"));
  } catch {
    applyAppearance(null);
  }
}

async function refresh({ quiet = false } = {}) {
  try {
    const result = await call("inbox.snapshot");
    state.snapshot = result.snapshot ?? null;
    if (!quiet) setBanner(state.notice?.message ?? null, false);
    render();
  } catch (error) {
    if (!quiet) setBanner(describe(error, t().refreshFailed), true);
  }
}

function accountById(instanceId) {
  return state.snapshot?.accounts.find((account) => account.instanceId === instanceId) ?? null;
}

/**
 * The account's state as one sentence, for a tooltip.
 *
 * The stored error is `CODE: message`; the sentence is the panel's own, and the
 * code is only worth showing when the panel has no sentence for it. A proxy is
 * part of how the account connects, so it is appended last: it explains a
 * connection that fails for a reason the account's own form cannot show.
 */
function statusLabel(account) {
  const table = t().status;
  const phase = account.status?.phase ?? "stopped";
  let label;
  if (phase === "error" && account.status?.lastError) {
    const code = String(account.status.lastError).split(":")[0].trim();
    const reason = codeText(state.locale, code, "");
    label = `${table.error}${reason ? ` · ${reason}` : ""}`;
  } else {
    label = table[phase] ?? table.stopped;
  }
  if (account.proxy) label += ` · ${t().viaProxy(account.proxy)}`;
  return label;
}

function unreadIn(instanceId) {
  return (state.snapshot?.messages ?? []).filter(
    (message) => message.unread && (instanceId === "all" || message.accountId === instanceId),
  ).length;
}

function renderStatic() {
  const table = t();
  nodes.title.textContent = table.title;
  nodes.counts.textContent = state.snapshot ? table.messages(state.snapshot.messages.length) : "";
  nodes.sidebar.title = table.sidebarToggle;
  nodes.check.textContent = table.check;
  nodes.compose.textContent = table.compose.newMessage;
  nodes.compose.title = table.composeHint;
  nodes.compose.setAttribute("aria-label", table.composeHint);
  nodes.add.textContent = table.add;
  nodes.accountsTitle.textContent = table.accounts;
  nodes.accountsHint.textContent = table.accountsHint(state.snapshot?.accounts.length ?? 0);
  nodes.accountsEmpty.textContent = table.emptyAccounts;
  nodes.search.placeholder = table.searchPlaceholder;
  nodes.search.setAttribute("aria-label", table.searchLabel);
  nodes.searchClear.title = table.searchClear;
  nodes.back.textContent = table.readerBack;
  nodes.readerEmpty.textContent = table.readerEmpty;
  nodes.older.textContent = state.loadingOlder ? table.loadingOlder : table.loadOlder;
  nodes.filters.setAttribute("aria-label", table.filtersLabel);
}

function render() {
  renderStatic();
  renderFilters();
  renderAccounts();
  renderList();
  renderReader();
  renderConfirm();
  const narrow = Boolean(globalThis.matchMedia?.(NARROW).matches);
  nodes.app.dataset.pane = narrow && state.reader ? "reader" : "list";
  nodes.sidebar.setAttribute("aria-expanded", String(state.sidebar));
  nodes.app.classList.toggle("is-sidebar-hidden", !state.sidebar);
}

function renderFilters() {
  const table = t();
  nodes.filters.replaceChildren(
    ...FILTERS.map((id) =>
      el("button", {
        type: "button",
        class: `filter${state.filter === id ? " is-on" : ""}`,
        "aria-pressed": state.filter === id ? "true" : "false",
        text: table.filter[id],
        onClick: () => {
          state.filter = id;
          render();
        },
      }),
    ),
  );
  nodes.search.value = state.query;
  nodes.searchClear.classList.toggle("is-hidden", !state.query);
}

/**
 * The unread count, as a badge.
 *
 * Returns `null` for zero, and every caller passes the result through `el()` —
 * which filters it out. The native `Element.append` would have rendered a literal
 * "null", which is how 0.4.0 shipped an account row reading
 * `archive@163.comnull`.
 */
function unreadBadge(count, table) {
  if (!count) return null;
  return el("span", { class: "badge", text: String(count), title: table.unreadBadge(count) });
}

/** One account's first-letter avatar: a colour per address, like the list's. */
function accountAvatar(account) {
  const address = account.email || account.label || account.instanceId;
  return el("span", {
    class: "avatar account-avatar",
    dataset: { tone: avatarColor(address) },
    "aria-hidden": "true",
    text: initials(account.label, address),
  });
}

/**
 * The sidebar: one fixed "all inboxes" row, then one row per account.
 *
 * A row is a button (filter the list) plus a "⋯" button (that account's
 * actions), which is why the row is a `div` with two controls rather than one
 * button: a button inside a button is not a thing HTML allows, and a screen
 * reader needs both names. Each row carries an avatar, a state dot and an unread
 * badge, which is also everything the icon rail shows between 700 and 1100 px:
 * a column of bare dots told a reader nothing about which mailbox was which.
 */
function renderAccounts() {
  const table = t();
  const accounts = state.snapshot?.accounts ?? [];
  const rows = [];

  const allSelected = state.accountId === "all";
  const allUnread = unreadIn("all");
  const allRow = el(
    "li",
    { class: `account account-all${allSelected ? " is-selected" : ""}` },
    el(
      "div",
      { class: "account-row" },
      el(
        "button",
        {
          type: "button",
          class: "account-main",
          "aria-pressed": allSelected ? "true" : "false",
          title: table.allInboxes,
          onClick: () => {
            state.accountId = "all";
            state.menu = null;
            render();
          },
        },
        el("span", { class: "account-avatar account-avatar-all", "aria-hidden": "true" }, icon("inbox")),
        el("span", { class: "account-label", text: table.allInboxes }),
        unreadBadge(allUnread, table),
      ),
    ),
  );
  rows.push(allRow);

  for (const account of accounts) {
    const selected = state.accountId === account.instanceId;
    const unread = unreadIn(account.instanceId);
    const status = statusLabel(account);
    const pending = account.status?.phase === "needs-provider" || account.status?.phase === "needs-server";
    const row = el("li", {
      class: `account${selected ? " is-selected" : ""}${pending ? " is-pending" : ""}`,
      dataset: { phase: account.status?.phase ?? "stopped" },
    });
    const main = el(
      "button",
      {
        type: "button",
        class: "account-main",
        "aria-pressed": selected ? "true" : "false",
        title: `${account.label}${status ? ` · ${status}` : ""}`,
        onClick: () => {
          state.accountId = selected ? "all" : account.instanceId;
          state.menu = null;
          render();
        },
      },
      accountAvatar(account),
      el("span", {
        class: "status-dot",
        dataset: { phase: account.status?.phase ?? "stopped" },
        title: status,
        "aria-label": status,
        role: "img",
      }),
      el("span", { class: "account-label", text: account.label }),
      unreadBadge(unread, table),
    );
    const menuButton = iconButton("menu", table.accountMenu, (event) => {
      event.stopPropagation();
      state.menu = state.menu === account.instanceId ? null : account.instanceId;
      state.confirming = null;
      render();
    }, { className: "account-menu-btn" });
    row.append(el("div", { class: "account-row" }, main, menuButton));

    // A failed mailbox explains itself in one folded line here, with the full
    // sentence in the tooltip: a sidebar is not the place for a paragraph.
    if (account.status?.phase === "error" && account.status?.lastError) {
      row.append(el("p", { class: "account-error", title: String(account.status.lastError), text: status }));
    }
    if (account.missingServer) {
      row.append(el("p", { class: "account-hint", text: table.status["needs-server"] }));
    }
    if (state.confirming === account.instanceId) {
      row.append(
        el(
          "div",
          { class: "account-confirm" },
          el("p", { text: table.removeConfirm(account.label) }),
          el(
            "div",
            { class: "account-confirm-actions" },
            button(table.removeYes, {
              primary: true,
              onClick: () => {
                state.confirming = null;
                void removeAccount(account);
              },
            }),
            button(table.removeNo, {
              quiet: true,
              onClick: () => {
                state.confirming = null;
                render();
              },
            }),
          ),
        ),
      );
    } else if (state.menu === account.instanceId) {
      const items = [
        ["mailOpen", table.menuOnlyThis, () => {
          state.accountId = account.instanceId;
          state.menu = null;
          render();
        }],
        ["refresh", table.menuCheckThis, () => {
          state.menu = null;
          void checkAccount(account);
        }],
      ];
      if (account.webmail) {
        items.push(["external", table.menuWebmail, () => {
          state.menu = null;
          void openWebmail(account);
        }]);
      }
      items.push(["trash", table.menuRemove, () => {
        state.menu = null;
        state.confirming = account.instanceId;
        render();
      }]);
      row.append(
        el(
          "div",
          { class: "menu", role: "menu" },
          ...items.map(([iconName, label, run]) =>
            el(
              "button",
              { type: "button", class: "menu-item", role: "menuitem", onClick: run },
              icon(iconName),
              el("span", { text: label }),
            ),
          ),
        ),
      );
    }
    rows.push(row);
  }

  nodes.accountList.replaceChildren(...rows);
  nodes.accountsEmpty.hidden = accounts.length > 0;
}

function listOptions() {
  return { accountId: state.accountId, filter: state.filter, query: state.query };
}

function renderList() {
  const table = t();
  const messages = state.snapshot?.messages ?? [];
  const groups = groupMessages(messages, listOptions());
  const sections = groups.map((group) => {
    const heading = el("h3", { class: "group-title", text: table.groups[group.id] ?? group.id });
    const rows = group.items.map((message) => mailRow(message));
    return el("section", { class: "group", dataset: { group: group.id } }, heading, el("ul", { class: "mail-list" }, ...rows));
  });
  nodes.groups.replaceChildren(...sections);

  const visible = visibleMessages(messages, listOptions());
  const empty = visible.length === 0;
  nodes.messagesEmpty.hidden = !empty;
  if (empty) {
    const accounts = state.snapshot?.accounts?.length ?? 0;
    if (!accounts) nodes.messagesEmpty.textContent = table.emptyAccounts;
    else if (state.query) nodes.messagesEmpty.textContent = table.emptySearch;
    else if (state.filter !== "all") nodes.messagesEmpty.textContent = table.emptyFilter;
    else nodes.messagesEmpty.textContent = table.emptyMessages;
  }

  // "Load older" belongs to one account: with "all inboxes" there is no single
  // mailbox to walk back through, and saying so would be a lie.
  const account = state.accountId === "all" ? null : accountById(state.accountId);
  const limit = state.snapshot?.limits?.messagesPerAccount ?? 200;
  const full = Boolean(account) && (account.messageCount ?? 0) >= limit;
  nodes.listFoot.classList.toggle("is-hidden", !account);
  nodes.older.disabled = state.loadingOlder || full;
  nodes.older.textContent = state.loadingOlder
    ? table.loadingOlder
    : full
      ? table.limitReached
      : table.loadOlder;
}

/** One row: avatar, sender, time, subject, preview, tags, and hover actions. */
function mailRow(message) {
  const table = t();
  const account = accountById(message.accountId);
  const sender = message.from?.name || message.from?.address || table.unknownSender;
  const active = sameMessage(state.reader?.source, message);
  const focused = sameMessage(state.selected, message);
  const row = el("li", {
    class: `mail${message.unread ? " is-unread" : " is-read"}${active ? " is-active" : ""}${focused ? " is-focused" : ""}`,
    tabIndex: 0,
    role: "option",
    "aria-selected": active ? "true" : "false",
    dataset: { key: message.key, account: message.accountId },
    onClick: () => void openMessage(message),
    onKeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openMessage(message);
      }
    },
  });

  const avatarIndex = avatarColor(message.from?.address ?? sender);
  row.append(
    el("span", {
      class: "avatar",
      dataset: { tone: avatarIndex },
      "aria-hidden": "true",
      text: initials(message.from?.name, message.from?.address),
    }),
    el(
      "div",
      { class: "mail-main" },
      el(
        "div",
        { class: "mail-top" },
        el("span", { class: "mail-from-name", text: sender }),
        message.starred ? el("span", { class: "mail-star", title: table.starred, text: "★" }) : null,
        message.hasAttachments
          ? el("span", { class: "mail-tag", title: table.hasAttachment }, icon("paperclip"))
          : null,
        el("span", { class: "mail-time", text: shortTime(message.receivedAt, { locale: state.locale }) }),
      ),
      el("div", { class: "mail-subject", text: message.subject || table.noSubject }),
      el("div", { class: "mail-summary", text: message.summary || "" }),
      el(
        "div",
        { class: "mail-account-row" },
        el("span", { class: "mail-account", text: account?.label ?? message.accountLabel }),
      ),
    ),
  );

  // The quick actions appear on hover and on keyboard focus, and only the ones
  // the account supports: a POP3 mailbox has no star and no flag to flip.
  const quick = el("div", { class: "mail-quick" });
  if (message.flagsSupported) {
    quick.append(
      iconButton(message.unread ? "mailOpen" : "mail", message.unread ? table.markRead : table.markUnread, (event) => {
        event.stopPropagation();
        void setFlag(message, message.unread ? "seen" : "unseen");
      }),
      iconButton(message.starred ? "starFilled" : "star", message.starred ? table.unstar : table.star, (event) => {
        event.stopPropagation();
        void setFlag(message, message.starred ? "unflagged" : "flagged");
      }),
    );
  }
  if (account?.canDelete !== false) {
    quick.append(
      iconButton("trash", table.deleteMail, (event) => {
        event.stopPropagation();
        void deleteMessage(message);
      }),
    );
  }
  row.append(quick);
  return row;
}

/**
 * The delete confirmation.
 *
 * Focus lands on "cancel": a dialog that opens on the destructive button deletes
 * a message the moment someone presses Enter out of habit.
 */
function renderConfirm() {
  const table = t();
  const target = state.confirmDelete;
  nodes.confirm.classList.toggle("is-hidden", !target);
  if (!target) return;
  nodes.confirmTitle.textContent = table.deleteConfirmTitle;
  nodes.confirmBody.textContent = table.deleteConfirmBody(target.subject || table.noSubject);
  nodes.confirmYes.textContent = table.deleteConfirmYes;
  nodes.confirmNo.textContent = table.deleteConfirmNo;
  if (document.activeElement !== nodes.confirmNo && !nodes.confirm.contains(document.activeElement)) {
    nodes.confirmNo.focus();
  }
}

function closeConfirm() {
  if (!state.confirmDelete) return;
  state.confirmDelete = null;
  render();
}

function renderReader() {
  const reader = state.reader;
  nodes.readerEmpty.hidden = Boolean(reader);
  nodes.readerState.classList.toggle("is-hidden", !reader || reader.status === "ready");
  nodes.readerMessage.classList.toggle("is-hidden", reader?.status !== "ready");
  if (!reader) {
    nodes.readerExtras.replaceChildren();
    nodes.readerBody.replaceChildren();
    return;
  }
  if (reader.status === "loading") {
    nodes.readerState.replaceChildren(skeleton());
    return;
  }
  if (reader.status === "error") {
    nodes.readerState.replaceChildren(
      el("p", { text: describe(reader.error, t().loadError) }),
      button(t().retry, { onClick: () => void openMessage(reader.source) }),
    );
    return;
  }
  renderMessage(reader);
}

/**
 * What is shown while a body is on its way.
 *
 * A skeleton rather than "loading…": the shape of the message is already known —
 * a subject line, a sender, a body — so the pane can hold that space instead of
 * jumping when the text arrives.
 */
function skeleton() {
  const block = (className) => el("div", { class: `skeleton ${className}` });
  return el(
    "div",
    { class: "skeleton-group", "aria-hidden": "true" },
    block("skeleton-title"),
    block("skeleton-line skeleton-short"),
    block("skeleton-line"),
    block("skeleton-line"),
    block("skeleton-line skeleton-short"),
  );
}

function renderMessage(reader) {
  const message = reader.message;
  const table = t();
  nodes.readerSubject.textContent = message.subject || table.noSubject;

  const senderName = message.from?.name || message.from?.address || table.unknownSender;
  const account = accountById(message.accountId);
  nodes.readerPeople.replaceChildren(
    el("span", {
      class: "avatar avatar-lg",
      dataset: { tone: avatarColor(message.from?.address ?? senderName) },
      "aria-hidden": "true",
      text: initials(message.from?.name, message.from?.address),
    }),
    el(
      "div",
      { class: "people-main" },
      el("div", { class: "people-name", text: senderName }),
      el("div", { class: "people-address", text: message.from?.address ?? "" }),
    ),
  );

  const summary = recipientSummary(message.to, message.cc, { me: account?.email ?? "" });
  const recipientLabel = recipientLine(summary);
  nodes.readerMeta.replaceChildren(
    el("span", { text: fullTime(message.receivedAt, { locale: state.locale }) }),
    el("span", { class: "dot", "aria-hidden": "true", text: "·" }),
    el("span", { text: account?.label ?? message.accountLabel }),
  );
  if (recipientLabel) {
    nodes.readerMeta.append(
      el("span", { class: "dot", "aria-hidden": "true", text: "·" }),
      el(
        "button",
        {
          type: "button",
          class: "recipients-toggle",
          "aria-expanded": reader.showRecipients ? "true" : "false",
          title: reader.showRecipients ? table.recipientsHide : table.recipientsShow,
          text: recipientLabel,
          onClick: () => {
            reader.showRecipients = !reader.showRecipients;
            render();
          },
        },
      ),
    );
    if (reader.showRecipients) {
      nodes.readerMeta.append(recipientList(summary));
    }
  }

  const flagsSupported = message.flagsSupported !== false;
  const read = flagsSupported ? (message.flags ?? []).includes("\\Seen") : message.readLocally === true;
  const starred = flagsSupported ? (message.flags ?? []).includes("\\Flagged") : false;
  const actions = [
    // Answering comes first: a reader who opened a message is usually about to
    // reply to it, and the three buttons sit where the eye already is.
    iconButton("reply", table.replyHint, () => void openDraft("reply")),
    iconButton("replyAll", table.replyAllHint, () => void openDraft("replyAll")),
    iconButton("forward", table.forwardHint, () => void openDraft("forward")),
    iconButton(
      read ? "mailOpen" : "mail",
      read ? table.markUnread : table.markRead,
      () => void setFlag(message, read ? "unseen" : "seen"),
    ),
  ];
  if (flagsSupported) {
    actions.push(
      iconButton(starred ? "starFilled" : "star", starred ? table.unstar : table.star, () =>
        void setFlag(message, starred ? "unflagged" : "flagged"),
      ),
    );
  }
  actions.push(iconButton("trash", table.deleteMail, () => void deleteMessage(message)));
  if (account?.canArchive) {
    actions.push(iconButton("archive", table.archiveMail, () => void archiveMessage(message)));
  }
  if (message.html) {
    actions.push(
      iconButton(reader.showText ? "code" : "text", reader.showText ? table.showHtml : table.showText, () => {
        reader.showText = !reader.showText;
        render();
      }),
    );
  }
  if (message.body?.remoteImages) {
    actions.push(
      iconButton("images", table.showImages(message.body.remoteImages), () => {
        reader.allowImages = true;
        render();
      }),
    );
  }
  nodes.readerActions.replaceChildren(...actions);

  const notices = [];
  if (!flagsSupported) notices.push(table.pop3LocalRead);
  if (message.readError) notices.push(table.readFailed);
  if (message.truncated) notices.push(table.truncated(BODY_LIMIT_LABEL));
  if (reader.allowImages) notices.push(table.imagesShown);
  nodes.readerNotice.textContent = notices.join(" ");
  nodes.readerNotice.classList.toggle("is-hidden", notices.length === 0);

  // The status line belongs to whatever link was under the cursor a moment ago, so
  // it goes with the body it described.
  hideLinkStatus();
  nodes.readerBody.replaceChildren();
  if (bodyMode(message, reader.showText) === "html") {
    nodes.readerBody.append(renderFrame(message, reader));
  } else {
    nodes.readerBody.append(renderText(message.text ?? ""));
  }

  nodes.readerExtras.replaceChildren(...extras(message));
}

function recipientLine(summary) {
  const table = t();
  if (!summary.to.length && !summary.cc.length) return "";
  if (summary.directlyToMe && summary.others === 0 && summary.cc.length === 0) return table.toMe;
  if (summary.directlyToMe) return table.toMeAndOthers(summary.others + summary.cc.length);
  return table.toOthers(summary.total);
}

function recipientList(summary) {
  const table = t();
  const line = (label, list) =>
    list.length
      ? el(
          "div",
          { class: "recipients-line" },
          el("span", { class: "recipients-label", text: label }),
          el(
            "span",
            { class: "recipients-names" },
            list
              .map((entry) => entry.name || entry.address)
              .filter(Boolean)
              .join(", "),
          ),
        )
      : null;
  return el("div", { class: "recipients" }, line(table.recipientsTo, summary.to), line(table.recipientsCc, summary.cc));
}

/** The attachment cards: name, type, size, and one click that saves that file. */
function extras(message) {
  const table = t();
  const list = [];
  if (message.attachments?.length) {
    list.push(
      el("p", { class: "extra-title", text: table.attachments }),
      el(
        "ul",
        { class: "attachment-list" },
        ...message.attachments.map((file) => attachmentCard(message, file)),
      ),
    );
  }
  // No link list here: a link now works where the message wrote it, and the panel
  // answers the click (`frame.js`). Attachments are the only thing under the body.
  return list;
}

/**
 * One attachment, with the one click that saves it.
 *
 * The bytes are not here: pressing the button asks the plugin to fetch exactly
 * this part and to hand it to the host's own save dialog. While that is running
 * the card says so and cannot be pressed again — the host allows one dialog per
 * plugin, and a second click would only be refused.
 */
function attachmentCard(message, file) {
  const table = t();
  const id = `${message.accountId}:${message.key}:${file.part}`;
  const busy = state.downloading.has(id);
  const save = el("button", {
    type: "button",
    class: "attachment-save",
    title: busy ? table.savingAttachment : table.saveAttachment,
    "aria-label": `${table.saveAttachment}: ${file.filename}`,
    disabled: busy || undefined,
    onClick: () => void saveAttachment(message, file),
  });
  save.append(icon("download"), el("span", { text: busy ? table.savingAttachment : table.saveAttachment }));
  return el(
    "li",
    { class: `attachment${busy ? " is-busy" : ""}`, title: file.filename },
    el("span", {
      class: "attachment-icon",
      dataset: { kind: fileKind(file.filename) },
      text: fileKind(file.filename).toUpperCase(),
    }),
    el(
      "span",
      { class: "attachment-main" },
      el("span", { class: "attachment-name", text: file.filename }),
      el("span", { class: "attachment-meta", text: attachmentMeta(file, state.locale) }),
    ),
    save,
  );
}

/**
 * Save one attachment, because the user pressed that attachment's button.
 *
 * A cancelled dialog is not an error and says nothing: the user closed it. Every
 * other outcome — a refused size, a busy dialog, a path that could not be
 * written — arrives as a code and is shown as a sentence.
 */
async function saveAttachment(message, file) {
  const id = `${message.accountId}:${message.key}:${file.part}`;
  if (state.downloading.has(id)) return;
  const table = t();
  state.downloading.add(id);
  render();
  try {
    const result = await call("inbox.saveAttachment", {
      accountId: message.accountId,
      key: message.key,
      part: file.part,
      filename: file.filename,
    });
    if (!result.cancelled) setNotice(table.savedFile(result.name || file.filename));
  } catch (error) {
    setBanner(describe(error, table.saveFailed), true);
  } finally {
    state.downloading.delete(id);
    render();
  }
}

/**
 * The accounts the composer offers, in the shape the composer reads.
 *
 * One shape for every way in — a new message, a reply, and a `mailto:` link from a
 * message — so what the picker shows never depends on which button opened it.
 */
function composerAccounts() {
  return (state.snapshot?.accounts ?? []).map((account) => ({
    instanceId: account.instanceId,
    label: account.label,
    email: account.email,
    canSend: account.canSend !== false,
    sendBlockedReason: account.sendBlockedReason ?? null,
  }));
}

/**
 * Open the composer: a new message, or the draft the plugin builds for this one.
 *
 * A reply is not composed here. The plugin knows the original's headers, its
 * place in a thread and the account's own address, so it hands back the
 * recipients, the subject and the quoted body it wants — this function only opens
 * the form with them.
 */
async function openDraft(mode) {
  if (composer?.isOpen) return;
  const table = t();
  const accounts = composerAccounts();
  if (!accounts.length) {
    setBanner(table.emptyAccounts, true);
    return;
  }
  if (mode === "new") {
    const preferred = state.accountId === "all" ? "" : state.accountId;
    composer.open({ mode: "new", accounts, accountId: preferred });
    return;
  }
  const message = state.reader?.status === "ready" ? state.reader.message : null;
  if (!message) {
    setBanner(table.readerEmpty, true);
    return;
  }
  try {
    const result = await call("inbox.draft", {
      accountId: message.accountId,
      key: message.key,
      mode,
    });
    composer.open({ ...(result.draft ?? {}), mode, accounts });
  } catch (error) {
    setBanner(describe(error, table.openError), true);
  }
}

/** What the panel says once a message is on its way. */
function onComposerClosed(result) {
  if (!result) {
    setBanner(null);
    return;
  }
  const table = t();
  const accepted = Array.isArray(result.accepted) ? result.accepted : [];
  const parts = [accepted.length > 1 ? table.sentTo(accepted.length) : table.sent];
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  if (rejected.length) parts.push(table.sentRejected(rejected.join(", ")));
  const filed = result.filed ?? null;
  if (filed?.filed) parts.push(table.sentFiled(filed.folder));
  else if (filed?.skipped === "gmail") parts.push(table.sentNotFiledGmail);
  else if (filed && filed.skipped !== "no-folders") parts.push(table.sentNotFiled);
  // Each sentence stands on its own; a Chinese line needs no space between them,
  // an English one does.
  const spacer = String(state.locale).startsWith("zh") ? "" : " ";
  setNotice(parts.join(spacer));
}

/**
 * The message body as a frame.
 *
 * `sandbox="allow-same-origin"` and never `allow-scripts`: the origin is what lets
 * the panel read this document and answer a click inside it, and no script in the
 * message can run. The document also carries its own CSP, so nothing remote loads
 * unless the user asked for this message's images, and the frame is measured to the
 * height of the mail so the reading pane scrolls as one page (`frame.js`).
 */
function renderFrame(message, reader) {
  const html = reader.allowImages ? message.body.html : message.body.blockedHtml;
  const frame = el("iframe", { title: message.subject || t().htmlBody, referrerpolicy: "no-referrer" });
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  // No theme: a mail is drawn on white paper with its own styles, whatever the
  // app looks like (`policy.js`). The message's `<style>` blocks come along.
  frame.srcdoc = buildFrameDocument({ html, styles: message.body.styles ?? [], allowImages: reader.allowImages });
  // A `srcdoc` document is written after this call, so it is read on `load`.
  frame.addEventListener("load", () =>
    bindFrame(frame, {
      onOpen: (url) => void followLink(url),
      onStatus: showLinkStatus,
      onLeave: hideLinkStatus,
    }),
  );
  return frame;
}

/**
 * A link the user pressed inside a message.
 *
 * The two schemes a body may keep (`policy.js`) have two answers: an address the
 * browser opens, and a `mailto:` that becomes a draft in this panel's composer.
 * There is no third: anything else was removed by the sanitizer before it arrived.
 */
async function followLink(url) {
  const kind = classifyLink(url);
  if (kind === "mailto") {
    await openMailto(url);
    return;
  }
  if (kind === "http") await openExternal(url);
}

/**
 * A `mailto:` link is someone asking you to write to them: the composer opens with
 * the address, subject and body the link named.
 *
 * Nothing is sent without a press of Send — this is the same composer the New button
 * opens, filled in. With no account that can send, the OS mail client is the honest
 * fallback: it is the only other thing a `mailto:` can mean, and the host already
 * opens such addresses.
 */
async function openMailto(url) {
  const fields = parseMailto(url);
  if (!fields || composer?.isOpen) return;
  const accounts = composerAccounts();
  const sendable = accounts.filter((account) => account.canSend);
  if (!sendable.length) {
    await openExternal(url);
    return;
  }
  const preferred = state.accountId === "all" ? "" : state.accountId;
  composer.open({
    mode: "new",
    accounts,
    accountId: sendable.some((account) => account.instanceId === preferred)
      ? preferred
      : sendable[0].instanceId,
    to: fields.to.map((address) => ({ name: "", address })),
    cc: fields.cc.map((address) => ({ name: "", address })),
    subject: fields.subject,
    text: fields.body,
  });
}

/** The reading pane's status line: where a link really goes, and whether it lies. */
function showLinkStatus(url, anchor) {
  const node = nodes.readerLinkStatus;
  if (!node) return;
  if (!url) {
    hideLinkStatus();
    return;
  }
  const disguised = classifyLink(url) === "http" && linkDisguise(anchor?.textContent ?? "", url);
  node.textContent = disguised ? t().linkDisguise(url) : url;
  node.classList.toggle("is-warning", disguised);
  node.classList.remove("is-hidden");
}

/** Nothing under the cursor: the status line goes away. */
function hideLinkStatus() {
  const node = nodes.readerLinkStatus;
  if (!node) return;
  node.classList.add("is-hidden");
  node.classList.remove("is-warning");
  node.textContent = "";
}

/**
 * A plain-text body: one paragraph per line block, links as buttons.
 *
 * Not a `<pre>`: a mail typed by a person is prose, not code, so it gets the
 * panel's proportional font and wraps. A link is still opened by the host in the
 * user's browser (`inbox.openExternal`), never inside the panel.
 */
function renderText(text) {
  const container = el("div", { class: "mail-text" });
  const blocks = String(text).split(/\n{2,}/);
  for (const block of blocks) {
    const paragraph = el("p");
    for (const segment of linkifyText(block)) {
      if (segment.url) {
        paragraph.append(
          el("button", {
            type: "button",
            class: "link-btn",
            title: segment.url,
            text: segment.text,
            onClick: () => void openExternal(segment.url),
          }),
        );
      } else {
        paragraph.append(document.createTextNode(segment.text));
      }
    }
    container.append(paragraph);
  }
  return container;
}

async function openMessage(source) {
  state.selected = source;
  state.reader = { status: "loading", source };
  render();
  try {
    const result = await call("inbox.openMessage", { accountId: source.accountId, key: source.key });
    const message = result.message;
    const body = prepareBody(message.html ?? "");
    state.reader = {
      status: "ready",
      source,
      message: { ...message, body, text: message.text ?? "" },
      allowImages: false,
      showText: false,
      showRecipients: false,
    };
    render();
    // Opening the message marked it read: the row's dot and the unread count are
    // refreshed now rather than at the next poll.
    await refresh({ quiet: true });
  } catch (error) {
    state.reader = { status: "error", source, error };
    render();
  }
}

function closeReader() {
  state.reader = null;
  state.selected = null;
  render();
}

async function setFlag(message, flag) {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await call("inbox.setFlag", { accountId: message.accountId, key: message.key, flag });
    const reader = state.reader;
    if (reader?.status === "ready" && reader.message.key === message.key) {
      reader.message = typeof result.readLocally === "boolean"
        ? { ...reader.message, readLocally: result.readLocally }
        : { ...reader.message, flags: result.flags };
    }
    setBanner(null);
    await refresh({ quiet: true });
    render();
  } catch (error) {
    setBanner(describe(error, t().flagFailed), true);
  } finally {
    state.busy = false;
  }
}

/**
 * Delete one message, after confirming when the mailbox cannot undo it.
 *
 * IMAP moves the message to the trash and the panel says so; POP3 removes it from
 * the server for good, which is why that case asks first and says "cannot be
 * undone" when it is done.
 */
/**
 * Delete one message, after confirming on the one protocol that cannot undo it.
 *
 * An IMAP delete is a move to the trash and the panel says so afterwards. POP3 has
 * no trash: `DELE` plus `QUIT` is final, so the panel asks first — in its own card,
 * not with `window.confirm`, which cannot be styled, translated or focused, and
 * whose copy here would be the wrong tense.
 */
async function deleteMessage(message, { confirmed = false } = {}) {
  if (state.busy) return;
  const table = t();
  const account = accountById(message.accountId);
  if (account?.protocol === "pop3" && !confirmed) {
    state.confirmDelete = message;
    render();
    return;
  }
  state.confirmDelete = null;
  state.busy = true;
  try {
    const result = await call("inbox.delete", { accountId: message.accountId, key: message.key });
    if (sameMessage(state.reader?.source, message)) closeReader();
    setNotice(result.final ? table.deleteDonePop3 : table.deleteDone);
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error, table.deleteFailed), true);
  } finally {
    state.busy = false;
  }
}

async function archiveMessage(message) {
  if (state.busy) return;
  const table = t();
  state.busy = true;
  try {
    await call("inbox.archive", { accountId: message.accountId, key: message.key });
    if (sameMessage(state.reader?.source, message)) closeReader();
    setNotice(table.archiveDone);
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error, table.archiveFailed), true);
  } finally {
    state.busy = false;
  }
}

async function loadOlder() {
  if (state.busy || state.loadingOlder) return;
  const account = state.accountId === "all" ? null : accountById(state.accountId);
  if (!account) return;
  const table = t();
  state.loadingOlder = true;
  render();
  try {
    const result = await call("inbox.loadOlder", { accountId: account.instanceId });
    if (result.reachedLimit) setNotice(table.limitReached);
    else if (!result.added) setNotice(table.noOlder);
    else setNotice(table.oldMailLoaded(result.added));
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error, table.olderFailed), true);
  } finally {
    state.loadingOlder = false;
    render();
  }
}

async function addAccount() {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await call("inbox.addAccount");
    setBanner(null);
    await refresh({ quiet: true });
    if (result.instanceId) {
      const account = accountById(result.instanceId);
      if (account && !account.provider && !account.missingServer) setBanner(t().customServerHint);
    }
  } catch (error) {
    setBanner(describe(error), true);
  } finally {
    state.busy = false;
  }
}

async function removeAccount(account) {
  try {
    await call("inbox.removeAccount", { instanceId: account.instanceId });
    if (state.accountId === account.instanceId) state.accountId = "all";
    setBanner(null);
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error, t().removeFailed), true);
  }
}

async function checkAccount(account) {
  const table = t();
  try {
    const result = await call("inbox.check", { instanceId: account.instanceId });
    setBanner(result.handled > 0 ? table.messages(result.handled) : table.checkOne(account.label));
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error, table.checkFailed), true);
  }
}

async function checkNow() {
  const table = t();
  try {
    const result = await call("inbox.check");
    setBanner(result.handled > 0 ? table.messages(result.handled) : table.checkedNone);
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error, table.checkFailed), true);
  }
}

async function openWebmail(account) {
  try {
    await call("inbox.openWebmail", { instanceId: account.instanceId });
  } catch (error) {
    setBanner(describe(error, t().webmailFailed), true);
  }
}

async function openExternal(url) {
  try {
    await call("inbox.openExternal", { url });
  } catch (error) {
    setBanner(describe(error), true);
  }
}

/** Whether a key press belongs to a text field rather than to the panel. */
function inField(target) {
  const tag = String(target?.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true;
}

function moveSelection(delta) {
  const rows = visibleMessages(state.snapshot?.messages ?? [], listOptions());
  if (!rows.length) return;
  const current = rows.findIndex((message) => sameMessage(state.selected, message));
  const next = stepIndex(current, delta, rows.length);
  const message = rows[next];
  if (!message) return;
  state.selected = message;
  render();
  const row = nodes.groups.querySelector(`.mail[data-key="${CSS.escape(message.key)}"][data-account="${CSS.escape(message.accountId)}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

/** The message the keyboard acts on: the open one, or the highlighted row. */
function targetMessage() {
  if (state.reader?.status === "ready") return state.reader.message;
  if (state.selected) return state.selected;
  return null;
}

function handleKey(event) {
  // The composer is modal: while it is open every key belongs to it, so a `c`
  // typed into a subject line cannot open a second composer behind it.
  if (composer?.isOpen) {
    composer.handleKey(event);
    return;
  }
  const action = keyboardAction(event, { inField: inField(event.target) });
  if (!action) return;
  const table = t();
  switch (action) {
    case "next":
      event.preventDefault();
      moveSelection(1);
      return;
    case "prev":
      event.preventDefault();
      moveSelection(-1);
      return;
    case "open": {
      const message = state.selected;
      if (!message) return;
      event.preventDefault();
      void openMessage(message);
      return;
    }
    case "toggleRead": {
      const message = targetMessage();
      if (!message || message.flagsSupported === false) return;
      event.preventDefault();
      const read = (message.flags ?? []).includes("\\Seen") || message.readLocally === true;
      void setFlag(message, read ? "unseen" : "seen");
      return;
    }
    case "toggleStar": {
      const message = targetMessage();
      if (!message || message.flagsSupported === false) return;
      event.preventDefault();
      const starred = (message.flags ?? []).includes("\\Flagged");
      void setFlag(message, starred ? "unflagged" : "flagged");
      return;
    }
    case "delete": {
      const message = targetMessage();
      if (!message) return;
      event.preventDefault();
      void deleteMessage(message);
      return;
    }
    case "archive": {
      const message = targetMessage();
      const account = message ? accountById(message.accountId) : null;
      if (!message || !account?.canArchive) return;
      event.preventDefault();
      void archiveMessage(message);
      return;
    }
    // Writing and answering: `c` anywhere, the other three on the message that is
    // open, which is the one the shortcut is about.
    case "compose":
      event.preventDefault();
      void openDraft("new");
      return;
    case "reply":
    case "replyAll":
    case "forward":
      event.preventDefault();
      void openDraft(action);
      return;
    case "search":
      event.preventDefault();
      nodes.search.focus();
      nodes.search.select();
      return;
    case "clear":
      // Escape in the search box clears it and gives the keyboard back.
      event.preventDefault();
      state.query = "";
      nodes.search.value = "";
      nodes.search.blur();
      render();
      return;
    case "close":
      event.preventDefault();
      if (state.confirmDelete) {
        closeConfirm();
      } else if (state.reader) closeReader();
      else if (state.query) {
        state.query = "";
        render();
      } else if (state.menu || state.confirming) {
        state.menu = null;
        state.confirming = null;
        render();
      }
      return;
    default:
      return;
  }
}

function wire() {
  // The two icon-only buttons in the chrome: the sidebar toggle and the search
  // box's clear button. Both carry their sentence in `aria-label`.
  nodes.sidebar.append(icon("sidebar"));
  nodes.searchClear.append(icon("close"));
  nodes.sidebar.setAttribute("aria-label", t().sidebarToggle);
  nodes.searchClear.setAttribute("aria-label", t().searchClear);
  nodes.check.addEventListener("click", () => void checkNow());
  nodes.add.addEventListener("click", () => void addAccount());
  // The composer is created once: building it per open would rebuild every field
  // and drop the caret the user just put somewhere.
  nodes.compose.addEventListener("click", () => void openDraft("new"));
  composer = createComposer(nodes.composeLayer, {
    stringsFor: t,
    localeFor: () => state.locale,
    onSend: (payload) => call("inbox.send", payload),
    onClosed: onComposerClosed,
  });
  nodes.older.addEventListener("click", () => void loadOlder());
  nodes.back.addEventListener("click", () => closeReader());
  nodes.confirmNo.addEventListener("click", () => closeConfirm());
  nodes.confirmYes.addEventListener("click", () => {
    const target = state.confirmDelete;
    if (!target) return;
    state.confirmDelete = null;
    void deleteMessage(target, { confirmed: true });
  });
  nodes.sidebar.addEventListener("click", () => {
    state.sidebar = !state.sidebar;
    render();
  });
  nodes.search.addEventListener("input", () => {
    state.query = nodes.search.value;
    render();
  });
  nodes.searchClear.addEventListener("click", () => {
    state.query = "";
    nodes.search.value = "";
    nodes.search.focus();
    render();
  });
  // A click anywhere but a menu closes it, which is what a popover owes a user.
  document.addEventListener("click", (event) => {
    if (!state.menu && !state.confirming) return;
    if (event.target.closest?.(".menu, .account-menu-btn, .account-confirm")) return;
    state.menu = null;
    state.confirming = null;
    render();
  });
  document.addEventListener("keydown", handleKey);
  const bridge = globalThis.window?.pluginBridge;
  if (bridge && typeof bridge.on === "function") {
    bridge.on("appearance:changed", (appearance) => applyAppearance(appearance ?? null));
  }
  globalThis.matchMedia?.(NARROW).addEventListener?.("change", () => render());
}

async function boot() {
  wire();
  await loadAppearance();
  await refresh();
  globalThis.setInterval(() => {
    if (document.hidden) return;
    void refresh({ quiet: true });
  }, POLL_MS);
}

void boot();