"use strict";

/**
 * Reader-facing failure text. The host answers `agent.complete` with a coded
 * error (`PERMISSION_DENIED`, `RATE_LIMITED`, …); a reader who selected a
 * paragraph should be told what to do about it, in the language of the card,
 * while the original message stays available as `detail` for a bug report.
 *
 * Pure, so every branch is unit tested without a desktop app.
 */

const HINTS = {
  PERMISSION_DENIED: "插件没有「调用大模型」的权限，请在插件设置里重新授予",
  RATE_LIMITED: "一分钟内的翻译次数太多了，稍等一下再试",
  TIMEOUT: "模型响应超时了，换一个更快的模型试试",
  INVALID_ARGUMENT: "模型不接受这次请求：可能已下线，或返回了空内容",
  ABORTED: "翻译被取消了",
  EMPTY_ANSWER: "模型没有返回内容",
  NO_MODEL: "还没有可用的模型，先在设置里配好一个模型提供商",
  MODELS_UNAVAILABLE: "读不到模型列表，请稍后重试",
  UNKNOWN_MODEL: "这个模型已经不在模型列表里了",
  UNKNOWN_JOB: "这次翻译已经过期，请重新选中再译",
  EMPTY: "选中的内容里没有可翻译的文字",
  UNKNOWN_LANGUAGE: "这个语种不在支持的列表里",
  FAILED: "翻译没有完成，请重试",
};

/**
 * `{ message, detail }` for one failed job. `message` is what the card shows;
 * `detail` is the host's own text, kept out of the visible line so an English
 * runtime message never becomes the answer.
 */
function describeFailure(code, error) {
  const detail =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = HINTS[code] ?? HINTS.FAILED;
  return { message, detail: detail.trim() };
}

module.exports = { HINTS, describeFailure };