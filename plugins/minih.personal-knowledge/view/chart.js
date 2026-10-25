/**
 * Flat star chart mode (design doc §5, §6): the reading view and the
 * WebGL-failure fallback. Canvas 2D, redrawn on demand; the only animation
 * is the two-pulse search-hit ring (§5.6), skipped under reduced motion.
 */

import { MACRO_STRETCH } from "./vendor/layout.mjs";
import { nodeDisplayName, planetRadius, starRadius, tethersOf } from "./model.js";
import { createSeededRandom, mixTowardWhite, clamp } from "./bridge.js";

const TAU = Math.PI * 2;
const SKY_INNER = "#13234a";
const SKY_OUTER = "#070d1d";
const HALO_COLOR = "#0a1430";
const LABEL_COLOR = "#c9d4f0";
const SERIF = '"Songti SC", "Noto Serif SC", "Source Han Serif SC", serif';
const SANS = '-apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif';

export const SEVERITY_COLORS = { red: "#f87171", amber: "#fbbf24", muted: "#94a3b8", ok: null };

export class ChartView {
  onHover = null;
  onSelect = null;
  onGalaxyClick = null;
  onBackgroundClick = null;

  constructor(container) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chart-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Knowledge Universe star chart");
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.transform = { scale: 1, ox: 0, oy: 0 };
    this.hoveredId = null;
    this.labelBoxes = [];
    this.pendingLabels = [];
    this.labelHitBoxes = [];
    this.pulse = null;
    this.rafId = 0;
    this.frameCount = 0;
    this.resize = this.resize.bind(this);
    this.redraw = this.redraw.bind(this);
    this.canvas.addEventListener("pointermove", this.onPointerMove.bind(this));
    this.canvas.addEventListener("pointerdown", this.onPointerDown.bind(this));
    this.canvas.addEventListener("pointerup", this.onPointerUp.bind(this));
    this.canvas.addEventListener("wheel", this.onWheel.bind(this), { passive: false });
    this.canvas.addEventListener("dblclick", this.onDoubleClick.bind(this));
    window.addEventListener("resize", this.resize);
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
  }

  setModel(model, t) {
    this.model = model;
    this.t = t;
    this.fieldStars = null;
  }

  /**
   * state: { visibility, layers, focusGalaxyId, selectedId, healthMode,
   * reducedMotion }. A focus or visibility change re-fits the camera.
   */
  setState(state) {
    const refit =
      state.focusGalaxyId !== this.state?.focusGalaxyId ||
      state.visibility !== this.state?.visibility;
    this.state = state;
    if (refit) this.fit();
    this.redraw();
  }

  get width() {
    return this.container.clientWidth;
  }

  get height() {
    return this.container.clientHeight;
  }

  resize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(this.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ratio = ratio;
    this.fieldStars = null;
    this.fit();
    this.redraw();
  }

  fit() {
    if (!this.model) return;
    const focus = this.state?.focusGalaxyId
      ? this.model.galaxiesById.get(this.state.focusGalaxyId)
      : null;
    if (focus) {
      // §6: the event ring fills 80% of the height, left of the drawer.
      const scale = (this.height * 0.4) / focus.re;
      this.transform = {
        scale,
        ox: this.width * 0.37 - focus.cx * scale,
        oy: this.height * 0.52 - focus.cy * scale,
      };
    } else {
      const scale = Math.min(
        (this.width * 0.94) / (2 * this.model.frame * MACRO_STRETCH),
        (this.height * 0.88) / (2 * this.model.frame),
      );
      this.transform = { scale, ox: this.width / 2, oy: this.height / 2 };
      this.fitScale = scale;
    }
  }

  zoomBy(factor) {
    const t = this.transform;
    this.transform = { scale: t.scale * factor, ox: t.ox, oy: t.oy };
    this.redraw();
  }

  panBy(dx, dy) {
    const t = this.transform;
    this.transform = { scale: t.scale, ox: t.ox + dx, oy: t.oy + dy };
    this.redraw();
  }

  /** World → screen; accepts nodes (x/y) and galaxies (cx/cy). */
  toScreen(point) {
    const { scale, ox, oy } = this.transform;
    return { x: (point.cx ?? point.x) * scale + ox, y: (point.cy ?? point.y) * scale + oy };
  }

  nodeAt(px, py) {
    if (!this.state) return null;
    let best = null;
    let bestDist = Infinity;
    for (const id of this.state.visibility.visibleNodes) {
      const node = this.model.nodesById.get(id);
      if (!node || node.kind === "satellite") continue;
      const p = this.toScreen(node);
      const r = this.nodeScreenRadius(node) + 4;
      const d = Math.hypot(px - p.x, py - p.y);
      if (d <= r && d < bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  nodeScreenRadius(node) {
    const galaxy = this.model.galaxyOfNode(node);
    const focus = Boolean(this.state?.focusGalaxyId);
    if (node.kind === "star") return galaxy ? starRadius(node, galaxy) * (focus ? 1.6 : 1) : 4;
    if (node.kind === "moon") return focus ? 2.0 : 1.1;
    return planetRadius(node, { galaxyView: focus });
  }

  visibleGalaxies() {
    const focusId = this.state?.focusGalaxyId;
    if (focusId) {
      const focus = this.model.galaxiesById.get(focusId);
      return focus ? [focus] : [];
    }
    return this.model.galaxies;
  }

  // ---- drawing ----

  redraw() {
    if (!this.model || !this.ratio) return;
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    this.frameCount += 1;
    this.labelBoxes = [];
    this.pendingLabels = [];
    this.labelHitBoxes = [];
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const sky = ctx.createRadialGradient(W / 2, H * 0.52, 0, W / 2, H * 0.52, Math.max(W, H) * 0.72);
    sky.addColorStop(0, SKY_INNER);
    sky.addColorStop(1, SKY_OUTER);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    this.drawFieldStars();
    this.drawGraticule();
    this.drawRings();
    this.drawLanes();
    this.drawLines();
    this.drawNodes();
    this.drawLabels();
  }

  drawFieldStars() {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    // §5.1: about 260 field stars per 1600×1000, fixed seed, static.
    if (!this.fieldStars) {
      const random = createSeededRandom(20261024);
      const count = Math.round((260 * W * H) / (1600 * 1000));
      this.fieldStars = [];
      for (let i = 0; i < count; i++) {
        this.fieldStars.push({
          x: random() * W,
          y: random() * H,
          r: 0.3 + random() * 0.7,
          a: 0.15 + random() * 0.3,
        });
      }
    }
    ctx.save();
    ctx.fillStyle = "#c7d2fe";
    for (const star of this.fieldStars) {
      ctx.globalAlpha = star.a;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawGraticule() {
    const ctx = this.ctx;
    const focusGalaxy = this.state?.focusGalaxyId
      ? this.model.galaxiesById.get(this.state.focusGalaxyId)
      : null;
    const c = this.toScreen(focusGalaxy ?? { cx: 0, cy: 0 });
    const { scale } = this.transform;
    ctx.save();
    ctx.strokeStyle = "#8fa6d6";
    ctx.lineWidth = 0.6;
    const radii = focusGalaxy
      ? [0.48 * focusGalaxy.R, 0.86 * focusGalaxy.R, focusGalaxy.re * 1.35]
      : [this.model.frame * 0.45, this.model.frame * 0.72];
    for (const r of radii) {
      ctx.globalAlpha = 0.1;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, r * scale * MACRO_STRETCH, r * scale, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.06;
    const reach = focusGalaxy ? focusGalaxy.re * 1.25 : this.model.frame * 0.98;
    for (let k = 0; k < 12; k++) {
      const a = (TAU * k) / 12;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(a) * reach * scale * MACRO_STRETCH, c.y + Math.sin(a) * reach * scale);
      ctx.stroke();
    }
    if (!focusGalaxy) {
      const fr = this.model.frame * scale;
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, fr * MACRO_STRETCH, fr, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.3;
      for (let k = 0; k < 120; k++) {
        const a = (TAU * k) / 120;
        const len = k % 10 === 0 ? 9 : 4;
        ctx.beginPath();
        ctx.moveTo(c.x + Math.cos(a) * fr * MACRO_STRETCH, c.y + Math.sin(a) * fr);
        ctx.lineTo(c.x + Math.cos(a) * (fr - len) * MACRO_STRETCH, c.y + Math.sin(a) * (fr - len));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawRings() {
    const ctx = this.ctx;
    const { scale } = this.transform;
    const focus = Boolean(this.state?.focusGalaxyId);
    ctx.save();
    for (const galaxy of this.visibleGalaxies()) {
      const c = this.toScreen(galaxy);
      const hue = galaxy.hue;
      if (galaxy.planets > 0 && !focus) {
        ctx.strokeStyle = hue;
        ctx.globalAlpha = 0.1;
        ctx.lineWidth = 0.6;
        for (const r of [galaxy.R * 0.48, galaxy.R * 0.86]) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, r * scale, 0, TAU);
          ctx.stroke();
        }
      }
      if (galaxy.events > 0 && this.state?.layers.eventRings) {
        ctx.strokeStyle = hue;
        ctx.globalAlpha = focus ? 0.22 : 0.3;
        ctx.lineWidth = focus ? 0.8 : 1.2;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, galaxy.re * scale, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  drawLanes() {
    if (this.state?.focusGalaxyId || !this.state?.layers.lanes) return;
    const ctx = this.ctx;
    const laneCounts = new Map();
    for (const link of this.state.visibility.visibleLinks) {
      if (link.kind !== "lane") continue;
      const a = this.model.galaxyOfNode(this.model.nodesById.get(link.source));
      const b = this.model.galaxyOfNode(this.model.nodesById.get(link.target));
      if (!a || !b) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      laneCounts.set(key, (laneCounts.get(key) ?? 0) + 1);
    }
    ctx.save();
    for (const [key, count] of laneCounts) {
      const [idA, idB] = key.split("|");
      const a = this.model.galaxiesById.get(idA);
      const b = this.model.galaxiesById.get(idB);
      if (!a || !b) continue;
      const p1 = this.toScreen(a);
      const p2 = this.toScreen(b);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const nx = -(p2.y - p1.y) * 0.12;
      const ny = (p2.x - p1.x) * 0.12;
      ctx.strokeStyle = idA === "shared" ? b.hue : a.hue;
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = clamp(0.6 + 0.2 * count, 0.6, 1.8);
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo(mx + nx, my + ny, p2.x, p2.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLines() {
    const ctx = this.ctx;
    const focus = Boolean(this.state?.focusGalaxyId);
    const hovered = this.hoveredId ? this.model.nodesById.get(this.hoveredId) : null;
    ctx.save();
    ctx.lineCap = "round";
    for (const link of this.state.visibility.visibleLinks) {
      if (link.kind !== "constellation" && link.kind !== "typed") continue;
      const s = this.model.nodesById.get(link.source);
      const t = this.model.nodesById.get(link.target);
      if (!s || !t) continue;
      const hot = hovered && (link.source === hovered.id || link.target === hovered.id);
      const hue = this.model.galaxyOfNode(s)?.hue ?? "#dbe6ff";
      const [x1, y1, x2, y2] = this.shortSegment(s, t, 2.5);
      if (link.kind === "typed") {
        ctx.strokeStyle = "#f8fafc";
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        this.drawArrowhead(x1, y1, x2, y2);
        continue;
      }
      // §5.6 hover: the node's lines turn white, the rest drops to 40%.
      ctx.strokeStyle = hot ? "#ffffff" : hue;
      ctx.globalAlpha = hot ? 0.9 : hovered ? 0.18 : focus ? 0.25 : 0.45;
      ctx.lineWidth = hot ? 1.3 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    this.drawTethers();
    ctx.restore();
  }

  shortSegment(s, t, gap) {
    const a = this.toScreen(s);
    const b = this.toScreen(t);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ga = this.nodeScreenRadius(s) + gap;
    const gb = this.nodeScreenRadius(t) + gap;
    return [
      a.x + (dx * ga) / len,
      a.y + (dy * ga) / len,
      b.x - (dx * gb) / len,
      b.y - (dy * gb) / len,
    ];
  }

  drawArrowhead(x1, y1, x2, y2, size = 4) {
    const ctx = this.ctx;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(angle) * size, my + Math.sin(angle) * size);
    ctx.lineTo(mx + Math.cos(angle + 2.5) * size, my + Math.sin(angle + 2.5) * size);
    ctx.lineTo(mx + Math.cos(angle - 2.5) * size, my + Math.sin(angle - 2.5) * size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** §5.4 tethers for the hovered or selected planet, capped at 12. */
  drawTethers() {
    const ctx = this.ctx;
    const anchorId = this.hoveredId ?? this.state?.selectedId;
    if (!anchorId) return;
    const anchor = this.model.nodesById.get(anchorId);
    if (!anchor || anchor.kind !== "planet") return;
    const events = tethersOf(this.model, anchorId);
    if (events) {
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 0.8;
      const p = this.toScreen(anchor);
      for (const event of events) {
        const e = this.toScreen(event);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // Above the cap: light the planet's events on the ring instead (§5.4).
      ctx.save();
      ctx.fillStyle = this.model.galaxyOfNode(anchor)?.hue ?? "#dbe6ff";
      for (const event of this.model.tethersByPlanet.get(anchorId) ?? []) {
        const e = this.toScreen(event);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(e.x, e.y, this.nodeScreenRadius(event) * 1.6, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  symbolPath(node, x, y, r, color) {
    const ctx = this.ctx;
    switch (node.cls) {
      case "procedure":
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x - r * 2.2, y);
        ctx.lineTo(x + r * 2.2, y);
        ctx.stroke();
        break;
      case "reference":
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.5, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, TAU);
        ctx.fill();
        break;
      case "environment":
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.7;
        ctx.setLineDash([1.5, 1.5]);
        ctx.beginPath();
        ctx.arc(x, y, r * 1.7, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.7, 0, TAU);
        ctx.fill();
        break;
      case "technology":
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, y - r * 1.4);
        ctx.lineTo(x + r * 1.4, y);
        ctx.lineTo(x, y + r * 1.4);
        ctx.lineTo(x - r * 1.4, y);
        ctx.closePath();
        ctx.stroke();
        break;
      case "convention":
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.2, 0, TAU);
        ctx.stroke();
        break;
      case "organization":
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.9, r * 0.9, 0, 0, TAU);
        ctx.stroke();
        break;
      default:
        if (node.cls === "unknown") ctx.globalAlpha *= 0.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
    }
  }

  drawNodes() {
    const ctx = this.ctx;
    const focus = Boolean(this.state?.focusGalaxyId);
    const focusId = this.state?.focusGalaxyId ?? null;
    const selectedId = this.state?.selectedId;
    const healthMode = this.state?.healthMode;
    ctx.save();
    for (const node of this.model.nodes) {
      if (!this.state.visibility.visibleNodes.has(node.id)) continue;
      if (focusId && node.galaxy !== focusId && node.kind !== "satellite") continue;
      const galaxy = this.model.galaxyOfNode(node);
      const hue = galaxy?.hue ?? "#dbe6ff";
      const p = this.toScreen(node);
      const color = healthMode ? SEVERITY_COLORS[nodeSeverityOf(node)] ?? hue : hue;
      const planetColor = healthMode ? color : mixTowardWhite(hue, 0.55);
      if (node.kind === "moon") {
        ctx.fillStyle = color;
        ctx.globalAlpha = focus ? 0.85 : 0.7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.nodeScreenRadius(node), 0, TAU);
        ctx.fill();
      } else if (node.kind === "planet" || node.kind === "nav") {
        ctx.fillStyle = planetColor;
        ctx.globalAlpha = node.kind === "nav" ? 0.7 : 1;
        this.symbolPath(node, p.x, p.y, this.nodeScreenRadius(node), planetColor);
        if (node.kind === "nav") {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = planetColor;
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(p.x - 2.5, p.y - 2.5);
          ctx.lineTo(p.x + 2.5, p.y + 2.5);
          ctx.moveTo(p.x + 2.5, p.y - 2.5);
          ctx.lineTo(p.x - 2.5, p.y + 2.5);
          ctx.stroke();
        }
      } else if (node.kind === "star" && galaxy) {
        const r = starRadius(node, galaxy);
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fbfbff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
      } else if (node.kind === "satellite") {
        this.drawSparkle(p.x, p.y, 3.2, hue);
      }
      if (node.id === selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.nodeScreenRadius(node) + 6, 0, TAU);
        ctx.stroke();
      }
    }
    if (!focus) {
      // Shared-center marker (§5.3).
      const shared = this.model.galaxiesById.get("shared");
      if (shared) {
        const c = this.toScreen(shared);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fbfbff";
        ctx.beginPath();
        ctx.arc(c.x, c.y, 3, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = shared.hue;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 7, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** §13 memory-satellite sparkle: a four-point star in the galaxy hue. */
  drawSparkle(x, y, r, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
    ctx.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
    ctx.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
    ctx.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  placeLabel(x, y, text, { anchor = "start", force = false } = {}) {
    const width = this.ctx.measureText(text).width;
    const x0 = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    const box = { x0: x0 - 3, y0: y - 13, x1: x0 + width + 3, y1: y + 3 };
    if (!force && this.labelBoxes.some((b) => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1))) {
      return false;
    }
    this.labelBoxes.push(box);
    this.pendingLabels.push({ x, y, text, anchor, box });
    return true;
  }

  drawLabels() {
    const ctx = this.ctx;
    const t = this.t;
    const focus = Boolean(this.state?.focusGalaxyId);
    const hovered = this.hoveredId ? this.model.nodesById.get(this.hoveredId) : null;
    ctx.save();
    ctx.textBaseline = "alphabetic";

    // Galaxy names are always shown (§5.5): serif below the event ring.
    // Majors claim their (forced) boxes first so belt names can dodge them;
    // the reverse order would let a forced major land on a placed belt name.
    const orderedGalaxies = [...this.visibleGalaxies()].sort(
      (a, b) => (a.role === "belt" ? 1 : 0) - (b.role === "belt" ? 1 : 0),
    );
    for (const galaxy of orderedGalaxies) {
      const c = this.toScreen(galaxy);
      const major = galaxy.role !== "belt";
      const name = galaxy.id === "shared" ? t("sharedGalaxy") : galaxy.name;
      const y = c.y + (focus ? galaxy.re * this.transform.scale + 34 : major ? galaxy.re * this.transform.scale + 22 : 16);
      ctx.font = major ? `600 17px ${SERIF}` : `11px ${SANS}`;
      // Galaxy names are always shown. Belt (outer-ring) names yield first:
      // try offset slots when the default spot collides, and only fall back
      // to a forced placement when nothing fits.
      const beltOffsets = (() => {
        if (major) return [{ dx: 0, dy: 0, anchor: "middle" }];
        const w = ctx.measureText(name).width;
        const beside = w / 2 + 8;
        const wide = w * 0.55 + 6;
        const farther = w * 1.15 + 16;
        const farthest = w * 1.8 + 30;
        return [
          { dx: 0, dy: 0, anchor: "middle" },
          { dx: 0, dy: 16, anchor: "middle" },
          { dx: 0, dy: -16, anchor: "middle" },
          // Anchor next to the point instead of centered on it — a different
          // footprint that escapes centered-name pile-ups.
          { dx: beside, dy: 0, anchor: "start" },
          { dx: -beside, dy: 0, anchor: "end" },
          { dx: beside, dy: 14, anchor: "start" },
          { dx: -beside, dy: 14, anchor: "end" },
          { dx: beside, dy: -12, anchor: "start" },
          { dx: -beside, dy: -12, anchor: "end" },
          { dx: wide, dy: -8, anchor: "middle" },
          { dx: -wide, dy: -8, anchor: "middle" },
          { dx: wide, dy: 14, anchor: "middle" },
          { dx: -wide, dy: 14, anchor: "middle" },
          { dx: 0, dy: 32, anchor: "middle" },
          { dx: 0, dy: -32, anchor: "middle" },
          { dx: farther, dy: 0, anchor: "middle" },
          { dx: -farther, dy: 0, anchor: "middle" },
          { dx: farther, dy: -16, anchor: "middle" },
          { dx: -farther, dy: -16, anchor: "middle" },
          { dx: farther, dy: 16, anchor: "middle" },
          { dx: -farther, dy: 16, anchor: "middle" },
          { dx: 0, dy: 48, anchor: "middle" },
          { dx: 0, dy: -48, anchor: "middle" },
          { dx: wide, dy: 32, anchor: "middle" },
          { dx: -wide, dy: 32, anchor: "middle" },
          { dx: wide, dy: -32, anchor: "middle" },
          { dx: -wide, dy: -32, anchor: "middle" },
          { dx: 0, dy: 64, anchor: "middle" },
          { dx: 0, dy: -64, anchor: "middle" },
          { dx: 0, dy: 8, anchor: "middle" },
          { dx: 0, dy: -8, anchor: "middle" },
          { dx: 0, dy: 24, anchor: "middle" },
          { dx: 0, dy: -24, anchor: "middle" },
          { dx: 0, dy: 40, anchor: "middle" },
          { dx: 0, dy: -40, anchor: "middle" },
          { dx: 0, dy: 56, anchor: "middle" },
          { dx: 0, dy: -56, anchor: "middle" },
          { dx: 0, dy: 72, anchor: "middle" },
          { dx: 0, dy: -72, anchor: "middle" },
          { dx: 0, dy: 80, anchor: "middle" },
          { dx: 0, dy: -80, anchor: "middle" },
          { dx: wide, dy: 48, anchor: "middle" },
          { dx: -wide, dy: 48, anchor: "middle" },
          { dx: wide, dy: -48, anchor: "middle" },
          { dx: -wide, dy: -48, anchor: "middle" },
          { dx: farthest, dy: 0, anchor: "middle" },
          { dx: -farthest, dy: 0, anchor: "middle" },
          { dx: farthest, dy: -16, anchor: "middle" },
          { dx: -farthest, dy: -16, anchor: "middle" },
        ];
      })();
      let placedName = false;
      for (const candidate of beltOffsets) {
        if (major && (candidate.dx !== 0 || candidate.dy !== 0)) continue;
        if (this.placeLabel(c.x + candidate.dx, y + candidate.dy, name, { anchor: candidate.anchor, force: major })) {
          const label = this.pendingLabels[this.pendingLabels.length - 1];
          // Keep the candidate on the canvas; a box hanging off the edge is
          // as useless as a collision, so reject it and try the next slot.
          const box = label.box;
          if (!major && (box.x0 < 0 || box.y0 < 0 || box.x1 > this.width || box.y1 > this.height)) {
            this.labelBoxes.pop();
            this.pendingLabels.pop();
            continue;
          }
          label.serif = major;
          label.fontSize = major ? 17 : 11;
          label.color = mixTowardWhite(galaxy.hue, 0.25);
          label.galaxyId = galaxy.id;
          placedName = true;
          break;
        }
      }
      if (!placedName && !major) {
        // Must display: force the default spot as the last resort.
        this.placeLabel(c.x, y, name, { anchor: "middle", force: true });
        const label = this.pendingLabels[this.pendingLabels.length - 1];
        label.serif = false;
        label.fontSize = 11;
        label.color = mixTowardWhite(galaxy.hue, 0.25);
        label.galaxyId = galaxy.id;
      }
      if (major) {
        const caption = t("galaxyCaption", { planets: galaxy.planets, events: galaxy.events });
        ctx.font = `11px ${SANS}`;
        if (this.placeLabel(c.x, y + 17, caption, { anchor: "middle", force: true })) {
          const cap = this.pendingLabels[this.pendingLabels.length - 1];
          cap.color = galaxy.hue;
          cap.opacity = 0.7;
          cap.fontSize = 11;
        }
      }
    }

    // Planet names: top by degree, greedy collision, budget 12 / 18 (§5.5).
    // In the overview they appear only at 1.6× the fit zoom or more.
    const budget = focus ? 18 : 12;
    const showPlanetNames = focus || this.transform.scale >= (this.fitScale ?? this.transform.scale) * 1.6;
    let shown = 0;
    if (showPlanetNames || hovered) {
      const candidates = [];
      for (const id of this.state.visibility.visibleNodes) {
        const node = this.model.nodesById.get(id);
        if (node?.kind === "planet") candidates.push(node);
      }
      candidates.sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || (a.id < b.id ? -1 : 1));
      if (hovered) {
        // §5.5: the hovered node's name always wins a collision.
        const p = this.toScreen(hovered);
        ctx.font = `600 14px ${SANS}`;
        if (this.placeLabel(p.x, p.y - this.nodeScreenRadius(hovered) - 8, nodeDisplayName(this.model, hovered, this.t), { anchor: "middle", force: true })) {
          shown++;
        }
      }
      ctx.font = `${focus ? 12 : 10.5}px ${SANS}`;
      for (const node of candidates) {
        if (shown >= budget) break;
        if (hovered && node.id === hovered.id) continue;
        const p = this.toScreen(node);
        if (this.placeLabel(p.x + this.nodeScreenRadius(node) + 5, p.y + 4, nodeDisplayName(this.model, node, this.t))) {
          shown++;
        }
      }
    }

    // Keep every label on the canvas: shift boxes that would clip at the
    // left/right edge, then draw at the shifted position.
    const W = this.width;
    for (const label of this.pendingLabels) {
      const overflow = label.box.x1 > W - 4 ? label.box.x1 - (W - 4) : 0;
      const underflow = label.box.x0 < 4 ? 4 - label.box.x0 : 0;
      const shift = overflow > 0 ? -overflow : underflow > 0 ? underflow : 0;
      if (shift !== 0) {
        label.x += shift;
        label.box.x0 += shift;
        label.box.x1 += shift;
      }
    }
    for (const label of this.pendingLabels) {
      ctx.save();
      ctx.font = label.serif
        ? `600 ${label.fontSize ?? 17}px ${SERIF}`
        : `${label.fontSize ?? 11}px ${SANS}`;
      ctx.textAlign = label.anchor === "middle" ? "center" : label.anchor;
      ctx.lineWidth = 3;
      ctx.strokeStyle = HALO_COLOR;
      ctx.globalAlpha = label.opacity ?? 1;
      ctx.lineJoin = "round";
      ctx.strokeText(label.text, label.x, label.y);
      ctx.fillStyle = label.color ?? LABEL_COLOR;
      ctx.fillText(label.text, label.x, label.y);
      ctx.restore();
    }
    ctx.restore();
    this.labelHitBoxes = this.pendingLabels
      .filter((label) => label.galaxyId)
      .map((label) => ({ box: label.box, galaxyId: label.galaxyId }));
    this.pendingLabels = [];
  }

  /** Search-hit ring pulse, twice (§5.6); skipped under reduced motion. */
  playSearchPulse(nodeId, reducedMotion) {
    if (reducedMotion) return;
    this.pulse = { id: nodeId, startedAt: performance.now() };
    if (this.rafId) return;
    const step = () => {
      this.rafId = 0;
      const pulse = this.pulse;
      if (!pulse) return;
      const elapsed = performance.now() - pulse.startedAt;
      if (elapsed > 900) {
        this.pulse = null;
        this.redraw();
        return;
      }
      this.redraw();
      const node = this.model.nodesById.get(pulse.id);
      if (node) {
        const ctx = this.ctx;
        const p = this.toScreen(node);
        const phase = (elapsed % 450) / 450;
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.globalAlpha = 1 - phase;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.nodeScreenRadius(node) + 4 + phase * 10, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  // ---- interaction ----

  onPointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (this.dragging) {
      this.panBy(event.clientX - this.dragging.x, event.clientY - this.dragging.y);
      this.dragging = { x: event.clientX, y: event.clientY };
      return;
    }
    const node = this.nodeAt(x, y);
    const changed = (node?.id ?? null) !== this.hoveredId;
    this.hoveredId = node?.id ?? null;
    if (changed) this.redraw();
    this.onHover?.(node ?? null, event.clientX, event.clientY);
  }

  onPointerDown(event) {
    if (event.button === 0) this.dragging = { x: event.clientX, y: event.clientY };
  }

  onPointerUp(event) {
    const wasDrag =
      this.dragging && Math.hypot(event.clientX - this.dragging.x, event.clientY - this.dragging.y) > 4;
    this.dragging = null;
    if (wasDrag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (const hit of this.labelHitBoxes) {
      if (x >= hit.box.x0 && x <= hit.box.x1 && y >= hit.box.y0 && y <= hit.box.y1) {
        this.onGalaxyClick?.(hit.galaxyId);
        return;
      }
    }
    const node = this.nodeAt(x, y);
    if (!node) {
      this.onBackgroundClick?.();
      return;
    }
    if (node.kind === "star") this.onGalaxyClick?.(node.galaxy);
    else this.onSelect?.(node);
  }

  onWheel(event) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const t = this.transform;
    this.transform = {
      scale: t.scale * factor,
      ox: px - (px - t.ox) * factor,
      oy: py - (py - t.oy) * factor,
    };
    this.redraw();
  }

  onDoubleClick() {
    this.fit();
    this.redraw();
  }
}

