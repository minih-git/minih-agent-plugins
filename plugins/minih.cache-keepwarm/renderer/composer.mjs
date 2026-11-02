/**
 * Session cache keep-warm — the composer control.
 *
 * One control on the right side of the composer, for the session the composer
 * belongs to: whether its prompt cache is being kept warm, when the next request
 * is due, what today has cost, and — when the schedule stopped — why.
 *
 * The host draws the composer toolbar and hands this component only its side and
 * the session id, so everything else comes from the plugin process over
 * `plugin.call`. That answer is a finished line of text in the app's language,
 * so this file has no copy of its own and cannot disagree with the schedule.
 *
 * What it must not do is lie: when the plugin process cannot answer (still
 * loading, disabled, crashed, restarting after an update) the control says it is
 * unavailable and puts the reason in its tooltip, instead of showing a switch
 * that claims a state nobody knows. It keeps polling, so it comes back by itself
 * as soon as the process answers again.
 *
 * It runs in the host's own window with the host's React and the host's `--ds-*`
 * tokens. A throw here is contained by the host slot boundary and costs the
 * control, never the composer.
 */
import { createElement as h, useEffect, useRef, useState } from "react";

import { controlView, createReader } from "./control-state.mjs";

/** The running load's `pi`; the host hands a fresh one per load. */
let host = null;

/** The app language, for the one label this side owns. */
const LANGUAGE = typeof navigator === "undefined" ? "en" : navigator.language;

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
  const [view, setView] = useState(() => controlView({ language: LANGUAGE }));
  const reader = useRef(null);

  useEffect(() => {
    if (!sessionId || !host) {
      // No session (the composer on home) or no plugin API: the control cannot
      // speak for anything, so it says so rather than guessing.
      setView(controlView({ language: LANGUAGE }));
      return undefined;
    }
    const next = createReader({
      call: () => host.dispatch("plugin.call", { method: "status", args: { sessionId } }),
      onChange: (change) => setView(controlView({ ...change, language: LANGUAGE })),
    });
    reader.current = next;
    next.start();
    return () => {
      next.stop();
      if (reader.current === next) reader.current = null;
    };
  }, [sessionId]);

  if (!sessionId) return null;

  const toggle = async () => {
    if (!host || view.disabled) return;
    try {
      const status = await host.dispatch("plugin.call", {
        method: "toggle",
        args: { sessionId, enabled: !view.dataOn },
      });
      setView(controlView({ status: status ?? null, language: LANGUAGE }));
    } catch (error) {
      setView(controlView({ error, language: LANGUAGE }));
    }
    // A toggle that failed for a passing reason (the process restarting) gets a
    // fresh read instead of waiting out the interval.
    void reader.current?.refreshNow();
  };

  return h(
    "button",
    {
      type: "button",
      className: "kw-control",
      "data-on": view.dataOn ? "true" : "false",
      "data-stopped": view.dataStopped ? "true" : "false",
      title: view.title,
      disabled: view.disabled,
      onClick: toggle,
    },
    h("span", { className: "kw-dot" }),
    view.label,
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
