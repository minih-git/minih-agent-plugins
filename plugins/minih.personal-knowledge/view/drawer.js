/**
 * Note drawer (design doc §6.5): class/galaxy line, 关联 (constellation and
 * typed neighbors), 相关事件 (tethers), 被引用 (backlinks), collapsed 维护
 * 提示, the redacted `kg.note` preview, and the copy-link button. Memory
 * satellites keep their P4 promotion channel (`kg.promote.preview` →
 * `kg.promote.apply`).
 */

import { invokeBridge, hasBridge, rgbaString } from "./bridge.js";
import { BRIDGE_TIMEOUT_MS } from "./strings.js";
import { classifyIssueCode } from "./strings.js";
import { galaxyDisplayName, linkedNeighbors, nodeDisplayName, tethersOf } from "./model.js";

const FIXTURE_NOTES = new Map();

export function setDrawerFixtures(notesMap) {
  FIXTURE_NOTES.clear();
  if (notesMap instanceof Map) {
    for (const [key, value] of notesMap) FIXTURE_NOTES.set(key, value);
  } else if (notesMap && typeof notesMap === "object") {
    for (const [key, value] of Object.entries(notesMap)) FIXTURE_NOTES.set(key, value);
  }
}

export class NoteDrawer {
  constructor({ t, showToast, fixtureMode }) {
    this.t = t;
    this.showToast = showToast;
    this.fixtureMode = fixtureMode;
    this.root = document.getElementById("note-drawer");
    this.selectedNode = null;
    this.previewDraft = null;
    this.openRequestId = 0;
    this.bind();
  }

  setFixtureMode(fixtureMode) {
    this.fixtureMode = fixtureMode;
  }

  bind() {
    document.getElementById("drawer-close").addEventListener("click", () => this.close());
    document.getElementById("btn-copy-link").addEventListener("click", () => this.copyLink());
    document.getElementById("btn-promote-memory").addEventListener("click", () => this.promote());
    document.getElementById("drawer-hints-head").addEventListener("click", () => {
      const body = document.getElementById("drawer-hints-body");
      const collapsed = body.classList.toggle("is-collapsed");
      document.getElementById("drawer-hints-caret").textContent = collapsed ? "▸" : "▾";
    });
  }

  isOpen() {
    return !this.root.classList.contains("is-hidden");
  }

  chip(nodeRef) {
    const { model } = this;
    const target = typeof nodeRef === "string" ? model.nodesById.get(nodeRef) : nodeRef;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "node-chip";
    const dot = document.createElement("span");
    dot.className = "node-dot";
    dot.style.background = target ? model.galaxyOfNode(target)?.hue ?? "#94a3b8" : "#94a3b8";
    const text = document.createElement("span");
    text.className = "node-chip-text";
    text.textContent = target ? nodeDisplayName(model, target, this.t) : String(nodeRef);
    btn.title = target?.id ?? String(nodeRef);
    btn.append(dot, text);
    btn.addEventListener("click", () => {
      if (target) this.onNavigate?.(target);
    });
    return btn;
  }

  group(titleKey, { count = null } = {}) {
    const section = document.createElement("section");
    section.className = "drawer-section";
    const head = document.createElement("h3");
    head.className = "drawer-sec-title";
    head.textContent = count === null ? this.t(titleKey) : `${this.t(titleKey)} · ${count}`;
    section.appendChild(head);
    const body = document.createElement("div");
    section.appendChild(body);
    return { section, body };
  }

  empty(body, key) {
    const div = document.createElement("div");
    div.className = "empty-note";
    div.textContent = this.t(key);
    body.appendChild(div);
  }

  async open(node, model) {
    this.model = model;
    this.selectedNode = node;
    this.previewDraft = null;
    const requestId = ++this.openRequestId;
    this.root.classList.remove("is-hidden");
    document.getElementById("universe-app").classList.add("drawer-open");

    const t = this.t;
    const galaxy = model.galaxyOfNode(node);
    const clsWord = t("classes")[node.cls] ?? t("classUnknown");
    document.getElementById("drawer-title").textContent = nodeDisplayName(model, node, t);
    document.getElementById("drawer-path").textContent = node.id;
    document.getElementById("drawer-belong").textContent = t("drawerBelongs", {
      class: clsWord,
      galaxy: galaxyDisplayName(model, node.galaxy, t),
    });

    const badge = document.getElementById("drawer-cls-badge");
    badge.textContent = clsWord;
    badge.style.borderColor = rgbaString(galaxy?.hue ?? "#94a3b8", 0.65);
    const staleBadge = document.getElementById("drawer-stale-badge");
    staleBadge.classList.toggle("is-hidden", !node.stale);
    staleBadge.textContent = t("drawerStale");
    document.getElementById("drawer-redacted-badge").classList.add("is-hidden");
    document.getElementById("drawer-truncated-badge").classList.add("is-hidden");

    const copyBtn = document.getElementById("btn-copy-link");
    copyBtn.disabled = node.family === "memory";
    const promoteBtn = document.getElementById("btn-promote-memory");
    promoteBtn.classList.toggle("is-hidden", node.family !== "memory");
    promoteBtn.textContent = t("promoteDraft");

    const errorBox = document.getElementById("drawer-error");
    errorBox.classList.add("is-hidden");

    // 关联 and 相关事件 come from the graph immediately.
    const linked = this.group("drawerLinked", { count: null });
    const neighbors = node.family === "memory" ? [] : linkedNeighbors(model, node.id);
    if (neighbors.length === 0) this.empty(linked.body, "drawerEmptyLinked");
    for (const neighbor of neighbors) {
      linked.body.appendChild(this.chip(neighbor.node));
    }
    const eventsGroup = this.group("drawerEvents", { count: null });
    const tethers = node.kind === "planet" ? tethersOf(model, node.id) : null;
    if (!tethers || tethers.length === 0) this.empty(eventsGroup.body, "drawerEmptyEvents");
    for (const event of tethers ?? []) {
      eventsGroup.body.appendChild(this.chip(event));
    }
    const backlinksGroup = this.group("drawerBacklinks", { count: null });
    const hintsSection = document.getElementById("drawer-hints");
    const hintsBody = document.getElementById("drawer-hints-body");
    hintsBody.innerHTML = "";

    const scroll = document.getElementById("drawer-scroll");
    scroll.querySelectorAll(".drawer-dynamic").forEach((el) => el.remove());
    scroll.insertBefore(linked.section, document.getElementById("drawer-hints"));
    scroll.insertBefore(eventsGroup.section, document.getElementById("drawer-hints"));
    scroll.insertBefore(backlinksGroup.section, document.getElementById("drawer-hints"));

    const content = document.getElementById("drawer-content");
    if (node.family === "memory") {
      this.renderIssues(hintsBody, []);
      hintsSection.classList.add("is-hidden");
      content.textContent = t("memoryPreviewNote");
      return;
    }

    content.textContent = t("drawerLoading");
    let noteData = null;
    if (this.fixtureMode) {
      noteData = FIXTURE_NOTES.get(node.id) ?? null;
    } else {
      try {
        noteData = await invokeBridge("kg.note", { path: node.id }, BRIDGE_TIMEOUT_MS);
      } catch (error) {
        if (this.openRequestId !== requestId) return;
        errorBox.textContent = t("drawerError", { reason: error?.message || String(error) });
        errorBox.classList.remove("is-hidden");
        noteData = FIXTURE_NOTES.get(node.id) ?? null;
      }
    }
    if (this.openRequestId !== requestId || this.selectedNode?.id !== node.id) return;

    const backlinks = noteData?.backlinks ?? [];
    if (backlinks.length === 0) this.empty(backlinksGroup.body, "drawerEmptyBacklinks");
    for (const path of backlinks) backlinksGroup.body.appendChild(this.chip(path));

    const issues = noteData?.issues ?? (node.issues ?? []).map((code) => ({ code, detail: "" }));
    this.renderIssues(hintsBody, issues);
    hintsSection.classList.toggle("is-hidden", issues.length === 0);
    document.getElementById("drawer-hints-count").textContent = String(issues.length);
    hintsBody.classList.add("is-collapsed");
    document.getElementById("drawer-hints-caret").textContent = "▸";

    if (noteData) {
      document.getElementById("drawer-redacted-badge").classList.toggle("is-hidden", !noteData.redacted);
      const truncated = document.getElementById("drawer-truncated-badge");
      truncated.classList.toggle("is-hidden", !noteData.truncated);
      truncated.textContent = t("drawerTruncated");
      content.textContent = noteData.content || "";
    } else {
      content.textContent = "";
    }
  }

  renderIssues(container, issues) {
    container.innerHTML = "";
    for (const issue of issues) {
      const code = typeof issue === "string" ? issue : issue.code;
      const detail = typeof issue === "string" ? "" : issue.detail;
      const severity = classifyIssueCode(code);
      const row = document.createElement("div");
      row.className = `issue-row sev-${severity}`;
      const words = document.createElement("span");
      words.className = "issue-words";
      words.textContent = this.t("issues")[code] ?? code;
      row.appendChild(words);
      // Codes appear only inside the drawer's hints group (§9).
      const codeEl = document.createElement("span");
      codeEl.className = "issue-code";
      codeEl.textContent = code;
      row.appendChild(codeEl);
      if (detail) {
        const detailEl = document.createElement("div");
        detailEl.className = "issue-detail";
        detailEl.textContent = detail;
        row.appendChild(detailEl);
      }
      container.appendChild(row);
    }
  }

  close() {
    this.selectedNode = null;
    this.root.classList.add("is-hidden");
    document.getElementById("universe-app").classList.remove("drawer-open");
  }

  async copyLink() {
    const node = this.selectedNode;
    if (!node) return;
    const t = this.t;
    if (!hasBridge()) {
      const vault = this.vaultName || "Knowledge";
      const link = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(node.id)}`;
      try {
        await navigator.clipboard?.writeText?.(link);
      } catch {
        // Clipboard can be restricted in previews; the toast still shows the link.
      }
      this.showToast(t("toastCopied"));
      return;
    }
    try {
      await invokeBridge("kg.copyLink", { path: node.id }, BRIDGE_TIMEOUT_MS);
      this.showToast(t("toastCopied"));
    } catch (error) {
      this.showToast(t("toastCopyFailed", { reason: error?.message || String(error) }), true);
    }
  }

  /** P4 promotion: preview (dry-run) first, then an explicit confirm. */
  async promote() {
    const node = this.selectedNode;
    if (!node || !hasBridge()) return;
    const t = this.t;
    const promoteBtn = document.getElementById("btn-promote-memory");
    try {
      if (!this.previewDraft) {
        const preview = await invokeBridge("kg.promote.preview", { memoryId: node.id.replace(/^memory:/, "") }, BRIDGE_TIMEOUT_MS);
        this.previewDraft = preview.draft;
        promoteBtn.textContent = t("promoteConfirm");
        this.showToast(t("promotePreviewTitle"));
        return;
      }
      const applied = await invokeBridge("kg.promote.apply", this.previewDraft, BRIDGE_TIMEOUT_MS);
      this.showToast(t("promoteApplied", { path: applied?.summary?.path ?? this.previewDraft.path }));
      this.previewDraft = null;
      promoteBtn.textContent = t("promoteDraft");
    } catch (error) {
      this.showToast(t("promoteFailed", { reason: error?.message || String(error) }), true);
      this.previewDraft = null;
      promoteBtn.textContent = t("promoteDraft");
    }
  }

  applyTranslations() {
    const t = this.t;
    document.getElementById("btn-copy-link").textContent = t("drawerCopyLink");
    document.getElementById("drawer-hints-label").textContent = t("drawerHints");
    document.getElementById("drawer-preview-label").textContent = t("drawerPreview");
    document.getElementById("drawer-close").setAttribute("aria-label", t("drawerClose"));
  }

  onNavigate = null;
}
