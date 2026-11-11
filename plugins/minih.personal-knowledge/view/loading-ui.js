/** One visible readiness state, shared by the universe and settings page. */
export function bindVaultLoading(t, retry) {
  const box = document.getElementById("vault-loading");
  const text = document.getElementById("vault-loading-text");
  const hint = document.getElementById("vault-loading-hint");
  const progress = document.getElementById("vault-loading-progress");
  const button = document.getElementById("vault-loading-retry");
  let current = { state: "ready" };
  function update(status = current) {
    current = status;
    box.classList.toggle("is-hidden", status.state === "ready");
    box.classList.toggle("is-error", status.state === "error");
    box.setAttribute("aria-busy", String(status.state === "loading"));
    button.textContent = t("retryBtn");
    button.classList.toggle("is-hidden", status.state === "loading");
    progress.classList.toggle("is-hidden", status.state !== "loading");
    if (status.total > 0) { progress.max = status.total; progress.value = status.completed; }
    else progress.removeAttribute("value");
    text.textContent = status.state === "error" ? t("vaultLoadFailed")
      : status.state === "empty" ? t("vaultEmpty")
      : status.phase === "services" ? t("vaultPreparing")
      : status.total > 0 ? t("vaultLoadProgress", { completed: status.completed, total: status.total })
      : t("vaultLoading");
    progress.setAttribute("aria-label", text.textContent);
    hint.textContent = status.state === "error" ? status.error?.message || t("bridgeTimeoutError")
      : status.state === "empty" ? t("vaultEmptyHint") : t("vaultLoadingHint");
  }
  const listener = (event) => update(event.detail);
  window.addEventListener("kg:loading", listener);
  button.addEventListener("click", retry);
  window.addEventListener("pagehide", () => window.removeEventListener("kg:loading", listener), { once: true });
  return { update };
}
