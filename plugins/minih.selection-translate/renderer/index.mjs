/**
 * Selection Translate — renderer entry.
 *
 * The host loads this module into the app window and hands it `pi`. What it
 * draws is a pill under the current text selection and, once the pill is
 * pressed, a card with the translation. Both live in a host *layer*
 * (`pi.ui.openLayer`), not in a slot: a slot mounts inside an action bar that
 * fades, clips and stacks, so a floating box drawn there would be cut off. The
 * layer is a zero-size, viewport-fixed element at the end of the body, carrying
 * this plugin's style scope, which is exactly the surface a floating box needs.
 *
 * Read-only towards the app: no host DOM is modified, no transcript is touched,
 * and the only thing sent anywhere is the selected text, to the plugin process
 * (`plugin.call`), which turns it into one `agent.complete` request. The answer
 * comes back through `poll` — a renderer call answers within 2s while a
 * completion may take a minute, so the card polls instead of waiting.
 */
import { createElement as h, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { anchorOfRange, isTranslateShortcut, placeFloating, readSelectionSnapshot, TRANSLATE_SHORTCUT_LABEL } from "./selection.mjs";
import { renderCard } from "./card.mjs";
import { STYLE } from "./styles.mjs";

/** How often the card asks its job for the answer; the relay allows 10 calls/s. */
const POLL_INTERVAL_MS = 450;
/** The host gives one completion 90s; past this the card stops asking. */
const POLL_DEADLINE_MS = 130_000;
/** Consecutive transport failures that mean the channel, not the model, broke. */
const MAX_POLL_FAILURES = 3;
const NOTICE_MS = 1900;

let root = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** A host-renderer call failed; say something a reader can act on. */
function dispatchMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "PLUGIN_UNLOADED") return "插件已卸载或重新加载，请重新选中再译";
  if (code === "PLUGIN_CALL_DISABLED" || code === "PLUGIN_CALL_RATE_LIMITED") {
    return "插件调用太频繁，稍等一下再试";
  }
  if (code === "PLUGIN_CALL_TIMEOUT") return "插件响应超时，请重试";
  return "翻译失败，请重试";
}


function Translator({ pi }) {
  /** The live selection: `{ text, anchor, range, truncated }`. */
  const [target, setTarget] = useState(null);
  /** Where the visible box is anchored (kept after the selection is replaced). */
  const [anchor, setAnchor] = useState(null);
  const [placement, setPlacement] = useState(null);
  /** `{ phase: "running" | "done" | "error", … }`, `null` while no card is open. */
  const [job, setJob] = useState(null);
  const [config, setConfig] = useState(null);
  const [source, setSource] = useState("");
  const [notice, setNotice] = useState("");

  const pillRef = useRef(null);
  const cardRef = useRef(null);
  const rangeRef = useRef(null);
  const jobIdRef = useRef(null);
  const generationRef = useRef(0);
  const pressedRef = useRef(false);
  const openRef = useRef(false);

  openRef.current = job !== null;

  const close = useCallback(() => {
    generationRef.current += 1;
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    if (jobId) void pi.dispatch("plugin.call", { method: "cancel", args: { jobId } }).catch(() => {});
    rangeRef.current = null;
    setJob(null);
    setTarget(null);
    setNotice("");
  }, [pi]);

  const startTranslate = useCallback(
    async (text) => {
      const generation = ++generationRef.current;
      jobIdRef.current = null;
      setSource(text);
      setNotice("");
      setJob({ phase: "running" });
      let started;
      try {
        started = await pi.dispatch("plugin.call", { method: "translate", args: { text } });
      } catch (error) {
        if (generation === generationRef.current) setJob({ phase: "error", message: dispatchMessage(error) });
        return;
      }
      if (generation !== generationRef.current) return;
      if (!started?.ok) {
        setJob({
          phase: "error",
          message: started?.message ?? "翻译没有开始",
          detail: started?.detail ?? "",
        });
        return;
      }
      jobIdRef.current = started.jobId;
      setJob({ phase: "running", modelLabel: started.modelLabel ?? "" });
      if (started.note) setNotice(started.note);
      else if (started.truncated) setNotice("选中的内容较长，只翻译了前面一部分");

      const deadline = Date.now() + POLL_DEADLINE_MS;
      let failures = 0;
      while (generation === generationRef.current) {
        await sleep(POLL_INTERVAL_MS);
        if (generation !== generationRef.current) return;
        if (Date.now() > deadline) {
          jobIdRef.current = null;
          setJob({ phase: "error", message: "等太久了，已放弃这次翻译。换一个更快的模型试试。" });
          void pi.dispatch("plugin.call", { method: "cancel", args: { jobId: started.jobId } }).catch(() => {});
          return;
        }
        let answer;
        try {
          answer = await pi.dispatch("plugin.call", { method: "poll", args: { jobId: started.jobId } });
        } catch (error) {
          if (generation !== generationRef.current) return;
          if (++failures >= MAX_POLL_FAILURES) {
            setJob({ phase: "error", message: dispatchMessage(error) });
            return;
          }
          continue;
        }
        if (generation !== generationRef.current) return;
        if (!answer?.ok) {
          setJob({
            phase: "error",
            message: answer?.message ?? "翻译失败",
            detail: answer?.detail ?? "",
          });
          return;
        }
        if (answer.state === "done") {
          jobIdRef.current = null;
          setJob({
            phase: "done",
            text: answer.text,
            modelLabel: answer.modelLabel ?? "",
            ms: answer.ms,
          });
          return;
        }
        if (answer.state === "cancelled") return;
      }
    },
    [pi],
  );

  /**
   * Start one translation from a selection snapshot — the pill's click and the
   * Option/Alt+E shortcut share this, so both anchor the card the same way.
   */
  const beginTranslation = useCallback(
    (snapshot) => {
      if (!snapshot?.text) return;
      rangeRef.current = snapshot.range ?? rangeRef.current;
      // The thread may have scrolled since the selection was read: anchor the
      // card to where the text is now, not to where it was.
      setAnchor(anchorOfRange(rangeRef.current) ?? snapshot.anchor);
      setTarget(null);
      void startTranslate(snapshot.text);
    },
    [startTranslate],
  );

  const translateSelection = useCallback(() => {
    if (target) beginTranslation(target);
  }, [target, beginTranslation]);

  // The selection observer. It runs for the life of the load and only ever
  // reads: a press anywhere clears the pill (so a drag does not leave a stale
  // one behind), and the pill comes back once the gesture settled.
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (pressedRef.current || openRef.current) return;
      const snapshot = readSelectionSnapshot(window);
      if (!snapshot) {
        setTarget(null);
        return;
      }
      rangeRef.current = snapshot.range;
      setTarget(snapshot);
      setAnchor(snapshot.anchor);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    const cancelFrame = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onKeyDown = (event) => {
      if (!isTranslateShortcut(event)) return;
      // Inside the card the keyboard belongs to its own dropdowns and buttons.
      if (cardRef.current?.contains(event.target)) return;
      // Read the selection at the moment of the press instead of trusting a
      // pill that may have gone stale, and only act when there is prose to
      // translate — otherwise the keystroke stays untouched.
      const snapshot = readSelectionSnapshot(window);
      if (!snapshot) return;
      event.preventDefault();
      cancelFrame();
      beginTranslation(snapshot);
    };
    const onPointerDown = (event) => {
      const node = event.target;
      if (pillRef.current?.contains(node) || cardRef.current?.contains(node)) return;
      pressedRef.current = true;
      cancelFrame();
      setTarget(null);
    };
    const onPointerUp = () => {
      if (!pressedRef.current) return;
      pressedRef.current = false;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("keyup", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelFrame();
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("keyup", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [beginTranslation]);

  // The pill and the card both stay with the text they belong to: the thread
  // scrolls under them, the live selection may already be gone, and the cloned
  // range still knows where its text went.
  const attached = job !== null || target !== null;
  useEffect(() => {
    if (!attached) return;
    const follow = () => {
      const next = anchorOfRange(rangeRef.current);
      if (next) setAnchor(next);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    follow();
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [attached]);

  // A press outside the card closes it — unless the press is part of selecting
  // text inside the card, which is how a reader copies an excerpt of it.
  useEffect(() => {
    if (!job) return;
    const onPointerDown = (event) => {
      const card = cardRef.current;
      if (!card || card.contains(event.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const node = selection.getRangeAt(0).commonAncestorContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (element && card.contains(element)) return;
      }
      close();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [job, close]);

  // The model list and the current choice, once per open card.
  const open = job !== null;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      try {
        const answer = await pi.dispatch("plugin.call", { method: "options", args: {} });
        if (!live) return;
        if (answer?.ok) {
          setConfig({
            options: answer.options ?? [],
            configured: answer.configured ?? "",
            resolvedLabel: answer.resolvedLabel ?? "",
            languages: answer.languages ?? [],
            language: answer.language ?? "",
          });
        } else {
          setConfig({ options: [], configured: "", resolvedLabel: "", languages: [], language: "" });
        }
      } catch {
        if (live) setConfig({ options: [], configured: "", resolvedLabel: "", languages: [], language: "" });
      }
    })();
    return () => {
      live = false;
    };
  }, [open, pi]);

  // Measure after every render and keep the box in the window. Placement is
  // layout, so it happens before paint: the first frame already sits in place.
  useLayoutEffect(() => {
    const element = job ? cardRef.current : pillRef.current;
    if (!element || !anchor) {
      setPlacement(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const next = placeFloating({
      anchor,
      size: { width: rect.width, height: rect.height },
      viewport: viewportSize(),
    });
    setPlacement((previous) =>
      previous && next && Math.abs(previous.top - next.top) < 1 && Math.abs(previous.left - next.left) < 1
        ? previous
        : next,
    );
  });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const changeModel = useCallback(
    async (key) => {
      try {
        const answer = await pi.dispatch("plugin.call", { method: "setModel", args: { model: key } });
        if (!answer?.ok) {
          setNotice(answer?.message ?? "切换模型失败");
          return;
        }
        setConfig((previous) => (previous ? { ...previous, configured: key } : previous));
        // Switching the model re-runs the same text on the new one, which is
        // the only reason to switch mid-card.
        if (source) await startTranslate(source);
      } catch (error) {
        setNotice(dispatchMessage(error));
      }
    },
    [pi, source, startTranslate],
  );

  const changeLanguage = useCallback(
    async (code) => {
      try {
        const answer = await pi.dispatch("plugin.call", { method: "setLanguage", args: { language: code } });
        if (!answer?.ok) {
          setNotice(answer?.message ?? "切换语种失败");
          return;
        }
        setConfig((previous) => (previous ? { ...previous, language: code } : previous));
        // The same passage, in the language just picked: that is the whole
        // point of switching mid-card.
        if (source) await startTranslate(source);
      } catch (error) {
        setNotice(dispatchMessage(error));
      }
    },
    [pi, source, startTranslate],
  );

  const copyText = useCallback(
    async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        setNotice("已复制");
        return;
      } catch {
        // The window's clipboard can be refused; the plugin process can still
        // write it, and that path does not depend on focus.
      }
      try {
        const answer = await pi.dispatch("plugin.call", { method: "copy", args: { text } });
        setNotice(answer?.ok ? "已复制" : (answer?.message ?? "复制失败"));
      } catch {
        setNotice("复制失败");
      }
    },
    [pi],
  );

  const insertText = useCallback(
    async (text) => {
      try {
        await pi.dispatch("composer.insertText", { text });
        setNotice("已插入输入框");
      } catch {
        setNotice("插入失败：输入框当前不可用");
      }
    },
    [pi],
  );

  const pill =
    !job && target
      ? h(
          "button",
          {
            ref: pillRef,
            type: "button",
            className: "pist-pill",
            title: `翻译选中的文字 · ${TRANSLATE_SHORTCUT_LABEL}`,
            "aria-label": "翻译选中的文字",
            style: placement ? { top: placement.top, left: placement.left } : { top: 0, left: 0, visibility: "hidden" },
            // Keeping the selection alive through the press is what lets the
            // text be read from the selection itself.
            onPointerDown: (event) => event.preventDefault(),
            onClick: translateSelection,
          },
          h("span", { className: "pist-pill__mark", "aria-hidden": "true" }, "译"),
          h("span", null, "翻译"),
        )
      : null;

  const card = job
    ? renderCard({
        job,
        config,
        source,
        notice,
        placement,
        cardRef,
        close,
        copyText,
        insertText,
        changeModel,
        changeLanguage,
        onRetry: () => void startTranslate(source),
      })
    : null;

  return h("div", { "data-pi-translate-ui": "1" }, pill, card);
}

export function onLoad(pi) {
  const layer = pi.ui.openLayer();
  pi.ui.injectStyle(STYLE);
  root = createRoot(layer.element);
  root.render(h(Translator, { pi }));
}

export function onUnload() {
  const current = root;
  root = null;
  // The host has already closed the layer and disposed the registrations; this
  // only stops React from keeping the tree alive past them.
  current?.unmount();
}