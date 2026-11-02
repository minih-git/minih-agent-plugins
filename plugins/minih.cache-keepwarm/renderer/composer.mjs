/**
 * Session cache keep-warm — the composer control.
 *
 * One control on the right side of the composer, for the session the composer
 * belongs to: whether its prompt cache is being kept warm, when the next request
 * is due, what today has cost, and — when the schedule stopped — why.
 *
 * The host draws the composer toolbar and hands this component only its side and
 * the session id, so everything else comes from the plugin process over
 * `plugin.call`. The answer is a finished line of text in the app's language, so
 * this file has no copy of its own and cannot disagree with the schedule.
 *
 * It runs in the host's own window with the host's React and the host's `--ds-*`
 * tokens. A throw here is contained by the host slot boundary and costs the
 * control, never the composer.
 */
import { createElement as h, useCallback, useEffect, useState } from "react";

/** The running load's `pi`; the host hands a fresh one per load. */
let host = null;

/**
 * How often the control re-reads its status.
 *
 * The slot contract has no push channel, so this is a poll: five seconds is
 * invisible to a user watching a "next 15:20" line, and cheap enough that a
 * hundred open windows would still be trivial for the plugin process.
 */
const REFRESH_MS = 5000;

const CSS = `
.kw-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--ds-border-default, rgba(128,128,128,.3));
  border-radius: var(--radius-sm, 7px);
  background: transparent;
  color: var(--ds-text-secondary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.kw-control:hover { background: var(--ds-surface-hover, rgba(128,128,128,.12)); }
.kw-control[data-on="true"] { color: var(--ds-text-primary, inherit); }
.kw-control[data-stopped="true"] { color: var(--ds-text-warning, #d08b2c); }
.kw-control:disabled { cursor: default; opacity: .6; }
.kw-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; opacity: .5;
}
.kw-control[data-on="true"] .kw-dot { opacity: 1; }
`;

function KeepWarmControl({ sessionId }) {
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);

  const read = useCallback(async () => {
    if (!host || !sessionId) return;
    try {
      const next = await host.dispatch("plugin.call", {
        method: "status",
        args: { sessionId },
      });
      setStatus(next ?? null);
      setFailed(false);
    } catch {
      // A plugin process that is not running (disabled, crashed, restarting) is
      // a control that cannot answer; showing a stale switch would be a lie.
      setFailed(true);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setStatus(null);
      return undefined;
    }
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [read, sessionId]);

  if (!sessionId) return null;

  const toggle = async () => {
    if (!host) return;
    try {
      const next = await host.dispatch("plugin.call", {
        method: "toggle",
        args: { sessionId, enabled: !status?.enabled },
      });
      setStatus(next ?? null);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  if (failed) {
    return h(
      "button",
      { type: "button", className: "kw-control", disabled: true },
      h("span", { className: "kw-dot" }),
      "—",
    );
  }

  const label = status?.label ?? "…";
  return h(
    "button",
    {
      type: "button",
      className: "kw-control",
      "data-on": status?.enabled === true ? "true" : "false",
      "data-stopped": status?.stopped ? "true" : "false",
      title: status?.enabled ? "Stop keeping this cache warm" : "Keep this session's prompt cache warm",
      onClick: toggle,
    },
    h("span", { className: "kw-dot" }),
    label,
  );
}

export async function onLoad(pi) {
  host = pi;
  pi.ui.injectStyle(CSS);
  pi.slots.register({
    slot: "composerControl",
    positions: ["right"],
    component: KeepWarmControl,
  });
}

export function onUnload() {
  host = null;
}
