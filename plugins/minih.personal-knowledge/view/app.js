/**
 * Knowledge Universe view bootstrap (design doc §6–§9).
 *
 * One laid-out payload feeds both renderers. Default view is 3D; the flat
 * star chart is the reading mode behind the 星图 button and the fallback
 * when WebGL is unavailable. Default chrome is the four corners: title/count
 * or breadcrumb (top left), search (top center), 3D/星图 + Layers (≡) +
 * Settings (⚙) (top right), zoom + and − (bottom right).
 */

import { applyUniverseLayout } from "./vendor/layout.mjs";
import {
  STRINGS,
  BRIDGE_TIMEOUT_MS,
  classifyIssueCode,
  nodeSeverity,
} from "./strings.js";
import { invokeBridge, hasBridge } from "./bridge.js";
import { FIXTURE_GRAPH, FIXTURE_NOTES } from "./fixture.js";
import { buildModel, computeVisibility, galaxyDisplayName, nodeDisplayName } from "./model.js";
import { ChartView } from "./chart.js";
import { ThreeView } from "./three-view.js";
import { RetrievalSettingsPanel } from "./settings.js";
import { NoteDrawer, setDrawerFixtures } from "./drawer.js";
import {
  initialViewMode,
  canSwitchTo,
  MODE_3D,
  MODE_CHART,
  VIEW_MODE_STORAGE_KEY,
} from "./view-mode.js";

const LANGUAGE_STORAGE_KEY = "kg-universe:lang";

const state = {
  lang: null,
  payload: null,
  model: null,
  fixtureMode: false,
  vaultName: "Knowledge",
  mode: MODE_3D,
  webglAvailable: true,
  layers: {
    eventRings: true,
    constellation: true,
    lanes: true,
    nav: false,
    ghosts: false,
    archived: false,
    memory: false,
  },
  filters: { class: "all", stability: "all" },
  healthMode: false,
  timelapse: { on: false, ratio: 1, playing: false, cutoff: null, timer: null },
  focusGalaxyId: null,
  selectedId: null,
  reducedMotion: false,
  visibility: { visibleNodes: new Set(), visibleLinks: [] },
};

const $ = (id) => document.getElementById(id);

function detectWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function storedMode() {
  try {
    return localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable; the choice then stays per-session.
  }
}

function t(key, vars = {}) {
  const dict = STRINGS[state.lang] ?? STRINGS.en;
  let str = dict[key] ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, String(v));
  return str;
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.remove("is-hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("is-hidden"), 2600);
}

// ---- payload loading ----

async function loadGraph() {
  const banner = $("bridge-error-banner");
  let payload = null;
  state.fixtureMode = false;
  if (!hasBridge()) {
    state.fixtureMode = true;
    payload = structuredClone(FIXTURE_GRAPH);
    applyUniverseLayout(payload);
    banner.classList.add("is-hidden");
  } else {
    try {
      payload = await invokeBridge("kg.graph", { includeMemory: true }, BRIDGE_TIMEOUT_MS);
      if (!payload || !Array.isArray(payload.nodes)) throw new Error("invalid graph payload");
      if (!payload.layoutApplied) {
        applyUniverseLayout(payload);
      }
      banner.classList.add("is-hidden");
    } catch (error) {
      state.fixtureMode = true;
      payload = structuredClone(FIXTURE_GRAPH);
      applyUniverseLayout(payload);
      $("bridge-error-text").textContent =
        error?.code === "BRIDGE_TIMEOUT" ? t("bridgeTimeoutError") : t("bridgeCallError", { reason: error?.message || String(error) });
      banner.classList.remove("is-hidden");
    }
  }
  state.payload = payload;
  state.vaultName = payload.vaultName || state.vaultName;
  state.model = buildModel(payload);
  setDrawerFixtures(FIXTURE_NOTES);
  view.drawer?.setFixtureMode(state.fixtureMode);
  $("fixture-badge").classList.toggle("is-hidden", !state.fixtureMode);
  $("vault-badge").textContent = state.vaultName;
  // The memory toggle exists only when memory data arrived (§8).
  const memoryOk = payload.memory?.status === "ok";
  $("memory-toggle-row").classList.toggle("is-hidden", !memoryOk);
  if (!memoryOk) state.layers.memory = false;
  refreshVisibility();
  applyTranslations();
}

// ---- visibility & rendering ----

function refreshVisibility() {
  if (!state.model) return;
  state.visibility = computeVisibility(state.model, {
    layers: state.layers,
    filters: state.filters,
    timelapseCutoff: state.timelapse.on ? state.timelapse.cutoff : null,
  });
  render();
}

function render() {
  const shared = {
    visibility: state.visibility,
    layers: state.layers,
    focusGalaxyId: state.focusGalaxyId,
    selectedId: state.selectedId,
    healthMode: state.healthMode,
    reducedMotion: state.reducedMotion,
  };
  if (state.mode === MODE_3D && view.three) {
    view.three.reduced = state.reducedMotion;
    view.three.render(shared);
  } else if (view.chart) {
    view.chart.setState(shared);
  }
  updateHeader();
  if (state.healthMode) renderHealthPanel();
}

function updateHeader() {
  const titleEl = $("hud-title");
  const countEl = $("hud-counts");
  if (state.focusGalaxyId) {
    const galaxy = state.model?.galaxiesById.get(state.focusGalaxyId);
    titleEl.innerHTML = "";
    const crumb = document.createElement("button");
    crumb.className = "crumb-root";
    crumb.textContent = t("universeCrumb");
    crumb.addEventListener("click", () => exitGalaxy());
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    const name = document.createElement("span");
    name.className = "crumb-galaxy";
    name.textContent = galaxyDisplayName(state.model, state.focusGalaxyId, t);
    titleEl.append(crumb, sep, name);
    countEl.classList.add("is-hidden");
  } else {
    titleEl.textContent = t("title");
    countEl.classList.remove("is-hidden");
    countEl.textContent = state.payload ? `${state.payload.nodes.length} ${t("noteCountSuffix")}` : "";
  }
}

function ensureThreeView() {
  if (view.three || !state.webglAvailable) return view.three ?? null;
  try {
    const three = new ThreeView($("stage-3d"));
    three.onHover = (node, x, y) => showHoverCard(node, x, y);
    three.onSelect = (node) => selectNode(node);
    three.onGalaxyClick = (galaxyId) => enterGalaxy(galaxyId);
    three.setModel(state.model, t);
    view.three = three;
    return three;
  } catch (error) {
    // WebGL context creation can still fail here (§7): chart mode + notice.
    state.webglAvailable = false;
    $("webgl-notice").textContent = t("webglFallback");
    $("webgl-notice").classList.remove("is-hidden");
    setMode(MODE_CHART, { fromFallback: true });
    return null;
  }
}

function setMode(mode, { fromFallback = false } = {}) {
  if (!canSwitchTo(mode, { webglAvailable: state.webglAvailable })) return;
  state.mode = mode;
  if (!fromFallback) rememberMode(mode);
  $("stage-3d").classList.toggle("is-hidden", mode !== MODE_3D);
  $("stage-chart").classList.toggle("is-hidden", mode !== MODE_CHART);
  $("btn-mode-toggle").textContent = mode === MODE_3D ? t("modeChart") : t("mode3d");
  if (mode === MODE_3D) {
    const three = ensureThreeView();
    if (three) {
      three.setModel(state.model, t);
      if (view.chart) view.chart.hoveredId = null;
    }
  } else {
    view.three?.handleHover(null);
    // The stage just became visible; re-measure the canvas.
    view.chart?.resize();
  }
  render();
}

// ---- navigation ----

function enterGalaxy(galaxyId) {
  if (!galaxyId) return;
  state.focusGalaxyId = galaxyId;
  render();
}

function exitGalaxy() {
  state.focusGalaxyId = null;
  render();
}

function selectNode(node) {
  state.selectedId = node.id;
  if (node.kind === "moon" && state.focusGalaxyId !== node.galaxy) {
    state.focusGalaxyId = node.galaxy;
  }
  view.drawer.open(node, state.model);
  render();
}

// ---- hover card ----

function showHoverCard(node, clientX, clientY) {
  const card = $("hover-card");
  if (!node) {
    card.classList.add("is-hidden");
    return;
  }
  const tLocal = t;
  $("hover-title").textContent = nodeDisplayNameSafe(node);
  $("hover-meta-line").textContent = tLocal("drawerBelongs", {
    class: tLocal("classes")[node.cls] ?? tLocal("classUnknown"),
    galaxy: galaxyDisplayName(state.model, node.galaxy, tLocal),
  });
  $("hover-updated").textContent = node.updated ? tLocal("hoverUpdated", { date: node.updated }) : "";
  card.classList.remove("is-hidden");
  const pad = 14;
  const x = Math.min(clientX + pad, window.innerWidth - card.offsetWidth - pad);
  const y = Math.min(clientY + pad, window.innerHeight - card.offsetHeight - pad);
  card.style.left = `${Math.max(pad, x)}px`;
  card.style.top = `${Math.max(pad, y)}px`;
}

function nodeDisplayNameSafe(node) {
  return nodeDisplayName(state.model, node, t);
}

// ---- search ----

function scoreFuzzyMatch(query, candidate) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const direct = c.indexOf(q);
  if (direct >= 0) return 1000 - Math.min(direct, 100) - Math.max(0, c.length - q.length) * 0.1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      streak += 1;
      score += 10 + streak;
      qi += 1;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : 0;
}

function runSearch(rawQuery) {
  const query = String(rawQuery ?? "").trim();
  const list = $("search-results");
  if (!state.model || !query) {
    list.classList.add("is-hidden");
    list.innerHTML = "";
    return;
  }
  const matches = [];
  for (const node of state.model.nodes) {
    if (node.kind === "satellite") continue;
    const score = Math.max(
      scoreFuzzyMatch(query, node.title ?? ""),
      scoreFuzzyMatch(query, node.id) * 0.5,
    );
    if (score > 0) matches.push({ node, score });
  }
  matches.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : 1));
  state.searchMatches = matches.slice(0, 8).map((m) => m.node);
  list.innerHTML = "";
  if (state.searchMatches.length === 0) {
    const li = document.createElement("li");
    li.className = "search-empty";
    li.textContent = t("searchNoMatch");
    list.appendChild(li);
  }
  state.searchMatches.forEach((node, index) => {
    const li = document.createElement("li");
    li.className = `search-item${index === 0 ? " is-active" : ""}`;
    li.setAttribute("role", "option");
    const name = document.createElement("span");
    name.textContent = node.title || node.id;
    const path = document.createElement("span");
    path.className = "search-item-path";
    path.textContent = node.galaxy === "shared" ? t("sharedGalaxy") : state.model.galaxiesById.get(node.galaxy)?.name || "";
    li.append(name, path);
    li.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseSearchMatch(node);
    });
    list.appendChild(li);
  });
  list.classList.remove("is-hidden");
  $("search-input").setAttribute("aria-expanded", "true");
}

function chooseSearchMatch(node) {
  $("search-results").classList.add("is-hidden");
  $("search-input").value = "";
  if (node.kind === "moon" || node.kind === "planet" || node.kind === "star" || node.kind === "nav") {
    if (node.galaxy) enterGalaxy(node.galaxy);
  }
  selectNode(node);
  view.chart?.playSearchPulse(node.id, state.reducedMotion);
  view.three?.playSearchPulse(node.id, state.reducedMotion);
}

// ---- health mode ----

function setHealthMode(on) {
  state.healthMode = Boolean(on);
  $("health-region").classList.toggle("is-hidden", !state.healthMode);
  $("menu-health").setAttribute("aria-checked", String(state.healthMode));
  render();
}

function renderHealthPanel() {
  if (!state.model) return;
  const severity = $("health-severity-filter").value;
  const list = $("health-list");
  list.innerHTML = "";
  if (state.layers.ghosts) {
    const ghosts = state.payload?.ghosts ?? [];
    if (ghosts.length > 0) {
      const head = document.createElement("div");
      head.className = "health-row sev-muted";
      head.textContent = `${t("layerGhosts")} · ${ghosts.length}`;
      list.appendChild(head);
      for (const ghost of ghosts) {
        const row = document.createElement("div");
        row.className = "health-row sev-red";
        const title = document.createElement("div");
        title.className = "health-row-title";
        title.textContent = `${ghost.id} ← ${ghost.referencedBy.length}`;
        title.title = ghost.referencedBy.join("\n");
        row.appendChild(title);
        list.appendChild(row);
      }
      const divider = document.createElement("div");
      divider.className = "menu-divider";
      list.appendChild(divider);
    }
  }
  const rows = [];
  for (const node of state.model.nodes) {
    if (node.kind === "satellite" || !state.visibility.visibleNodes.has(node.id)) continue;
    const worst = nodeSeverity(node.issues);
    if (!node.issues?.length || worst === "ok") continue;
    if (severity !== "all" && worst !== severity) continue;
    rows.push(node);
  }
  rows.sort((a, b) => {
    const rank = { red: 0, amber: 1, muted: 2 };
    return (rank[nodeSeverity(a.issues)] ?? 3) - (rank[nodeSeverity(b.issues)] ?? 3) || (a.id < b.id ? -1 : 1);
  });
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("healthEmpty");
    list.appendChild(empty);
    return;
  }
  for (const node of rows) {
    const row = document.createElement("div");
    row.className = `health-row sev-${nodeSeverity(node.issues)}`;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "health-row-title";
    head.textContent = node.title || node.id;
    head.addEventListener("click", () => {
      enterGalaxy(node.galaxy);
      selectNode(node);
    });
    row.appendChild(head);
    const chips = document.createElement("div");
    chips.className = "health-row-issues";
    for (const code of node.issues) {
      const chip = document.createElement("span");
      chip.className = `issue-chip sev-${classifyIssueCode(code)}`;
      // §9: words in both languages, the code next to them only here.
      chip.textContent = `${t("issues")[code] ?? code} · ${code}`;
      chips.appendChild(chip);
    }
    row.appendChild(chips);
    list.appendChild(row);
  }
}

// ---- time-lapse ----

function setTimelapse(on) {
  state.timelapse.on = Boolean(on);
  $("timelapse-bar").classList.toggle("is-hidden", !state.timelapse.on);
  $("menu-timelapse").setAttribute("aria-checked", String(state.timelapse.on));
  if (state.timelapse.on) {
    const dates = state.model?.nodes.map((node) => node.created).filter(Boolean).sort() ?? [];
    state.timelapse.min = dates[0] ?? "";
    state.timelapse.max = dates[dates.length - 1] ?? "";
    if (state.timelapse.ratio < 1) {
      updateTimelapseCutoff();
    } else {
      state.timelapse.cutoff = null;
      $("timelapse-readout").textContent = t("timelapseAll");
    }
  } else {
    stopTimelapsePlayback();
    state.timelapse.cutoff = null;
  }
  refreshVisibility();
}

function updateTimelapseCutoff() {
  const { min, max, ratio } = state.timelapse;
  if (!min || !max) return;
  if (ratio >= 1) {
    state.timelapse.cutoff = null;
    $("timelapse-readout").textContent = t("timelapseAll");
  } else {
    const span = Date.parse(max) - Date.parse(min);
    const offset = Math.round(span * ratio);
    state.timelapse.cutoff = new Date(Date.parse(min) + offset).toISOString().slice(0, 10);
    $("timelapse-readout").textContent = t("timelapseCutoff", { date: state.timelapse.cutoff });
  }
  refreshVisibility();
}

function startTimelapsePlayback() {
  if (!state.timelapse.on) setTimelapse(true);
  state.timelapse.playing = true;
  $("timelapse-play").textContent = "⏸";
  const step = () => {
    if (!state.timelapse.playing) return;
    state.timelapse.ratio = Math.min(1, state.timelapse.ratio + 0.002);
    $("timelapse-slider").value = String(Math.round(state.timelapse.ratio * 1000));
    updateTimelapseCutoff();
    if (state.timelapse.ratio >= 1) {
      stopTimelapsePlayback();
      return;
    }
    state.timelapse.timer = setTimeout(step, 30);
  };
  step();
}

function stopTimelapsePlayback() {
  state.timelapse.playing = false;
  clearTimeout(state.timelapse.timer);
  $("timelapse-play").textContent = "▶";
}

// ---- menus ----

function closeMenus() {
  for (const id of ["layers-menu", "settings-menu"]) {
    $(id).classList.add("is-hidden");
  }
  $("btn-layers").setAttribute("aria-expanded", "false");
  $("btn-settings-menu").setAttribute("aria-expanded", "false");
}

function toggleMenu(id, buttonId) {
  const menu = $(id);
  const show = menu.classList.contains("is-hidden");
  closeMenus();
  menu.classList.toggle("is-hidden", !show);
  $(buttonId).setAttribute("aria-expanded", String(show));
}

function populateFilterOptions() {
  const classSelect = $("filter-class");
  const stabilitySelect = $("filter-stability");
  const current = { class: state.filters.class, stability: state.filters.stability };
  const classes = new Set(state.model?.nodes.map((node) => node.cls).filter(Boolean) ?? []);
  const stabilities = new Set(state.model?.nodes.map((node) => node.stability).filter(Boolean) ?? []);
  classSelect.innerHTML = "";
  stabilitySelect.innerHTML = "";
  for (const [value, label] of [
    ["all", t("filterAll")],
    ...[...classes].sort().map((cls) => [cls, t("classes")[cls] ?? cls]),
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    classSelect.appendChild(option);
  }
  for (const [value, label] of [
    ["all", t("filterAll")],
    ...[...stabilities].sort().map((s) => [s, t("stabilities")[s] ?? s]),
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    stabilitySelect.appendChild(option);
  }
  classSelect.value = current.class;
  stabilitySelect.value = current.stability;
}

// ---- translations ----

function applyTranslations() {
  document.title = `${t("title")} · Knowledge Universe`;
  $("search-input").placeholder = t("searchPlaceholder");
  $("btn-mode-toggle").textContent = state.mode === MODE_3D ? t("modeChart") : t("mode3d");
  $("label-layers").textContent = t("layersBtn");
  $("label-settings-menu").textContent = t("settingsBtn");
  $("btn-zoom-in").title = t("zoomIn");
  $("btn-zoom-out").title = t("zoomOut");
  $("layers-heading").textContent = t("layersHeading");
  $("label-layer-events").textContent = t("layerEventRings");
  $("label-layer-constellation").textContent = t("layerConstellation");
  $("label-layer-lanes").textContent = t("layerLanes");
  $("label-layer-nav").textContent = t("layerNav");
  $("label-layer-ghosts").textContent = t("layerGhosts");
  $("label-layer-archived").textContent = t("layerArchived");
  $("label-layer-memory").textContent = t("layerMemory");
  $("label-filter-class").textContent = t("filterClass");
  $("label-filter-stability").textContent = t("filterStability");
  $("settings-menu-heading").textContent = t("settingsMenuHeading");
  $("menu-health-text").textContent = t("menuHealth");
  $("menu-timelapse-text").textContent = t("menuTimelapse");
  $("menu-retrieval-text").textContent = t("menuRetrieval");
  $("menu-language-text").textContent = t("menuLanguage");
  $("opt-lang-auto").textContent = t("languageAuto");
  $("health-heading").textContent = t("healthHeading");
  $("health-close").title = t("healthClose");
  $("health-close").setAttribute("aria-label", t("healthClose"));
  for (const [value, key] of [["all", "healthFilterAll"], ["red", "healthFilterRed"], ["amber", "healthFilterAmber"], ["muted", "healthFilterMuted"]]) {
    const option = $("health-sev-" + value);
    if (option) option.textContent = t(key);
  }
  $("timelapse-play").textContent = state.timelapse.playing ? "⏸" : "▶";
  $("timelapse-exit").textContent = t("timelapseExit");
  $("timelapse-readout").textContent = state.timelapse.cutoff
    ? t("timelapseCutoff", { date: state.timelapse.cutoff })
    : t("timelapseAll");
  $("btn-retry-bridge").textContent = t("retryBtn");
  $("btn-dismiss-error").textContent = t("dismissBtn");
  $("fixture-badge").textContent = t("fixtureBadge");
  populateFilterOptions();
  view.drawer?.applyTranslations?.();
  view.settings?.applyTranslations();
  updateHeader();
  render();
}

// ---- boot ----

const view = { chart: null, three: null, drawer: null, settings: null };

async function boot() {
  state.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", (event) => {
    state.reducedMotion = event.matches;
    if (view.three) view.three.reduced = event.matches;
    render();
  });

  let storedLang = null;
  try {
    storedLang = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    storedLang = null;
  }
  state.lang = storedLang === "zh-CN" || storedLang === "en" ? storedLang : (navigator.language?.startsWith("zh") ? "zh-CN" : "en");

  state.webglAvailable = detectWebGL();
  const decision = initialViewMode({ webglAvailable: state.webglAvailable, storedMode: storedMode() });
  state.mode = decision.mode;
  if (decision.showFallbackNotice) {
    $("webgl-notice").textContent = t("webglFallback");
    $("webgl-notice").classList.remove("is-hidden");
  }

  view.chart = new ChartView($("stage-chart"));
  view.chart.onHover = (node, x, y) => showHoverCard(node, x, y);
  view.chart.onSelect = (node) => selectNode(node);
  view.chart.onGalaxyClick = (galaxyId) => enterGalaxy(galaxyId);
  view.chart.onBackgroundClick = () => {
    if (view.drawer?.isOpen()) {
      state.selectedId = null;
      view.drawer.close();
      render();
    }
  };

  view.drawer = new NoteDrawer({ t, showToast, fixtureMode: true });
  view.drawer.onNavigate = (node) => {
    if (state.focusGalaxyId !== node.galaxy) enterGalaxy(node.galaxy);
    selectNode(node);
  };
  view.settings = new RetrievalSettingsPanel({ t, showToast });

  bindUi();
  await loadGraph();
  view.chart.setModel(state.model, t);
  setMode(state.mode, { fromFallback: true });
  view.chart.resize();
}

function bindUi() {
  $("btn-mode-toggle").addEventListener("click", () => {
    setMode(state.mode === MODE_3D ? MODE_CHART : MODE_3D);
  });
  $("btn-layers").addEventListener("click", () => toggleMenu("layers-menu", "btn-layers"));
  $("btn-settings-menu").addEventListener("click", () => toggleMenu("settings-menu", "btn-settings-menu"));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-popover") && !event.target.closest(".corner-btn")) closeMenus();
    if (!event.target.closest(".search-box")) {
      $("search-results").classList.add("is-hidden");
    }
  });

  for (const [id, key] of [
    ["layer-events", "eventRings"],
    ["layer-constellation", "constellation"],
    ["layer-lanes", "lanes"],
    ["layer-nav", "nav"],
    ["layer-ghosts", "ghosts"],
    ["layer-archived", "archived"],
    ["layer-memory", "memory"],
  ]) {
    $(id).addEventListener("change", (event) => {
      state.layers[key] = event.target.checked;
      refreshVisibility();
    });
  }
  $("filter-class").addEventListener("change", (event) => {
    state.filters.class = event.target.value;
    refreshVisibility();
  });
  $("filter-stability").addEventListener("change", (event) => {
    state.filters.stability = event.target.value;
    refreshVisibility();
  });

  $("menu-health").addEventListener("click", () => {
    closeMenus();
    setHealthMode(!state.healthMode);
  });
  $("menu-timelapse").addEventListener("click", () => {
    closeMenus();
    setTimelapse(!state.timelapse.on);
  });
  $("menu-retrieval").addEventListener("click", () => {
    closeMenus();
    view.settings.open();
  });
  $("opt-lang-auto").addEventListener("click", () => {
    try {
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    } catch {}
    state.lang = navigator.language?.startsWith("zh") ? "zh-CN" : "en";
    applyTranslations();
  });
  $("opt-lang-zh").addEventListener("click", () => setLanguage("zh-CN"));
  $("opt-lang-en").addEventListener("click", () => setLanguage("en"));

  $("btn-zoom-in").addEventListener("click", () => zoom(1.3));
  $("btn-zoom-out").addEventListener("click", () => zoom(1 / 1.3));

  $("health-close").addEventListener("click", () => setHealthMode(false));
  $("health-severity-filter").addEventListener("change", () => renderHealthPanel());

  $("timelapse-play").addEventListener("click", () => {
    if (state.timelapse.playing) stopTimelapsePlayback();
    else startTimelapsePlayback();
  });
  $("timelapse-slider").addEventListener("input", (event) => {
    stopTimelapsePlayback();
    state.timelapse.ratio = Number(event.target.value) / 1000;
    updateTimelapseCutoff();
  });
  $("timelapse-exit").addEventListener("click", () => setTimelapse(false));

  const searchInput = $("search-input");
  searchInput.addEventListener("input", (event) => runSearch(event.target.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = state.searchMatches?.[0];
      if (chosen) chooseSearchMatch(chosen);
    } else if (event.key === "Escape") {
      $("search-results").classList.add("is-hidden");
      searchInput.blur();
    }
  });

  $("btn-retry-bridge").addEventListener("click", async () => {
    $("bridge-error-banner").classList.add("is-hidden");
    await loadGraph();
    view.chart.setModel(state.model, t);
    view.three?.setModel(state.model, t);
    render();
  });
  $("btn-dismiss-error").addEventListener("click", () => $("bridge-error-banner").classList.add("is-hidden"));

  window.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    if (event.key === "/" && !inField) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (event.key === "Escape") {
      if (view.settings?.isOpen()) view.settings.close();
      else if ($("health-region") && !$("health-region").classList.contains("is-hidden")) setHealthMode(false);
      else if (view.drawer?.isOpen()) {
        state.selectedId = null;
        view.drawer.close();
        render();
      } else if (state.focusGalaxyId) exitGalaxy();
      else closeMenus();
    }
  });
}

function setLanguage(lang) {
  state.lang = lang;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {}
  applyTranslations();
}

function zoom(factor) {
  if (state.mode === MODE_3D) view.three?.zoomBy(factor);
  else view.chart?.zoomBy(factor);
}

// Console/diagnostics hook: lets users and host tooling inspect the live
// view state (mode, layers, visibility) without touching behavior.
window.__kgUniverse = { state, view };

boot();
