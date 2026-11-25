/**
 * The Inbox panel: mailboxes on the left, the unified list in the middle, one
 * message on the right.
 *
 * Everything here is a view of state the plugin owns. The page never decides what
 * a mailbox is, never decides that a message is read, and never holds a body it
 * fetched: it asks the plugin (`window.pluginBridge.invoke`) and renders the
 * answer. The two things it does own are the ones that need a document — the
 * sanitized frame and the reading controls — and even those never run anything
 * from the message.
 *
 * The panel polls because the host has no plugin → panel push channel; a five
 * second tick is the difference between "mail appears" and "reload the panel",
 * and it costs one bridge call.
 */

import { bodyMode, buildFrameDocument, FRAME_SANDBOX, linkifyText } from "./policy.js";
import { prepareBody } from "./sanitize.js";
import { codeText, strings } from "./strings.js";

const POLL_MS = 5000;
const BODY_LIMIT_LABEL = "1 MiB";

const state = {
  locale: "en",
  theme: "dark",
  snapshot: null,
  filter: "all",
  reader: null,
  banner: null,
  busy: false,
};

const nodes = {
  title: document.getElementById("page-title"),
  counts: document.getElementById("counts"),
  banner: document.getElementById("banner"),
  check: document.getElementById("btn-check"),
  add: document.getElementById("btn-add"),
  accountsTitle: document.getElementById("accounts-title"),
  accountsHint: document.getElementById("accounts-hint"),
  accountList: document.getElementById("account-list"),
  accountsEmpty: document.getElementById("accounts-empty"),
  all: document.getElementById("btn-all"),
  groups: document.getElementById("groups"),
  importantGroup: document.getElementById("group-important"),
  importantTitle: document.getElementById("group-important-title"),
  importantList: document.getElementById("list-important"),
  otherGroup: document.getElementById("group-other"),
  otherTitle: document.getElementById("group-other-title"),
  otherList: document.getElementById("list-other"),
  messagesEmpty: document.getElementById("messages-empty"),
  reader: document.getElementById("reader"),
  readerEmpty: document.getElementById("reader-empty"),
  readerState: document.getElementById("reader-state"),
  readerMessage: document.getElementById("reader-message"),
  readerSubject: document.getElementById("reader-subject"),
  readerFrom: document.getElementById("reader-from"),
  readerTime: document.getElementById("reader-time"),
  readerAccount: document.getElementById("reader-account"),
  readerActions: document.getElementById("reader-actions"),
  readerNotice: document.getElementById("reader-notice"),
  readerBody: document.getElementById("reader-body"),
  readerExtras: document.getElementById("reader-extras"),
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

function button(label, { onClick, quiet = false, primary = false, title } = {}) {
  return el("button", {
    type: "button",
    class: `btn${quiet ? " btn-quiet" : ""}${primary ? " btn-primary" : ""}`,
    title,
    text: label,
    onClick,
  });
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

function formatTime(value) {
  if (!Number.isFinite(value)) return "";
  try {
    return new Intl.DateTimeFormat(state.locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
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
}

async function loadAppearance() {
  try {
    applyAppearance(await call("app.getAppearance"));
  } catch {
    applyAppearance(null);
  }
}

function setBanner(message, isError = false) {
  state.banner = message ? { message, isError } : null;
  nodes.banner.textContent = message ?? "";
  nodes.banner.classList.toggle("is-hidden", !message);
  nodes.banner.classList.toggle("is-error", Boolean(message) && isError);
}

async function refresh({ quiet = false } = {}) {
  try {
    const result = await call("inbox.snapshot");
    state.snapshot = result.snapshot ?? null;
    if (!quiet) setBanner(null);
    render();
  } catch (error) {
    if (!quiet) setBanner(describe(error, t().refreshFailed), true);
  }
}

function accountById(instanceId) {
  return state.snapshot?.accounts.find((account) => account.instanceId === instanceId) ?? null;
}

function statusLabel(account) {
  const table = t().status;
  const phase = account.status?.phase ?? "stopped";
  let label;
  if (phase === "error" && account.status?.lastError) {
    const reason = String(account.status.lastError).split(": ").slice(1).join(": ");
    label = `${table.error}${reason ? ` · ${reason}` : ""}`;
  } else {
    label = table[phase] ?? table.stopped;
  }
  // The tooltip is where the proxy belongs: it explains a connection that fails
  // for a reason the account's own form cannot show.
  if (account.proxy) label += ` · ${t().viaProxy(account.proxy)}`;
  return label;
}

/** The card's one-word state; the long version is the tooltip. */
function shortStatus(account) {
  const table = t().status;
  const phase = account.status?.phase ?? "stopped";
  return table.short[phase] ?? table.short.stopped;
}

function renderStatic() {
  const table = t();
  nodes.title.textContent = table.title;
  nodes.check.textContent = table.check;
  nodes.add.textContent = table.add;
  nodes.accountsTitle.textContent = table.accounts;
  nodes.accountsHint.textContent = table.accountsHint(state.snapshot?.accounts.length ?? 0);
  nodes.accountsEmpty.textContent = table.emptyAccounts;
  nodes.messagesEmpty.textContent = table.emptyMessages;
  nodes.importantTitle.textContent = table.groupImportant;
  nodes.otherTitle.textContent = table.groupOther;
  nodes.readerEmpty.textContent = table.emptyMessages;
}

function render() {
  renderStatic();
  renderHeaderCounts();
  renderAccounts();
  renderList();
  renderReader();
  if (state.snapshot) {
    nodes.accountsEmpty.hidden = state.snapshot.accounts.length > 0;
  }
}

function renderHeaderCounts() {
  const messages = state.snapshot?.messages ?? [];
  const unread = messages.filter((message) => message.unread).length;
  const parts = [];
  if (state.snapshot) {
    parts.push(t().messages(messages.length));
    if (unread) parts.push(t().unreadCount(unread));
  }
  nodes.counts.textContent = parts.join(" · ");
}

function renderAccounts() {
  const accounts = state.snapshot?.accounts ?? [];
  nodes.accountList.replaceChildren();
  for (const account of accounts) {
    const selected = state.filter === account.instanceId;
    const pending = account.status?.phase === "needs-provider" || account.status?.phase === "needs-server";
    const card = el("li", { class: `account${selected ? " is-selected" : ""}${pending ? " is-pending" : ""}` });

    // The card is the control: the whole row filters the list. A button keeps it
    // reachable from the keyboard and announced as a button by the screen reader.
    const target = el("button", {
      type: "button",
      class: "account-main",
      "aria-pressed": selected ? "true" : "false",
      title: account.label,
      onClick: () => {
        state.filter = selected ? "all" : account.instanceId;
        render();
      },
    });
    target.append(
      el("span", { class: "account-label", text: account.label }),
      el("span", {
        class: "status",
        dataset: { phase: account.status?.phase ?? "stopped" },
        title: statusLabel(account),
        text: shortStatus(account),
      }),
    );
    card.append(target);

    // The reason lives here, muted, and in full in the tooltip: a sidebar card is
    // not the place for a paragraph.
    if (account.status?.phase === "error" && account.status?.lastError) {
      card.append(el("p", { class: "account-error", title: statusLabel(account), text: statusLabel(account) }));
    }
    if (account.missingServer) {
      card.append(el("p", { class: "account-hint", text: t().status["needs-server"] }));
    }
    nodes.accountList.append(card);
  }

  nodes.all.replaceChildren();
  nodes.all.textContent = t().all;
  nodes.all.hidden = accounts.length === 0;
  nodes.all.classList.toggle("is-on", state.filter === "all");
  nodes.all.setAttribute("aria-pressed", state.filter === "all" ? "true" : "false");
}

function renderList() {
  const messages = (state.snapshot?.messages ?? []).filter(
    (message) => state.filter === "all" || message.accountId === state.filter,
  );
  const important = messages.filter((message) => message.important);
  const other = messages.filter((message) => !message.important);
  nodes.importantList.replaceChildren(...important.map((message) => mailRow(message)));
  nodes.otherList.replaceChildren(...other.map((message) => mailRow(message)));
  nodes.importantGroup.hidden = important.length === 0;
  nodes.otherGroup.hidden = other.length === 0;
  nodes.messagesEmpty.hidden = messages.length > 0;
  nodes.messagesEmpty.textContent = state.snapshot?.accounts.length ? t().emptyMessages : t().emptyAccounts;
}

function mailRow(message) {
  const selected =
    state.reader?.status === "ready" &&
    state.reader.message.accountId === message.accountId &&
    state.reader.message.key === message.key;
  const sender = message.from?.name || message.from?.address || t().unknownSender;
  const row = el("li", {
    class: `mail ${message.unread ? "is-unread" : "is-read"}${selected ? " is-active" : ""}`,
    tabIndex: 0,
    role: "button",
    onClick: () => void openMessage(message),
    onKeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openMessage(message);
      }
    },
  });
  row.append(
    el("span", { class: "mail-dot", "aria-hidden": "true" }),
    el(
      "div",
      { class: "mail-main" },
      // The sender is its own element so a long address truncates with an
      // ellipsis inside the row instead of spilling over the date column.
      el("div", { class: "mail-from" }, el("span", { class: "mail-from-name", text: sender })),
      el("div", { class: "mail-subject", text: message.subject || t().noSubject }),
      el("div", { class: "mail-account", text: message.accountLabel }),
    ),
    el(
      "div",
      { class: "mail-meta" },
      el("span", { text: formatTime(message.receivedAt) }),
      message.starred ? el("span", { class: "mail-star", text: "★", title: t().starred }) : null,
    ),
  );
  return row;
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
    nodes.readerState.replaceChildren(el("p", { text: t().loading }));
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

function renderMessage(reader) {
  const message = reader.message;
  const table = t();
  nodes.readerSubject.textContent = message.subject || table.noSubject;
  nodes.readerFrom.textContent = message.from?.name
    ? `${message.from.name} <${message.from.address}>`
    : message.from?.address || table.unknownSender;
  nodes.readerTime.textContent = formatTime(message.receivedAt);
  nodes.readerAccount.textContent = message.accountLabel;

  // Opening a message marks it read, so the pane offers the way back rather than a
  // "mark read" that has already happened. POP3 reports no flags: read there is a
  // mark this machine keeps, and a star has no equivalent.
  const flagsSupported = message.flagsSupported !== false;
  const read = flagsSupported ? (message.flags ?? []).includes("\\Seen") : message.readLocally === true;
  const starred = flagsSupported ? (message.flags ?? []).includes("\\Flagged") : false;
  const actions = [];
  if (read) {
    actions.push(button(table.markUnread, { onClick: () => void setFlag(message, "unseen") }));
  } else if (flagsSupported) {
    actions.push(button(table.markRead, { onClick: () => void setFlag(message, "seen") }));
  }
  if (flagsSupported) {
    actions.push(
      button(starred ? table.unstar : table.star, {
        onClick: () => void setFlag(message, starred ? "unflagged" : "flagged"),
      }),
    );
  }
  if (message.html) {
    // HTML is what the message was written in, so the toggle offers the text
    // alternative — and the way back.
    actions.push(
      button(reader.showText ? table.showHtml : table.showText, {
        onClick: () => {
          reader.showText = !reader.showText;
          render();
        },
      }),
    );
  }
  if (message.body?.remoteImages) {
    actions.push(
      button(table.showImages(message.body.remoteImages), {
        quiet: true,
        onClick: () => {
          reader.allowImages = true;
          render();
        },
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

  nodes.readerBody.replaceChildren();
  if (bodyMode(message, reader.showText) === "html") {
    nodes.readerBody.append(renderFrame(message, reader));
  } else {
    nodes.readerBody.append(renderText(message.text ?? ""));
  }

  const extras = [];
  if (message.attachments?.length) {
    extras.push(
      el("p", { class: "extra-title", text: table.attachments }),
      el(
        "ul",
        { class: "extra-list" },
        ...message.attachments.map((file) =>
          el("li", {}, el("span", { text: file.filename }), el("span", { text: table.size(file.size) })),
        ),
      ),
    );
  }
  if (message.body?.links?.length) {
    extras.push(
      el("p", { class: "extra-title", text: table.links }),
      el(
        "ul",
        { class: "extra-list" },
        ...message.body.links.map((link) =>
          el(
            "li",
            {},
            el("button", {
              type: "button",
              class: "link-btn",
              title: link.url,
              text: link.text,
              onClick: () => void openExternal(link.url),
            }),
            el("span", { text: link.kind === "mailto" ? "mailto" : "web" }),
          ),
        ),
      ),
    );
  }
  nodes.readerExtras.replaceChildren(...extras);
}

/**
 * The message body as a frame.
 *
 * `sandbox=""` — no scripts, no same-origin — and the document carries its own
 * CSP, so the frame cannot script, cannot reach the panel, and cannot load a
 * remote image unless the user asked for this message's images.
 */
function renderFrame(message, reader) {
  const html = reader.allowImages ? message.body.html : message.body.blockedHtml;
  const frame = el("iframe", { title: message.subject || t().htmlBody, referrerpolicy: "no-referrer" });
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  // No theme: a mail is drawn on white paper with its own styles, whatever the
  // app looks like (`policy.js`). The message's `<style>` blocks come along.
  frame.srcdoc = buildFrameDocument({ html, styles: message.body.styles ?? [], allowImages: reader.allowImages });
  return frame;
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

async function checkNow() {
  try {
    const result = await call("inbox.check");
    const table = t();
    setBanner(result.handled > 0 ? table.messages(result.handled) : table.checkedNone);
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error), true);
  }
}

async function openExternal(url) {
  try {
    await call("inbox.openExternal", { url });
  } catch (error) {
    setBanner(describe(error), true);
  }
}

function wire() {
  nodes.check.addEventListener("click", () => void checkNow());
  nodes.add.addEventListener("click", () => void addAccount());
  nodes.all.addEventListener("click", () => {
    state.filter = "all";
    render();
  });
  const bridge = globalThis.window?.pluginBridge;
  if (bridge && typeof bridge.on === "function") {
    bridge.on("appearance:changed", (appearance) => applyAppearance(appearance ?? null));
  }
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
