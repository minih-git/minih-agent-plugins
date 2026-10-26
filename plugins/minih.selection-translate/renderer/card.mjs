/**
 * The card: what the translation looks like once it exists.
 *
 * Kept apart from `index.mjs` because the entry owns *behaviour* (the selection
 * observer, the job, the polling) while this file owns *presentation* — one
 * pure function from state to elements, with no hooks and no host calls.
 */
import { createElement as h } from "react";

/** `1240` → `1.2s`; the header shows how long the model took. */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * `job`: `{ phase: "running" | "done" | "error", text?, message?, detail?, modelLabel?, ms? }`
 * `config`: `{ options, configured, resolvedLabel }` or `null`.
 */
export function renderCard({ job, config, source, notice, placement, cardRef, close, copyText, insertText, changeModel, onRetry }) {
  const modelLabel = job.modelLabel || config?.resolvedLabel || "";
  const timing = job.phase === "done" ? durationText(job.ms) : "";
  const summary = [job.phase === "running" ? "翻译中" : "", modelLabel, timing].filter(Boolean).join(" · ");

  const head = h(
    "div",
    { className: "pist-card__head" },
    h("span", { className: "pist-card__mark", "aria-hidden": "true" }, "译"),
    h("span", { className: "pist-card__model", title: modelLabel }, summary),
    h("button", { type: "button", className: "pist-card__close", "aria-label": "关闭", title: "关闭", onClick: close }, "✕"),
  );

  // The original is one click away rather than beside the translation: the
  // reader already has it on screen, behind the card.
  const original = source
    ? h("details", { className: "pist-card__original" }, h("summary", null, "原文"), h("div", null, source))
    : null;

  const body =
    job.phase === "running"
      ? h(
          "div",
          { className: "pist-card__body pist-card__body--message" },
          h("span", { className: "pist-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
          h("span", null, " 翻译中…"),
        )
      : job.phase === "error"
        ? h(
            "div",
            { className: "pist-card__body pist-card__body--message" },
            h("div", { className: "pist-card__error" }, job.message ?? "翻译失败"),
            // The host's own wording, kept as small print: it is what a bug
            // report needs, and it is not the answer the reader asked for.
            job.detail ? h("div", { className: "pist-card__detail" }, job.detail) : null,
            original,
          )
        : h("div", { className: "pist-card__body" }, job.text, original);

  // An empty list means the host could not be asked right now; the current
  // model still ran, so the card keeps working without a dropdown.
  const select =
    config && config.options.length > 0
      ? h(
          "select",
          {
            className: "pist-select",
            value: config.configured ?? "",
            title: "翻译模型",
            "aria-label": "翻译模型",
            onChange: (event) => void changeModel(event.target.value),
          },
          h("option", { value: "" }, config.resolvedLabel ? `默认 · ${config.resolvedLabel}` : "默认模型"),
          config.options.map((option) => h("option", { key: option.key, value: option.key }, option.label)),
        )
      : null;

  const foot = h(
    "div",
    { className: "pist-card__foot" },
    select,
    h("span", { className: "pist-card__spacer" }),
    job.phase === "running" ? h("button", { type: "button", className: "pist-btn", onClick: close }, "取消") : null,
    job.phase === "error" ? h("button", { type: "button", className: "pist-btn", onClick: onRetry }, "重试") : null,
    job.phase === "done"
      ? h("button", { type: "button", className: "pist-btn", onClick: () => void copyText(job.text) }, "复制")
      : null,
    job.phase === "done"
      ? h(
          "button",
          { type: "button", className: "pist-btn pist-btn--primary", onClick: () => void insertText(job.text) },
          "插入输入框",
        )
      : null,
  );

  return h(
    "div",
    {
      ref: cardRef,
      className: "pist-card",
      role: "dialog",
      "aria-label": "翻译结果",
      // Until it has been measured the card exists but is invisible: placement
      // is decided in a layout effect, so the first painted frame is final.
      style: placement ? { top: placement.top, left: placement.left } : { top: 0, left: 0, visibility: "hidden" },
    },
    head,
    body,
    notice ? h("p", { className: "pist-card__note" }, notice) : null,
    foot,
  );
}