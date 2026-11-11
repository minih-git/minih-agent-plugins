/** Shared readiness wait for one view document; scan time is not RPC time. */
export function createVaultWaiter({ request, onStatus, pollMs = 750 }) {
  const controller = new AbortController();
  let pending = null;

  function pause() {
    return new Promise((resolve, reject) => {
      controller.signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", abort);
        resolve();
      }, pollMs);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function run() {
    let first = true;
    try {
      onStatus({ state: "loading", phase: "discover", completed: 0, total: 0 });
      for (;;) {
        controller.signal.throwIfAborted();
        const status = await request({ retry: first, refresh: first }, controller.signal);
        controller.signal.throwIfAborted();
        first = false;
        if (!["loading", "ready", "error"].includes(status?.state)) {
          throw Object.assign(new Error("Invalid vault readiness response"), { code: "VAULT_STATUS_INVALID" });
        }
        onStatus(status);
        if (status.state === "ready") return;
        if (status.state === "error") {
          throw Object.assign(new Error(status.error?.message || "Vault loading failed"), { code: status.error?.code || "VAULT_LOAD_FAILED" });
        }
        await pause();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        onStatus({ state: "error", error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }

  return {
    wait() {
      controller.signal.throwIfAborted();
      if (!pending) {
        const task = run().finally(() => { if (pending === task) pending = null; });
        pending = task;
      }
      return pending;
    },
    get signal() { return controller.signal; },
    dispose() { controller.abort(); },
  };
}
