/**
 * Router panel page.
 *
 * The page holds no credential and makes no request of its own: it asks the
 * plugin process for a status snapshot and renders whatever came back. Every
 * visible string lives here because the host draws no part of this page.
 */

const bridge = window.pluginBridge;
const chinese = /^zh/i.test(navigator.language || "");
const text = (en, zh) => (chinese ? zh : en);

const el = {
  panel: document.getElementById("panel"),
  statusText: document.getElementById("status-text"),
  identity: document.getElementById("identity"),
  roleBadge: document.getElementById("role-badge"),
  keyName: document.getElementById("key-name"),
  keyHint: document.getElementById("key-hint"),
  facts: document.getElementById("facts"),
  factHostLabel: document.getElementById("fact-host-label"),
  factHost: document.getElementById("fact-host"),
  factStatusLabel: document.getElementById("fact-status-label"),
  factStatus: document.getElementById("fact-status"),
  factRpmRow: document.getElementById("fact-rpm-row"),
  factRpmLabel: document.getElementById("fact-rpm-label"),
  factRpm: document.getElementById("fact-rpm"),
  factExpiryRow: document.getElementById("fact-expiry-row"),
  factExpiryLabel: document.getElementById("fact-expiry-label"),
  factExpiry: document.getElementById("fact-expiry"),
  hint: document.getElementById("hint"),
  open: document.getElementById("open"),
  refresh: document.getElementById("refresh"),
};

/** Copy for the codes the plugin process reports; unknown codes stay visible as-is. */
const MESSAGES = {
  empty: text("No control-plane address yet.", "还没有填写控制面地址。"),
  "no-credential": text("No credential yet.", "还没有填写凭据。"),
  "invalid-url": text(
    "That address is not an http(s) URL.",
    "这个地址不是有效的 http(s) 地址。",
  ),
  unauthorized: text(
    "The Router rejected this credential (401/403).",
    "网关拒绝了这枚凭据（401/403）。",
  ),
  "bad-response": text(
    "That address answered, but not as a Router control plane.",
    "这个地址有响应，但 /api/auth/session 不是 Router 的应答。",
  ),
  "not-authenticated": text(
    "The Router did not confirm this credential.",
    "网关没有确认这枚凭据。",
  ),
  "SETTINGS_UNAVAILABLE": text(
    "The plugin settings could not be read.",
    "读不到插件设置。",
  ),
  "no-bridge": text(
    "This page lost its connection to the plugin.",
    "这个页面与插件进程断开了。",
  ),
};

let busy = false;

function invoke(channel, payload) {
  if (!bridge || typeof bridge.invoke !== "function") {
    return Promise.reject(Object.assign(new Error(MESSAGES["no-bridge"]), { code: "no-bridge" }));
  }
  return bridge.invoke(channel, payload);
}

function setState(state) {
  el.panel.dataset.state = state;
  el.panel.setAttribute("aria-busy", state === "loading" ? "true" : "false");
}

function setHint(message, tone) {
  el.hint.textContent = message ?? "";
  if (tone) el.hint.dataset.tone = tone;
  else delete el.hint.dataset.tone;
}

function setRefreshLabel() {
  el.refresh.textContent = text("Refresh", "刷新");
}

function describe(status) {
  const code = status?.code ?? "";
  if (code === "http-error") {
    return text(
      `The Router answered HTTP ${status.status}.`,
      `网关返回 HTTP ${status.status}。`,
    );
  }
  if (code === "network") {
    const detail = String(status.detail ?? "").trim();
    return detail
      ? text(`Could not reach the Router: ${detail}`, `连不上网关：${detail}`)
      : text("Could not reach the Router.", "连不上网关。");
  }
  if (code === "invalid-url" && status.detail) {
    return text(
      `That address is not an http(s) URL (${status.detail}).`,
      `这个地址不是有效的 http(s) 地址（${status.detail}）。`,
    );
  }
  if (MESSAGES[code]) return MESSAGES[code];
  // A bridge failure may arrive as a plain message with no code. Show what the
  // plugin said rather than inventing a state the user cannot act on.
  const detail = String(status?.detail ?? "").trim();
  return detail || code || text("Unknown state.", "未知状态。");
}

function renderLoading() {
  setState("loading");
  el.statusText.textContent = text("Asking the Router…", "正在询问网关…");
  hideIdentity();
  setHint("");
}

function hideIdentity() {
  el.identity.hidden = true;
  el.facts.hidden = true;
  el.open.hidden = true;
}

function renderUnconfigured(status) {
  setState("unconfigured");
  el.statusText.textContent = text("Not configured", "尚未配置");
  hideIdentity();
  setHint(
    text(
      "Open Settings → Plugins → Router Console and fill in the control-plane address and your AccessKey.",
      "打开 设置 → 插件 → Router 控制台，填写控制面地址和 AccessKey。",
    ),
  );
}

function renderError(status) {
  setState("error");
  el.statusText.textContent = status.baseUrl
    ? status.baseUrl
    : text("Not connected", "未连接");
  hideIdentity();
  setHint(describe(status), "error");
}

function renderReady(status) {
  const identity = status.identity;
  setState("ready");
  el.panel.dataset.role = identity.admin ? "admin" : "access-key";
  el.statusText.textContent = text("Connected", "已连接");

  el.identity.hidden = false;
  el.roleBadge.textContent = identity.admin
    ? text("Administrator", "管理员")
    : text("Access key", "访问密钥");
  el.keyName.textContent =
    identity.keyName || text("Unnamed key", "未命名密钥");
  el.keyHint.textContent = identity.keyHint;
  el.keyHint.hidden = !identity.keyHint;

  el.facts.hidden = false;
  el.factHostLabel.textContent = text("Gateway", "网关");
  el.factHost.textContent = status.baseUrl;
  el.factStatusLabel.textContent = text("Key status", "密钥状态");
  el.factStatus.textContent = identity.status || "—";

  el.factRpmLabel.textContent = text("Rate limit", "限速");
  if (identity.rpmLimit) {
    el.factRpmRow.hidden = false;
    el.factRpm.textContent = text(
      `${identity.rpmLimit} requests/min`,
      `${identity.rpmLimit} 次/分钟`,
    );
  } else {
    el.factRpmRow.hidden = true;
  }

  el.factExpiryLabel.textContent = text("Expires", "过期时间");
  if (identity.expiresAtMs) {
    const expired = identity.expiresAtMs <= Date.now();
    el.factExpiryRow.hidden = false;
    el.factExpiry.dataset.expired = expired ? "true" : "false";
    const stamp = new Intl.DateTimeFormat(chinese ? "zh-CN" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(identity.expiresAtMs));
    el.factExpiry.textContent = expired ? text(`${stamp} (expired)`, `${stamp}（已过期）`) : stamp;
  } else {
    el.factExpiryRow.hidden = true;
  }

  el.open.hidden = false;
  el.open.textContent = identity.admin
    ? text("Open admin console", "打开管理后台")
    : text("Open key usage", "打开 key 用量页");
  setHint(
    identity.admin
      ? text(
          "The console opens in your browser, where the Router asks you to sign in as usual.",
          "后台会在你的浏览器里打开，登录仍由 Router 页面自己完成。",
        )
      : text(
          "The key usage page opens in your browser; sign in there with the same AccessKey.",
          "key 用量页会在你的浏览器里打开，用同一枚 AccessKey 登录即可。",
        ),
  );
}

function render(status) {
  if (!status || typeof status !== "object") {
    setState("error");
    hideIdentity();
    setHint(text("The plugin returned nothing.", "插件没有返回结果。"), "error");
    return;
  }
  if (status.ok) renderReady(status);
  else if (!status.configured) renderUnconfigured(status);
  else renderError(status);
}

async function load(options = {}) {
  if (busy) return;
  busy = true;
  el.refresh.disabled = true;
  el.open.disabled = true;
  renderLoading();
  let status;
  try {
    status = await invoke("router.status", { force: options.force === true });
  } catch (error) {
    status = { ok: false, configured: true, code: error?.code ?? "", detail: String(error?.message ?? "") };
  } finally {
    busy = false;
    el.refresh.disabled = false;
    el.open.disabled = false;
  }
  render(status);
  if (options.autoOpen && status?.ok && status.openOnView) {
    void openConsole({ quiet: true });
  }
}

async function openConsole(options = {}) {
  if (busy) return;
  busy = true;
  el.open.disabled = true;
  try {
    await invoke("router.open");
    if (!options.quiet) setHint(text("Opened in your browser.", "已在浏览器中打开。"));
  } catch (error) {
    const code = error?.code ?? "";
    setHint(
      code === "NOT_READY"
        ? text(
            "The Router did not confirm this credential, so no page was opened.",
            "网关没有确认这枚凭据，因此没有打开页面。",
          )
        : text(
            `Could not open the page: ${String(error?.message ?? error)}`,
            `打不开页面：${String(error?.message ?? error)}`,
          ),
      "error",
    );
  } finally {
    busy = false;
    el.open.disabled = false;
  }
}

el.refresh.addEventListener("click", () => {
  void load({ force: true });
});
el.open.addEventListener("click", () => {
  void openConsole();
});

setRefreshLabel();
void load({ autoOpen: true });
