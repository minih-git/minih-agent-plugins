/**
 * What the composer control shows, and the poll that keeps it current.
 *
 * No React and no host API in here: the component is only the drawing, so the
 * states that matter — a working switch, an unavailable plugin, and the moment it
 * comes back — can be driven from a plain node test.
 */

/** How often the control re-reads its status; the slot contract has no push channel. */
export const REFRESH_MS = 5000;

/**
 * The one label this file owns.
 *
 * Every other string comes from the plugin process (`status.label`,
 * `status.title`), so the copy lives in one place and follows the app language.
 * This one cannot: it is shown exactly when that process cannot answer.
 */
export const UNAVAILABLE_TEXT = { en: "Unavailable", zh: "不可用" };

export function isChinese(languageTag) {
  return String(languageTag ?? "").toLowerCase().startsWith("zh");
}

/** One line naming what went wrong: its code when there is one, then the message. */
export function errorText(error) {
  if (!error) return "";
  const code = typeof error?.code === "string" ? error.code.trim() : "";
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : String(error);
  return [code, code && message ? `: ${message}` : message].join("");
}

/**
 * The view of one state.
 *
 * `error` wins over `status`: a stale label under a broken plugin would claim
 * something the control cannot know. The button stays disabled while the plugin
 * cannot answer, and the title carries the reason instead of hiding it.
 */
export function controlView({ status, error, language } = {}) {
  const chinese = isChinese(language);
  if (error) {
    return {
      label: chinese ? UNAVAILABLE_TEXT.zh : UNAVAILABLE_TEXT.en,
      title: errorText(error),
      dataOn: false,
      dataStopped: true,
      disabled: true,
    };
  }
  if (!status) {
    return { label: "…", title: "", dataOn: false, dataStopped: false, disabled: true };
  }
  return {
    label: typeof status.label === "string" && status.label.trim() ? status.label : "…",
    title: typeof status.title === "string" ? status.title : "",
    dataOn: status.enabled === true,
    dataStopped: Boolean(status.stopped),
    disabled: false,
  };
}

/**
 * One polling reader per mounted control.
 *
 * A failed read is reported and then retried on the next tick, so a plugin that
 * was restarting (or a process that crashed and came back) recovers by itself;
 * the timers are injected so a test can advance them instead of waiting.
 */
export function createReader({
  call,
  onChange,
  intervalMs = REFRESH_MS,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
}) {
  let stopped = true;
  let handle = null;

  const report = async () => {
    try {
      const status = await call();
      if (!stopped) onChange({ status: status ?? null, error: null });
    } catch (error) {
      if (!stopped) onChange({ status: null, error });
    }
  };

  const tick = async () => {
    handle = null;
    if (stopped) return;
    await report();
    if (stopped) return;
    handle = schedule(() => void tick(), intervalMs);
    // A plugin timer must never hold the app open.
    if (typeof handle?.unref === "function") handle.unref();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (handle !== null) cancel(handle);
      handle = null;
    },
    /** Read once without waiting for the interval, e.g. right after a toggle. */
    async refreshNow() {
      if (stopped) return;
      await report();
    },
  };
}
