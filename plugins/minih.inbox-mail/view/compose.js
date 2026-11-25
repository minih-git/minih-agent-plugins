/**
 * The composer: one message being written, over the panel.
 *
 * Four ways in — a new message, a reply, a reply to all and a forward — and one
 * form: who it is from, who it goes to, a subject, a plain-text body and a list of
 * files. It is deliberately not a second writing surface: there is no rich text,
 * no signature and no scheduling, because the plugin's whole grant is one message
 * built by `lib/compose.js` and delivered by the app when the user presses send.
 *
 * What this module owns is the form: the chips of recipients (typed, pasted or
 * removed), reading the files the user picked as bytes, the running total against
 * the 25 MiB the app accepts, and the one confirmation a half-written message
 * deserves. What it does not own is any decision about the message itself: the
 * addresses, the subject prefix and the quoted original arrive in the draft from
 * the plugin, and the send goes back through the bridge, so this file never has
 * to know what `Re:` means.
 *
 * Keyboard: the composer is a modal surface inside the panel, so while it is open
 * the panel's own shortcuts are off (the caller stops dispatching them) and Escape
 * asks before throwing away work.
 */

import { chipLabel, formatBytes, isValidAddress, parseRecipientInput, totalBytes } from "./model.js";
import { codeText } from "./strings.js";

/** What one message and its attachments may weigh, as the host enforces it. */
export const ATTACHMENT_LIMIT = 25 * 1024 * 1024;
/** How the limit reads in a sentence. */
const LIMIT_LABEL = "25 MiB";

/**
 * base64 of one file's bytes.
 *
 * The bridge is JSON on the way into the plugin process, so binary travels as
 * base64: a `Uint8Array` would survive the renderer IPC and then depend on every
 * hop after it, and one encoding used everywhere is worth more than a smaller
 * hop.
 */
function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** One picked file as the plugin's `attachments` entry. */
async function readAttachment(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    name: String(file.name || "attachment"),
    type: String(file.type || "application/octet-stream"),
    size: bytes.length,
    data: toBase64(bytes),
  };
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * One chip field: recipients as chips plus the input that adds them.
 *
 * A chip is removed by its own button or by Backspace in an empty input, which is
 * how every mail client does it and what a user's fingers expect. A value that is
 * not an address stays in the input with the field marked invalid: dropping it
 * silently would lose what the user typed.
 */
function createChipField({ label, placeholder, onChange }) {
  const chips = el("div", { class: "chips" });
  const input = el("input", {
    type: "text",
    class: "chip-input",
    "aria-label": label,
    placeholder,
    autocomplete: "off",
    spellcheck: "false",
  });
  const field = el("div", { class: "chip-field" }, chips, input);
  let entries = [];

  const render = () => {
    chips.replaceChildren(
      ...entries.map((entry, index) =>
        el(
          "span",
          { class: "chip", title: entry.address },
          el("span", { class: "chip-text", text: chipLabel(entry) }),
          el("button", {
            type: "button",
            class: "chip-remove",
            "aria-label": `${label}: ${entry.address}`,
            text: "×",
            onClick: () => {
              entries = entries.filter((_, position) => position !== index);
              render();
              onChange(entries);
            },
          }),
        ),
      ),
    );
  };

  const commit = () => {
    const value = input.value.trim();
    if (!value) return;
    const parsed = parseRecipientInput(value);
    if (parsed.invalid.length || !parsed.entries.length) {
      field.classList.add("is-invalid");
      return;
    }
    for (const entry of parsed.entries) {
      if (!entries.some((existing) => existing.address.toLowerCase() === entry.address.toLowerCase())) {
        entries.push(entry);
      }
    }
    input.value = "";
    field.classList.remove("is-invalid");
    render();
    onChange(entries);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";" || event.key === "Tab") {
      if (!input.value.trim() && event.key !== "Enter") return;
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Backspace" && !input.value && entries.length) {
      event.preventDefault();
      entries = entries.slice(0, -1);
      render();
      onChange(entries);
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) commit();
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!/[,;\r\n]/.test(text)) return;
    event.preventDefault();
    input.value = `${input.value}${text}`;
    commit();
  });
  field.addEventListener("click", () => input.focus());

  return {
    element: field,
    input,
    get entries() {
      return entries.slice();
    },
    set(list) {
      entries = (Array.isArray(list) ? list : [])
        .filter((entry) => entry && isValidAddress(entry.address))
        .map((entry) => ({ name: String(entry.name ?? ""), address: String(entry.address) }));
      input.value = "";
      field.classList.remove("is-invalid");
      render();
    },
    clear() {
      entries = [];
      input.value = "";
      render();
    },
  };
}

/**
 * @param container the element the overlay is drawn into (`#compose`).
 * @param options.stringsFor `() => strings(locale)` — the caller owns the locale.
 * @param options.onSend `(payload) => Promise<result>`; a rejection carries a code.
 * @param options.onClosed `(result | null) => void`, after a send or a discard.
 */
export function createComposer(container, { stringsFor, localeFor, onSend, onClosed }) {
  const t = () => stringsFor();
  const locale = () => (typeof localeFor === "function" ? localeFor() : "en");
  const state = {
    open: false,
    mode: "new",
    accounts: [],
    accountId: "",
    subject: "",
    text: "",
    attachments: [],
    forwardOf: null,
    forwardSelection: new Set(),
    inReplyTo: "",
    references: [],
    sending: false,
    error: null,
    confirming: false,
    showCc: false,
    showBcc: false,
  };

  const title = el("h2", { id: "compose-title" });
  const closeButton = el("button", { type: "button", class: "icon-btn compose-close", "aria-label": "" , text: "×" });
  const accountSelect = el("select", { class: "compose-select", "aria-label": "" });
  const accountHint = el("p", { class: "compose-hint" });
  const toField = createChipField({ label: "To", placeholder: "", onChange: () => renderFoot() });
  const ccField = createChipField({ label: "Cc", placeholder: "", onChange: () => renderFoot() });
  const bccField = createChipField({ label: "Bcc", placeholder: "", onChange: () => renderFoot() });
  const subjectInput = el("input", { type: "text", class: "compose-subject", autocomplete: "off", spellcheck: "false" });
  const bodyInput = el("textarea", { class: "compose-body", spellcheck: "false" });
  const fileInput = el("input", { type: "file", multiple: "", hidden: "", class: "compose-file" });
  const attachButton = el("button", { type: "button", class: "btn btn-quiet" });
  const attachmentList = el("div", { class: "compose-attachments" });
  const forwardList = el("div", { class: "compose-forward" });
  const sizeLine = el("span", { class: "compose-size" });
  const errorLine = el("p", { class: "compose-error", role: "alert" });
  const discardButton = el("button", { type: "button", class: "btn" });
  const sendButton = el("button", { type: "button", class: "btn btn-primary" });
  const confirmCard = el("div", { class: "compose-confirm is-hidden", role: "alertdialog" });
  const ccRow = el("div", { class: "compose-row compose-row-cc" });
  const bccRow = el("div", { class: "compose-row compose-row-bcc" });
  const toggles = el("div", { class: "compose-toggles" });
  const toggleCc = el("button", { type: "button", class: "chip-toggle" });
  const toggleBcc = el("button", { type: "button", class: "chip-toggle" });

  const card = el(
    "div",
    { class: "compose-card" },
    el("header", { class: "compose-head" }, title, closeButton),
    el(
      "div",
      { class: "compose-fields" },
      el(
        "div",
        { class: "compose-row compose-row-from" },
        el("span", { class: "compose-label compose-label-from" }),
        accountSelect,
      ),
      accountHint,
      el(
        "div",
        { class: "compose-row compose-row-to" },
        el("span", { class: "compose-label compose-label-to" }),
        toField.element,
        toggles,
      ),
      ccRow,
      bccRow,
      el(
        "div",
        { class: "compose-row compose-row-subject" },
        el("span", { class: "compose-label compose-label-subject" }),
        subjectInput,
      ),
    ),
    el("div", { class: "compose-body-wrap" }, bodyInput),
    forwardList,
    attachmentList,
    sizeLine,
    errorLine,
    el(
      "footer",
      { class: "compose-foot" },
      attachButton,
      fileInput,
      el("span", { class: "compose-spacer" }),
      discardButton,
      sendButton,
    ),
    confirmCard,
  );

  container.append(card);
  container.classList.add("is-hidden");

  ccRow.append(el("span", { class: "compose-label compose-label-cc" }), ccField.element);
  bccRow.append(el("span", { class: "compose-label compose-label-bcc" }), bccField.element);
  toggles.append(toggleCc, toggleBcc);

  const hideRow = (row, field) => {
    row.classList.toggle("is-hidden", !field);
  };

  /** Everything the user could lose: any recipient, subject, body or attachment. */
  function isDirty() {
    return Boolean(
      state.subject.trim() ||
        state.text.trim() ||
        state.attachments.length ||
        toField.entries.length ||
        ccField.entries.length ||
        bccField.entries.length,
    );
  }

  function totalSize() {
    const picked = totalBytes(state.attachments);
    const forwarded = (state.forwardOf?.attachments ?? [])
      .filter((file) => state.forwardSelection.has(file.part))
      .reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    return picked + forwarded;
  }

  /**
   * What a forward says about the original's attachments: each ticked part by its
   * section number, with the name the list showed, so the plugin can check that
   * the number still means that file before anything goes on the wire.
   */
  function forwardPayload() {
    const files = (state.forwardOf?.attachments ?? []).filter((file) =>
      state.forwardSelection.has(file.part),
    );
    return {
      accountId: state.forwardOf.accountId,
      key: state.forwardOf.key,
      attachments: files.map((file) => ({ part: file.part, filename: file.filename })),
    };
  }

  function selectedAccount() {
    return state.accounts.find((account) => account.instanceId === state.accountId) ?? null;
  }

  function renderAccount() {
    accountSelect.replaceChildren(
      ...state.accounts.map((account) =>
        el("option", {
          value: account.instanceId,
          text: account.canSend
            ? account.label || account.email
            : `${account.label || account.email} — ${t().compose.accountBlocked}`,
          disabled: account.canSend ? undefined : "",
        }),
      ),
    );
    // A blocked account stays selected even though its option is disabled: the
    // composer is showing why this reply cannot leave, not pretending otherwise.
    accountSelect.value = state.accountId;
    const account = selectedAccount();
    const reason = account?.canSend ? "" : t().compose.blocked[account?.sendBlockedReason ?? "send-disabled"] ?? "";
    accountHint.textContent = reason;
    accountHint.classList.toggle("is-hidden", !reason);
  }

  function renderText() {
    title.textContent = t().compose[state.mode] ?? t().compose.newMessage;
    closeButton.setAttribute("aria-label", t().compose.close);
    closeButton.title = t().compose.close;
    accountSelect.setAttribute("aria-label", t().compose.from);
    toField.input.placeholder = t().compose.to;
    ccField.input.placeholder = t().compose.cc;
    bccField.input.placeholder = t().compose.bcc;
    subjectInput.placeholder = t().compose.subject;
    subjectInput.setAttribute("aria-label", t().compose.subject);
    bodyInput.placeholder = t().compose.bodyPlaceholder;
    bodyInput.setAttribute("aria-label", t().compose.body);
    toggleCc.textContent = t().compose.showCc;
    toggleBcc.textContent = t().compose.showBcc;
    card.querySelector(".compose-label-from").textContent = t().compose.from;
    card.querySelector(".compose-label-to").textContent = t().compose.to;
    card.querySelector(".compose-label-cc").textContent = t().compose.cc;
    card.querySelector(".compose-label-bcc").textContent = t().compose.bcc;
    card.querySelector(".compose-label-subject").textContent = t().compose.subject;
    discardButton.textContent = t().compose.discard;
    sendButton.textContent = state.sending ? t().compose.sending : t().compose.send;
    attachButton.textContent = t().compose.attach;
    attachButton.title = t().compose.attach;
  }

  function renderAttachments() {
    attachmentList.replaceChildren(
      ...state.attachments.map((file, index) =>
        el(
          "span",
          { class: "compose-file-chip", title: `${file.name} · ${formatBytes(file.size)}` },
          el("span", { class: "compose-file-name", text: file.name }),
          el("span", { class: "compose-file-size", text: formatBytes(file.size) }),
          el("button", {
            type: "button",
            class: "chip-remove",
            "aria-label": `${t().compose.removeAttachment}: ${file.name}`,
            text: "×",
            onClick: () => {
              state.attachments.splice(index, 1);
              renderAttachments();
              renderFoot();
            },
          }),
        ),
      ),
    );
    attachmentList.classList.toggle("is-hidden", state.attachments.length === 0);
  }

  /** The original's attachments, offered as a checkbox each, for a forward. */
  function renderForward() {
    const files = state.forwardOf?.attachments ?? [];
    forwardList.classList.toggle("is-hidden", !files.length);
    if (!files.length) {
      forwardList.replaceChildren();
      return;
    }
    forwardList.replaceChildren(
      el("p", { class: "compose-forward-title", text: t().compose.originalAttachments }),
      ...files.map((file) =>
        el(
          "label",
          { class: "compose-forward-item" },
          el("input", {
            type: "checkbox",
            checked: state.forwardSelection.has(file.part) ? "" : undefined,
            onChange: (event) => {
              if (event.target.checked) state.forwardSelection.add(file.part);
              else state.forwardSelection.delete(file.part);
              renderFoot();
            },
          }),
          el("span", { class: "compose-forward-name", text: file.filename }),
          el("span", { class: "compose-forward-size", text: formatBytes(file.size) }),
        ),
      ),
    );
  }

  /** The footer's live parts: the running size, and whether send can be pressed. */
  function renderFoot() {
    const bytes = totalSize();
    const over = bytes > ATTACHMENT_LIMIT;
    sizeLine.textContent = bytes ? `${t().compose.attachmentCount(state.attachments.length + state.forwardSelection.size)} · ${formatBytes(bytes)}` : "";
    sizeLine.classList.toggle("is-over", over);
    const account = selectedAccount();
    sendButton.disabled = state.sending || over || !account?.canSend;
    discardButton.disabled = state.sending;
    attachButton.disabled = state.sending;
    sendButton.textContent = state.sending ? t().compose.sending : t().compose.send;
    errorLine.textContent = state.error ?? (over ? t().compose.tooLarge(LIMIT_LABEL) : "");
    errorLine.classList.toggle("is-hidden", !errorLine.textContent);
  }

  function renderConfirm() {
    confirmCard.classList.toggle("is-hidden", !state.confirming);
    if (!state.confirming) {
      confirmCard.replaceChildren();
      return;
    }
    confirmCard.replaceChildren(
      el("p", { class: "compose-confirm-title", text: t().compose.discardTitle }),
      el("p", { class: "compose-confirm-body", text: t().compose.discardBody }),
      el(
        "div",
        { class: "compose-confirm-actions" },
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: t().compose.discardYes,
          onClick: () => {
            state.confirming = false;
            close();
            onClosed(null);
          },
        }),
        el("button", {
          type: "button",
          class: "btn",
          text: t().compose.discardNo,
          onClick: () => {
            state.confirming = false;
            renderConfirm();
            bodyInput.focus();
          },
        }),
      ),
    );
  }

  function render() {
    renderText();
    renderAccount();
    renderAttachments();
    renderForward();
    renderFoot();
    renderConfirm();
    hideRow(ccRow, state.showCc);
    hideRow(bccRow, state.showBcc);
  }

  /**
   * Open the composer with one draft.
   *
   * @param draft `{ mode, accounts, accountId, to, cc, subject, text, forwardOf,
   *   inReplyTo, references }` — everything the plugin decided, nothing inferred
   *   here.
   */
  function open(draft) {
    const source = draft ?? {};
    state.open = true;
    state.mode = ["reply", "replyAll", "forward"].includes(source.mode) ? source.mode : "new";
    state.accounts = Array.isArray(source.accounts) ? source.accounts : [];
    // A reply goes out from the account that received the message, even when that
    // account cannot send: switching the sender would change who is answering.
    // Only a new message falls back to the first account that can send.
    const wanted = source.accountId
      ? state.accounts.find((account) => account.instanceId === source.accountId)
      : null;
    const fallback = state.accounts.find((account) => account.canSend) ?? state.accounts[0];
    state.accountId = (wanted ?? fallback)?.instanceId ?? "";
    state.subject = String(source.subject ?? "");
    state.text = String(source.text ?? "");
    state.attachments = [];
    state.forwardOf = source.forwardOf ?? null;
    state.forwardSelection = new Set();
    state.inReplyTo = String(source.inReplyTo ?? "");
    state.references = Array.isArray(source.references) ? source.references : [];
    state.sending = false;
    state.error = null;
    state.confirming = false;
    state.showCc = Boolean((source.cc ?? []).length);
    state.showBcc = false;

    toField.set(source.to ?? []);
    ccField.set(source.cc ?? []);
    bccField.clear();
    subjectInput.value = state.subject;
    bodyInput.value = state.text;
    fileInput.value = "";
    container.classList.remove("is-hidden");
    render();
    // A reply starts in the body, above the quote; a new message starts at the
    // first thing it needs, which is a recipient.
    if (state.mode === "reply" || state.mode === "replyAll" || state.mode === "forward") {
      bodyInput.focus();
      bodyInput.setSelectionRange(0, 0);
    } else {
      toField.input.focus();
    }
  }

  function close() {
    state.open = false;
    state.sending = false;
    state.confirming = false;
    state.error = null;
    container.classList.add("is-hidden");
    state.attachments = [];
    state.forwardOf = null;
    state.forwardSelection = new Set();
  }

  /** Ask before losing what was typed; a clean composer closes at once. */
  function requestClose() {
    if (state.sending) return;
    if (!isDirty()) {
      close();
      onClosed(null);
      return;
    }
    state.confirming = true;
    renderConfirm();
  }

  async function pickFiles(files) {
    const picked = [];
    for (const file of files ?? []) {
      try {
        picked.push(await readAttachment(file));
      } catch {
        state.error = t().saveFailed;
      }
    }
    if (!picked.length) {
      renderFoot();
      return;
    }
    state.attachments.push(...picked);
    renderAttachments();
    renderFoot();
  }

  async function submit() {
    if (state.sending) return;
    state.error = null;
    const account = selectedAccount();
    if (!account?.canSend) {
      state.error = t().compose.blocked[account?.sendBlockedReason ?? "send-disabled"] ?? t().sendFailed;
      renderFoot();
      return;
    }
    const to = toField.entries;
    if (!to.length) {
      state.error = t().compose.noRecipient;
      toField.input.focus();
      renderFoot();
      return;
    }
    const invalid = [...to, ...ccField.entries, ...bccField.entries].find((entry) => !isValidAddress(entry.address));
    if (invalid) {
      state.error = t().compose.invalidRecipient(invalid.address);
      renderFoot();
      return;
    }
    if (totalSize() > ATTACHMENT_LIMIT) {
      state.error = t().compose.tooLarge(LIMIT_LABEL);
      renderFoot();
      return;
    }
    state.sending = true;
    render();
    try {
      const result = await onSend({
        accountId: state.accountId,
        mode: state.mode,
        to: to.map((entry) => entry.address),
        cc: ccField.entries.map((entry) => entry.address),
        bcc: bccField.entries.map((entry) => entry.address),
        subject: subjectInput.value,
        text: bodyInput.value,
        attachments: state.attachments.map((file) => ({ name: file.name, type: file.type, data: file.data })),
        inReplyTo: state.inReplyTo,
        references: state.references,
        forwardOf: state.forwardOf ? forwardPayload() : null,
      });
      close();
      onClosed(result ?? {});
    } catch (error) {
      state.sending = false;
      // The code is what the panel can translate; the raw message is English text
      // from the plugin process and never reaches the user.
      state.error = codeText(locale(), error?.code, t().sendFailed);
      // The draft stays exactly as it was: a failed send must not cost the text.
      render();
    }
  }

  closeButton.addEventListener("click", requestClose);
  discardButton.addEventListener("click", requestClose);
  sendButton.addEventListener("click", () => void submit());
  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => void pickFiles(fileInput.files));
  accountSelect.addEventListener("change", () => {
    state.accountId = accountSelect.value;
    renderAccount();
    renderFoot();
  });
  toggleCc.addEventListener("click", () => {
    state.showCc = !state.showCc;
    hideRow(ccRow, state.showCc);
    if (state.showCc) ccField.input.focus();
  });
  toggleBcc.addEventListener("click", () => {
    state.showBcc = !state.showBcc;
    hideRow(bccRow, state.showBcc);
    if (state.showBcc) bccField.input.focus();
  });

  return {
    get isOpen() {
      return state.open;
    },
    open,
    close,
    /** Escape is the composer's own key; the caller stops dispatching its own. */
    handleKey(event) {
      if (!state.open) return false;
      if (event.key !== "Escape") return false;
      event.preventDefault();
      if (state.confirming) {
        state.confirming = false;
        renderConfirm();
        return true;
      }
      requestClose();
      return true;
    },
    /** Re-render after a locale or theme change, without losing what was typed. */
    relabel() {
      if (!state.open) return;
      render();
    },
    /** The code-mapped sentence for a refusal, shown above the footer. */
    showError(text) {
      state.error = text;
      renderFoot();
    },
  };
}