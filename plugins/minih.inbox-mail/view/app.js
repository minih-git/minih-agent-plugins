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

import { buildFrameDocument, FRAME_SANDBOX } from "./policy.js";
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
  confirmRemove: null,
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
  filter: document.getElementById("account-filter"),
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
  if (phase === "error" && account.status?.lastError) {
    const reason = String(account.status.lastError).split(": ").slice(1).join(": ");
    return `${table.error}${reason ? ` · ${reason}` : ""}`;
  }
  return table[phase] ?? table.stopped;
}

function renderStatic() {
  const table = t();
  nodes.title.textContent = table.title;
  nodes.check.textContent = table.check;
  nodes.add.textContent = table.add;
  nodes.accountsTitle.textContent = table.accounts;
  nodes.accountsHint.textContent = table.addHint;
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
    const card = el("li", { class: `account${selected ? " is-selected" : ""}${account.provider ? "" : " is-pending"}` });

    const status = el("span", { class: "status", dataset: { phase: account.status?.phase ?? "stopped" } });
    status.textContent = statusLabel(account);

    card.append(
      el(
        "div",
        { class: "account-head" },
        el("span", { class: "account-label", title: account.label, text: account.label }),
        status,
      ),
    );

    if (account.provider?.custom) {
      // A server the user typed is a fact, not a choice: it is shown, and the
      // only place to change it is the account dialog the host owns.
      card.append(
        el("div", { class: "account-provider" }, el("span", { class: "provider-custom", text: account.provider.title })),
      );
    } else {
      const select = el("select", {
        "aria-label": `${t().provider}: ${account.label}`,
        onChange: (event) => void changeProvider(account.instanceId, event.target.value),
      });
      select.append(el("option", { value: "", text: account.provider ? t().providerHint : t().status["needs-provider"], selected: !account.provider }));
      for (const provider of state.snapshot.providers) {
        select.append(
          el("option", {
            value: provider.id,
            text: provider.title,
            selected: account.provider?.id === provider.id,
            disabled: !provider.available && account.provider?.id !== provider.id,
          }),
        );
      }
      card.append(el("div", { class: "account-provider" }, select));
      // A domain this plugin cannot place is exactly the case a company mailbox
      // starts with, so the panel offers the other way in the same breath.
      if (!account.provider) card.append(el("p", { class: "account-hint", text: t().customServerHint }));
    }

    if (account.flagsSupported === false) {
      card.append(el("p", { class: "account-hint", text: t().pop3Note }));
    }

    if (account.status?.phase === "error" && account.status?.lastError) {
      card.append(el("p", { class: "account-error", text: statusLabel(account) }));
    }

    const foot = el("div", { class: "account-foot" });
    foot.append(
      button(selected ? t().all : t().onlyThis, {
        quiet: true,
        onClick: () => {
          state.filter = selected ? "all" : account.instanceId;
          render();
        },
      }),
    );
    if (account.webmail) {
      foot.append(button(t().openWebmail, { quiet: true, onClick: () => void openWebmail(account.instanceId) }));
    }
    if (state.confirmRemove === account.instanceId) {
      const yes = button(t().removeYes, { quiet: true, onClick: () => void removeAccount(account.instanceId) });
      yes.style.color = "var(--danger)";
      foot.append(yes, button(t().removeNo, { quiet: true, onClick: () => { state.confirmRemove = null; render(); } }));
    } else {
      foot.append(button(t().remove, { quiet: true, onClick: () => { state.confirmRemove = account.instanceId; render(); } }));
    }
    card.append(foot);
    nodes.accountList.append(card);
  }

  const filter = nodes.filter;
  filter.replaceChildren(el("option", { value: "all", text: t().all, selected: state.filter === "all" }));
  for (const account of accounts) {
    filter.append(
      el("option", { value: account.instanceId, text: account.label, selected: state.filter === account.instanceId }),
    );
  }
  filter.value = state.filter;
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

  // POP3 has no read or starred state, so those two buttons are not offered and
  // the pane says why instead of showing a control that could only fail.
  const flagsSupported = message.flagsSupported !== false;
  const read = (message.flags ?? []).includes("\\Seen");
  const starred = (message.flags ?? []).includes("\\Flagged");
  const actions = flagsSupported
    ? [
        button(read ? table.markUnread : table.markRead, {
          onClick: () => void setFlag(message, read ? "unseen" : "seen"),
        }),
        button(starred ? table.unstar : table.star, {
          onClick: () => void setFlag(message, starred ? "unflagged" : "flagged"),
        }),
      ]
    : [];
  if (message.html) {
    actions.push(
      button(reader.showHtml ? table.showText : table.showHtml, {
        onClick: () => {
          reader.showHtml = !reader.showHtml;
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
  if (!flagsSupported) notices.push(table.pop3NoFlags);
  if (message.truncated) notices.push(table.truncated(BODY_LIMIT_LABEL));
  if (reader.allowImages) notices.push(table.imagesShown);
  nodes.readerNotice.textContent = notices.join(" ");
  nodes.readerNotice.classList.toggle("is-hidden", notices.length === 0);

  nodes.readerBody.replaceChildren();
  const useHtml = message.html && (!message.text || reader.showHtml);
  if (useHtml) {
    nodes.readerBody.append(renderFrame(message, reader));
  } else {
    nodes.readerBody.append(el("pre", { class: "mail-text", text: message.text ?? "" }));
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
  frame.srcdoc = buildFrameDocument({ html, allowImages: reader.allowImages, theme: state.theme });
  return frame;
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
      showHtml: false,
    };
    render();
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
      reader.message = { ...reader.message, flags: result.flags };
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

async function changeProvider(instanceId, providerId) {
  if (!providerId) return;
  try {
    await call("inbox.setProvider", { instanceId, providerId });
    setBanner(null);
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error), true);
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
      if (account && !account.provider) setBanner(t().providerHint);
    }
  } catch (error) {
    setBanner(describe(error), true);
  } finally {
    state.busy = false;
  }
}

async function removeAccount(instanceId) {
  try {
    await call("inbox.removeAccount", { instanceId });
    state.confirmRemove = null;
    if (state.filter === instanceId) state.filter = "all";
    if (state.reader?.message?.accountId === instanceId) state.reader = null;
    await refresh({ quiet: true });
  } catch (error) {
    setBanner(describe(error), true);
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

async function openWebmail(instanceId) {
  try {
    await call("inbox.openWebmail", { instanceId });
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
  nodes.filter.addEventListener("change", (event) => {
    state.filter = event.target.value || "all";
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
