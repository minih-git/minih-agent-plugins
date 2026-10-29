/**
 * The card's stylesheet, injected with `pi.ui.injectStyle`.
 *
 * The host scopes every rule in here to this plugin's own mounts
 * (`@scope ([data-pi-plugin="…"])`), and the layer it hands out carries that
 * attribute, so nothing below can reach the app's own interface. Colours come
 * from the host's `--ds-*` tokens, so the card follows the active theme instead
 * of hard-coding one. Class names are prefixed `pist-` and the keyframes are
 * prefixed too: named at-rules stay global, where a collision would be real.
 */

export const STYLE = `
.pist-pill {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--ds-border-default);
  border-radius: 999px;
  background: var(--ds-bg-elevated-opaque, var(--ds-bg-elevated));
  box-shadow: var(--ds-raised-shadow, 0 4px 14px rgba(0, 0, 0, 0.18));
  color: var(--ds-text-primary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.pist-pill:hover { background: var(--ds-bg-hover); }
.pist-pill:focus-visible { outline: 2px solid var(--ds-focus); outline-offset: 1px; }
.pist-pill__mark {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  /* Solid accent with the page ink on top. Accent text on a soft accent fill sat
     at 2.2–2.6:1 in both themes, so the character all but vanished. */
  background: var(--ds-accent);
  color: var(--ds-bg-primary);
  font-size: 10px;
  font-weight: 600;
}

.pist-card {
  position: fixed;
  display: flex;
  flex-direction: column;
  width: min(430px, calc(100vw - 24px));
  border: 1px solid var(--ds-border-default);
  border-radius: var(--ds-composer-radius, 12px);
  background: var(--ds-bg-elevated-opaque, var(--ds-bg-elevated));
  box-shadow: var(--ds-shadow-dialog, 0 12px 32px rgba(0, 0, 0, 0.24));
  color: var(--ds-text-primary);
  font-size: 13px;
  line-height: 1.6;
  overflow: hidden;
}
.pist-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--ds-border-subtle, var(--ds-border-default));
}
.pist-card__mark {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  /* Same chip as the pill: solid accent, page ink on top. */
  background: var(--ds-accent);
  color: var(--ds-bg-primary);
  font-size: 11px;
  font-weight: 600;
  flex: none;
}
.pist-card__model {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ds-text-muted);
  font-size: 11.5px;
}
.pist-card__close {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ds-text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.pist-card__close:hover { background: var(--ds-bg-hover); color: var(--ds-text-primary); }

.pist-card__body {
  max-height: min(52vh, 430px);
  overflow: auto;
  padding: 10px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.pist-card__body--message { white-space: normal; }
.pist-card__error { color: var(--ds-error); }
.pist-card__detail {
  margin-top: 6px;
  color: var(--ds-text-faint);
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pist-card__note {
  margin: 0;
  padding: 0 12px 8px;
  color: var(--ds-text-muted);
  font-size: 11.5px;
}
.pist-card__original {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px dashed var(--ds-border-subtle, var(--ds-border-default));
  color: var(--ds-text-muted);
  font-size: 12px;
}
.pist-card__original summary { cursor: pointer; user-select: none; }
.pist-card__original div { margin-top: 6px; white-space: pre-wrap; user-select: text; }

.pist-card__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 7px 10px;
  border-top: 1px solid var(--ds-border-subtle, var(--ds-border-default));
  background: var(--ds-bg-secondary);
}
.pist-card__spacer { flex: 1; }
.pist-btn {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--ds-border-default);
  border-radius: 7px;
  background: transparent;
  color: var(--ds-text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.pist-btn:hover { background: var(--ds-bg-hover); color: var(--ds-text-primary); }
.pist-btn--primary {
  border-color: transparent;
  background: var(--ds-accent);
  color: var(--ds-bg-primary);
}
.pist-btn--primary:hover { background: var(--ds-accent-hover); color: var(--ds-bg-primary); }
.pist-select {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 132px;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--ds-border-default);
  border-radius: 7px;
  background: var(--ds-bg-tertiary);
  color: var(--ds-text-secondary);
  font: inherit;
  font-size: 11.5px;
}

.pist-dots { display: inline-flex; gap: 3px; align-items: center; }
.pist-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ds-text-muted);
  animation: pist-pulse 1.05s ease-in-out infinite;
}
.pist-dots i:nth-child(2) { animation-delay: 0.14s; }
.pist-dots i:nth-child(3) { animation-delay: 0.28s; }
@keyframes pist-pulse {
  0%, 100% { opacity: 0.28; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-1px); }
}
@media (prefers-reduced-motion: reduce) {
  .pist-dots i { animation: none; opacity: 0.65; }
}
`;