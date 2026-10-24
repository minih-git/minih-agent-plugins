/**
 * 3D star map (default view, design doc §7).
 *
 * `3d-force-graph` carries the scene: fixed node positions (fx/fy/fz from
 * the §4 layout, cooldownTicks(0)), one shared `three` from the vendor
 * bundle, an `UnrealBloomPass` + `OutputPass` composer, and a
 * `CSS2DRenderer` overlay for sharp CJK labels. The built-in trackball
 * controls are disabled; a small camera rig implements the spec's orbit,
 * elevation clamp, intro ease, and idle drift.
 */

import {
  ForceGraph3D,
  THREE,
  UnrealBloomPass,
  OutputPass,
  CSS2DRenderer,
  CSS2DObject,
  Line2,
  LineMaterial,
  LineGeometry,
} from "./vendor/universe-3d.mjs";
import { MACRO_STRETCH, DISK_TILT } from "./vendor/layout.mjs";
import { forceGraphNodes, nodeDisplayName, planetRadius, starRadius, tethersOf } from "./model.js";
import { nodeSeverity } from "./strings.js";
import { createSeededRandom, clamp } from "./bridge.js";

const TAU = Math.PI * 2;
const FOV = 40;
const ELEVATION = { overview: 0.6, galaxy: 0.62, min: 0.15, max: 1.35, intro: 0.9 };
const OVERVIEW_TARGET = { x: 0, y: -70, z: 0 };
const INTRO_MS = 1600;
const FOCUS_MS = 400;
const IDLE_DRIFT_DELAY_MS = 20_000;
const IDLE_DRIFT_RAD_S = (0.6 * Math.PI) / 180;
const RING_ROTATION_RAD_S = 0.01;
const BREATH_PERIOD_S = 6;
const TYPED_PARTICLE_SPEED = 0.15; // fraction of the line per second
const LABEL_HZ = 10;
export const SEVERITY_COLORS = { red: 0xf87171, amber: 0xfbbf24, muted: 0x94a3b8, ok: null };

export class ThreeView {
  onHover = null;
  onSelect = null;
  onGalaxyClick = null;

  constructor(container) {
    this.container = container;
    this.reduced = false;
    this.disposed = false;

    this.css2d = new CSS2DRenderer();
    this.css2d.domElement.style.position = "absolute";
    this.css2d.domElement.style.inset = "0";
    this.css2d.domElement.style.pointerEvents = "none";
    this.css2d.domElement.classList.add("kg-label-layer");

    this.fg = ForceGraph3D({ extraRenderers: [this.css2d] })(container)
      .width(container.clientWidth)
      .height(container.clientHeight)
      .backgroundColor("#050a1c")
      .showNavInfo(false)
      .enableNodeDrag(false)
      .warmupTicks(1)
      .cooldownTicks(0)
      .linkVisibility(false)
      .nodeThreeObjectExtend(false)
      .nodeThreeObject((clone) => this.buildNodeObject(clone.ref))
      .onNodeHover((clone) => this.handleHover(clone?.ref ?? null))
      .onNodeClick((clone) => this.handleClick(clone?.ref ?? null));

    this.fg.renderer().setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    // The spec's camera rig replaces the trackball controls.
    this.fg.controls().enabled = false;

    const scene = this.fg.scene();
    scene.fog = null; // set per model (density depends on the frame)
    this.camera = this.fg.camera();
    this.camera.up = new THREE.Vector3(0, 0, 1);
    this.camera.fov = FOV;
    this.camera.updateProjectionMatrix();

    this.staticGroup = new THREE.Group();
    scene.add(this.staticGroup);
    this.dynamicGroup = new THREE.Group();
    scene.add(this.dynamicGroup);
    this.labelGroup = new THREE.Group();
    scene.add(this.labelGroup);

    this.nodeObjects = new Map(); // id → Object3D (from 3d-force-graph)
    this.planetLabels = new Map(); // id → CSS2DObject
    this.galaxyLabels = new Map(); // id → CSS2DObject
    this.ringHolders = new Map(); // galaxyId → rotating group of event Points
    this.eventAngles = new Map(); // galaxyId → [{ id, dx, dy }]
    this.tetherLines = []; // { line, event }
    this.typedLines = []; // { line, link, particle }
    this.constellation = null; // LineSegments + color metadata
    this.coronas = []; // breathing star coronas
    this.particles = []; // typed-line flowing particles

    this.cam = { az: 0, el: ELEVATION.overview, dist: 1200, target: { ...OVERVIEW_TARGET } };
    this.camAnim = null;
    this.introPlayed = false;
    this.lastInputAt = performance.now();
    this.hoveredId = null;
    this.model = null;
    this.state = null;
    this.clock = { last: performance.now(), rotation: 0 };
    this.labelClock = 0;
    this.pulse = null;
    this.frameCount = 0;
    this.fpsFrames = 0;

    this.bindPointer();
    this.animate = this.animate.bind(this);
    this.rafId = requestAnimationFrame(this.animate);
    this.onResize = this.onResize.bind(this);
    window.addEventListener("resize", this.onResize);
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.onResize);
    this.fg._destructor?.();
    this.container.innerHTML = "";
  }

  onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.fg.width(w).height(h);
    for (const material of this.lineMaterials ?? []) material.resolution.set(w, h);
    this.composer?.setSize(w, h);
  }

  setModel(model, t) {
    this.model = model;
    this.t = t;
    const scene = this.fg.scene();
    scene.fog = new THREE.FogExp2(0x0a1230, 0.35 / model.frame);
    this.starfield = null; // rebuilt for the new frame size
    this.buildGalaxyLabels();
    this.camera.fitDistance = this.overviewDistance();
  }

  overviewDistance() {
    const tan = Math.tan((FOV * Math.PI) / 360);
    const aspect = Math.max(0.3, this.container.clientWidth / Math.max(1, this.container.clientHeight));
    // The frame fills 92% of the viewport width (§7).
    return Math.max(
      (this.model.frame * MACRO_STRETCH) / (0.92 * tan * aspect),
      (this.model.frame * 1.06) / (0.92 * tan),
    );
  }

  /** Full scene rebuild from view state (visibility, focus, health, layers). */
  render(state) {
    if (!this.model) return;
    const focusChanged = state.focusGalaxyId !== this.state?.focusGalaxyId;
    this.state = state;
    this.rebuildStatic();
    this.rebuildGraph();
    if (focusChanged) this.focusGalaxy(state.focusGalaxyId);
    this.updateHoverHighlight();
  }

  // ---- scene construction ----

  ensureStarfield() {
    if (this.starfield) return;
    // §7: 2,500 points on a shell at 6 × frame from a fixed seed.
    const random = createSeededRandom(0x51a4f);
    const radius = this.model.frame * 6;
    const bright = 2500 * 0.07;
    const make = (count, size, minSize) => {
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const warm = new THREE.Color("#ffd9b0");
      const cool = new THREE.Color("#b9d0ff");
      const plain = new THREE.Color("#e6ecff");
      for (let i = 0; i < count; i++) {
        // Uniform direction on a sphere.
        const u = random() * 2 - 1;
        const phi = random() * TAU;
        const s = Math.sqrt(1 - u * u);
        positions[i * 3] = radius * s * Math.cos(phi);
        positions[i * 3 + 1] = radius * s * Math.sin(phi);
        positions[i * 3 + 2] = radius * u;
        const tint = random();
        const color = tint < 0.15 ? warm : tint < 0.3 ? cool : plain;
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({
        size,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        fog: false,
      });
      return new THREE.Points(geometry, material);
    };
    this.staticGroup.add(make(bright, 2.0, 1.6));
    this.staticGroup.add(make(2500 - bright, 0.7, 0.4));
    this.starfield = true;
  }

  nebulaTexture(hue) {
    const key = `nebula:${hue}`;
    if (!this.textures) this.textures = new Map();
    if (this.textures.has(key)) return this.textures.get(key);
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, hue + "42"); // opacity 0.26 center
    gradient.addColorStop(0.5, hue + "14");
    gradient.addColorStop(1, hue + "00");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    this.textures.set(key, texture);
    return texture;
  }

  coronaTexture(hue) {
    const key = `corona:${hue}`;
    if (!this.textures) this.textures = new Map();
    if (this.textures.has(key)) return this.textures.get(key);
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "#ffffff55");
    gradient.addColorStop(0.22, hue + "80");
    gradient.addColorStop(0.55, hue + "22");
    gradient.addColorStop(1, hue + "00");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    this.textures.set(key, texture);
    return texture;
  }

  planetTexture(hue, severity = null) {
    const key = `planet:${hue}:${severity ?? ""}`;
    if (!this.textures) this.textures = new Map();
    if (this.textures.has(key)) return this.textures.get(key);
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const base = severity ? `#${SEVERITY_COLORS[severity].toString(16).padStart(6, "0")}` : hue;
    // §7: shaded sphere — highlight at (35%, 32%), hue at 45%, dark edge.
    const gradient = ctx.createRadialGradient(size * 0.35, size * 0.32, size * 0.05, size / 2, size / 2, size * 0.62);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.45, base);
    gradient.addColorStop(1, "#1a2040");
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.48, 0, TAU);
    ctx.fillStyle = gradient;
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    this.textures.set(key, texture);
    return texture;
  }

  markTexture(kind) {
    // Thin class marks: tilted ring (solid or dashed) and a procedure bar.
    const key = `mark:${kind}`;
    if (!this.textures) this.textures = new Map();
    if (this.textures.has(key)) return this.textures.get(key);
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#e7edff";
    ctx.lineWidth = 5;
    if (kind === "bar") {
      ctx.beginPath();
      ctx.moveTo(8, size / 2);
      ctx.lineTo(size - 8, size / 2);
      ctx.stroke();
    } else {
      if (kind === "ring-dashed") ctx.setLineDash([10, 9]);
      ctx.beginPath();
      ctx.ellipse(size / 2, size / 2, size * 0.44, size * 0.17, -0.35, 0, TAU);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    this.textures.set(key, texture);
    return texture;
  }

  buildNodeObject(node) {
    const galaxy = this.model.galaxyOfNode(node);
    const hue = galaxy?.hue ?? "#dbe6ff";
    const group = new THREE.Group();
    const severity = this.state?.healthMode ? nodeSeverity(node.issues) : null;
    if (node.kind === "star") {
      const r = (galaxy ? starRadius(node, galaxy) : 4) * 1.2;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xfff6dd, fog: true }),
      );
      group.add(sphere);
      const major = galaxy?.role === "major";
      const corona = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.coronaTexture(hue),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          fog: false,
        }),
      );
      const coronaScale = r * (major ? 6.5 : 5);
      corona.scale.set(coronaScale, coronaScale, 1);
      group.add(corona);
      this.coronas.push({ sprite: corona, base: coronaScale });
    } else if (node.kind === "planet" || node.kind === "nav") {
      const r = planetRadius(node) * 1.15;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.planetTexture(hue, severity),
          transparent: true,
          fog: true,
        }),
      );
      sprite.scale.set(r * 2, r * 2, 1);
      group.add(sprite);
      if (node.cls === "reference" || node.cls === "environment") {
        const mark = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.markTexture(node.cls === "environment" ? "ring-dashed" : "ring"),
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
            fog: false,
          }),
        );
        mark.scale.set(r * 4.6, r * 4.6, 1);
        group.add(mark);
      } else if (node.cls === "procedure") {
        const mark = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.markTexture("bar"),
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
            fog: false,
          }),
        );
        mark.scale.set(r * 5.4, r * 5.4, 1);
        group.add(mark);
      }
    } else if (node.kind === "nav") {
      const wire = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.8),
        new THREE.MeshBasicMaterial({ color: hue, wireframe: true, transparent: true, opacity: 0.75, fog: true }),
      );
      group.add(wire);
    }
    return group;
  }

  galaxyGroupTransform(galaxy) {
    // Local disk coords (dx, dy) → world: translate + tilt (§4).
    const group = new THREE.Group();
    group.position.set(galaxy.cx, -galaxy.cy, galaxy.h);
    group.rotation.x = -DISK_TILT;
    return group;
  }

  rebuildStatic() {
    const { state, model } = this;
    this.staticGroup.clear();
    this.dynamicGroup.clear();
    this.coronas = [];
    this.typedLines = [];
    this.particles = [];
    this.tetherLines = [];
    this.lineMaterials = [];
    this.ensureStarfield();

    const focusGalaxy = state.focusGalaxyId ? model.galaxiesById.get(state.focusGalaxyId) : null;
    const visible = state.visibility;

    // Ecliptic grid (§7): four dashed ellipses on z = 0, or galaxy-plane
    // rings in the galaxy view.
    if (focusGalaxy) {
      for (const r of [focusGalaxy.R * 0.48, focusGalaxy.R * 0.86, focusGalaxy.re * 1.35]) {
        this.staticGroup.add(this.diskRing(focusGalaxy, r, 0.1, false));
      }
    } else {
      for (const k of [0.3, 0.55, 0.8, 1.0]) {
        this.staticGroup.add(this.eclipticEllipse(model.frame * k, 0.1));
      }
    }

    // Nebulae: one per major galaxy plus the shared galaxy (§7).
    const shownGalaxies = focusGalaxy ? [focusGalaxy] : model.galaxies;
    for (const galaxy of shownGalaxies) {
      if (galaxy.role === "belt") continue;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.nebulaTexture(galaxy.hue),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          fog: false,
        }),
      );
      const radius = galaxy.re * 2.1;
      sprite.scale.set(radius * 1.25, radius * 0.8, 1);
      sprite.position.set(galaxy.cx, -galaxy.cy, galaxy.h);
      this.staticGroup.add(sprite);
    }

    // Event rings: one THREE.Points per galaxy on its ring (§7), rotating.
    this.ringHolders.clear();
    this.eventAngles.clear();
    for (const galaxy of shownGalaxies) {
      if (galaxy.events === 0 || !state.layers.eventRings) continue;
      const holder = this.galaxyGroupTransform(galaxy);
      const spinner = new THREE.Group();
      const moons = model.nodes.filter((node) => node.galaxy === galaxy.id && node.kind === "moon");
      const positions = new Float32Array(moons.length * 3);
      const angles = [];
      moons.forEach((moon, i) => {
        const dx = moon.x - galaxy.cx;
        const dy = moon.y - galaxy.cy;
        positions[i * 3] = dx;
        positions[i * 3 + 1] = dy;
        positions[i * 3 + 2] = 0;
        angles.push({ id: moon.id, dx, dy });
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color: galaxy.hue,
        size: 2.1,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        fog: true,
      });
      spinner.add(new THREE.Points(geometry, material));
      holder.add(spinner);
      holder.userData.spinner = spinner;
      this.dynamicGroup.add(holder);
      this.ringHolders.set(galaxy.id, holder);
      this.eventAngles.set(galaxy.id, angles);
    }

    // Satellites (memory, §13): four-point sparkle just outside the ring.
    if (state.layers.memory) {
      for (const node of model.nodes) {
        if (node.kind !== "satellite" || !visible.visibleNodes.has(node.id)) continue;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.sparkleTexture(this.model.galaxyOfNode(node)?.hue ?? "#dbe6ff"),
            transparent: true,
            depthWrite: false,
            fog: false,
          }),
        );
        sprite.scale.set(8, 8, 1);
        sprite.position.set(node.__w3d.x, node.__w3d.y, node.__w3d.z);
        this.staticGroup.add(sprite);
      }
    }

    // Lanes: raised arcs between galaxy centers (§7), overview only.
    if (!focusGalaxy && state.layers.lanes) {
      const laneCounts = new Map();
      for (const link of visible.visibleLinks) {
        if (link.kind !== "lane") continue;
        const a = model.galaxyOfNode(model.nodesById.get(link.source));
        const b = model.galaxyOfNode(model.nodesById.get(link.target));
        if (!a || !b) continue;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        laneCounts.set(key, (laneCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of laneCounts) {
        const [idA, idB] = key.split("|");
        const a = model.galaxiesById.get(idA);
        const b = model.galaxiesById.get(idB);
        if (!a || !b) continue;
        const from = { x: a.cx, y: -a.cy, z: a.h };
        const to = { x: b.cx, y: -b.cy, z: b.h };
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const points = [];
        for (let i = 0; i <= 24; i++) {
          const u = i / 24;
          const lift = 4 * u * (1 - u) * 0.2 * length;
          points.push(
            new THREE.Vector3(
              from.x + (to.x - from.x) * u,
              from.y + (to.y - from.y) * u,
              from.z + (to.z - from.z) * u + lift,
            ),
          );
        }
        const geometry = new LineGeometry();
        geometry.setFromPoints(points);
        const material = new LineMaterial({
          color: idA === "shared" ? b.hue : a.hue,
          linewidth: clamp(0.7 + 0.22 * count, 0.7, 2),
          transparent: true,
          opacity: 0.38,
          dashed: true,
          dashSize: 5,
          gapSize: 6,
          fog: true,
        });
        material.resolution.set(this.container.clientWidth, this.container.clientHeight);
        this.lineMaterials.push(material);
        const line = new Line2(geometry, material);
        line.computeLineDistances();
        this.staticGroup.add(line);
      }
    }

    // Constellation lines: one LineSegments with vertex colors (§7).
    const constellationLinks = visible.visibleLinks.filter((link) => link.kind === "constellation");
    if (constellationLinks.length > 0) {
      const positions = new Float32Array(constellationLinks.length * 6);
      const colors = new Float32Array(constellationLinks.length * 6);
      const meta = [];
      constellationLinks.forEach((link, i) => {
        const s = model.nodesById.get(link.source);
        const t = model.nodesById.get(link.target);
        if (!s || !t) return;
        positions.set([s.__w3d.x, s.__w3d.y, s.__w3d.z, t.__w3d.x, t.__w3d.y, t.__w3d.z], i * 6);
        meta.push({ link, s, t, index: i });
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: focusGalaxy ? 0.28 : 0.42,
        blending: THREE.AdditiveBlending,
        fog: true,
      });
      const segments = new THREE.LineSegments(geometry, material);
      this.staticGroup.add(segments);
      this.constellation = { segments, meta };
    } else {
      this.constellation = null;
    }

    // Typed lines: fat lines + one flowing particle each (§7).
    for (const link of visible.visibleLinks) {
      if (link.kind !== "typed") continue;
      const s = model.nodesById.get(link.source);
      const t = model.nodesById.get(link.target);
      if (!s || !t) continue;
      const geometry = new LineGeometry();
      geometry.setFromPoints([
        new THREE.Vector3(s.__w3d.x, s.__w3d.y, s.__w3d.z),
        new THREE.Vector3(t.__w3d.x, t.__w3d.y, t.__w3d.z),
      ]);
      const material = new LineMaterial({
        color: 0xf8fafc,
        linewidth: 1.2,
        transparent: true,
        opacity: 0.8,
        fog: true,
      });
      material.resolution.set(this.container.clientWidth, this.container.clientHeight);
      this.lineMaterials.push(material);
      const line = new Line2(geometry, material);
      this.staticGroup.add(line);
      this.typedLines.push({ line, link, s, t });
      if (!this.reduced) {
        const particle = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.sparkleTexture("#ffffff"),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
          }),
        );
        particle.scale.set(4, 4, 1);
        this.staticGroup.add(particle);
        this.particles.push({ sprite: particle, s, t, phase: 0 });
      }
    }

    // Tethers around the hovered or selected planet (§5.4).
    this.rebuildTethers();

    // Bloom (§7): off above 2,000 nodes.
    if (!this.composer) {
      const composer = this.fg.postProcessingComposer();
      if (model.nodes.length <= 2000) {
        const size = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
        composer.addPass(new UnrealBloomPass(size, 1.1, 0.6, 0.2));
        composer.addPass(new OutputPass());
      }
      this.composer = composer;
    }
  }

  eclipticEllipse(radius, opacity) {
    const points = [];
    for (let i = 0; i <= 96; i++) {
      const a = (TAU * i) / 96;
      points.push(new THREE.Vector3(radius * MACRO_STRETCH * Math.cos(a), -radius * Math.sin(a), 0));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color: 0x8fa6d6,
      transparent: true,
      opacity,
      dashSize: 2,
      gapSize: 6,
      fog: false,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    return line;
  }

  diskRing(galaxy, radius, opacity, dashed = true) {
    const group = this.galaxyGroupTransform(galaxy);
    const points = [];
    for (let i = 0; i <= 96; i++) {
      const a = (TAU * i) / 96;
      points.push(new THREE.Vector3(radius * Math.cos(a), radius * Math.sin(a), 0));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color: new THREE.Color(galaxy.hue),
      transparent: true,
      opacity,
      dashSize: 2,
      gapSize: 6,
      fog: true,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    group.add(line);
    return group;
  }

  sparkleTexture(hue) {
    const key = `sparkle:${hue}`;
    if (!this.textures) this.textures = new Map();
    if (this.textures.has(key)) return this.textures.get(key);
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const r = size / 2 - 2;
    ctx.fillStyle = hue;
    ctx.beginPath();
    ctx.moveTo(size / 2, 2);
    ctx.quadraticCurveTo(size / 2 + r * 0.18, size / 2 - r * 0.18, size - 2, size / 2);
    ctx.quadraticCurveTo(size / 2 + r * 0.18, size / 2 + r * 0.18, size / 2, size - 2);
    ctx.quadraticCurveTo(size / 2 - r * 0.18, size / 2 + r * 0.18, 2, size / 2);
    ctx.quadraticCurveTo(size / 2 - r * 0.18, size / 2 - r * 0.18, size / 2, 2);
    ctx.closePath();
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    this.textures.set(key, texture);
    return texture;
  }

  /** Graph data: interactive bodies only (stars, planets, nav). */
  rebuildGraph() {
    const { state, model } = this;
    const nodes = [];
    for (const node of model.nodes) {
      if (!state.visibility.visibleNodes.has(node.id)) continue;
      if (node.kind !== "star" && node.kind !== "planet" && node.kind !== "nav") continue;
      nodes.push(node);
    }
    const links = state.visibility.visibleLinks.filter((link) => {
      const s = model.nodesById.get(link.source);
      const t = model.nodesById.get(link.target);
      return s && t && (s.kind !== "moon" && t.kind !== "moon");
    });
    // The engine rewrites whatever it receives on every tick (x=fx/fy/fz,
    // velocities, index, __threeObj) and points link.source/target at its
    // node objects. Pass copies of BOTH so the shared model keeps the flat
    // chart's layout coordinates and string ids; each node copy carries the
    // fixed world position and a read-only `ref` to the model node.
    const graphNodes = forceGraphNodes(nodes);
    const graphLinks = links.map((link) => ({ ...link }));
    this.fg.graphData({ nodes: graphNodes, links: graphLinks });
    this.nodeObjects.clear();
    // three-forcegraph stores custom objects under __threeObj on the copies.
    for (const clone of graphNodes) {
      const object = clone.__threeObj;
      if (object) this.nodeObjects.set(clone.id, object);
    }
    this.buildPlanetLabels(nodes);
  }

  buildGalaxyLabels() {
    for (const label of this.galaxyLabels.values()) this.labelGroup.remove(label);
    this.galaxyLabels.clear();
    for (const galaxy of this.model.galaxies) {
      const element = document.createElement("div");
      element.className = `kg-label kg-galaxy-label role-${galaxy.role}`;
      element.textContent = galaxy.id === "shared" ? this.t("sharedGalaxy") : galaxy.name;
      if (galaxy.role !== "belt") {
        const caption = document.createElement("div");
        caption.className = "kg-galaxy-caption";
        element.appendChild(caption);
      }
      element.style.pointerEvents = "auto";
      element.addEventListener("click", () => this.onGalaxyClick?.(galaxy.id));
      const label = new CSS2DObject(element);
      const outward = Math.atan2(galaxy.cy, galaxy.cx);
      const dx = Math.cos(outward) * (galaxy.re + 14);
      const dy = Math.sin(outward) * (galaxy.re + 14);
      label.position.set(galaxy.cx + dx, -(galaxy.cy + dy * Math.cos(DISK_TILT)), galaxy.h - dy * Math.sin(DISK_TILT));
      this.galaxyLabels.set(galaxy.id, label);
      this.labelGroup.add(label);
    }
  }

  buildPlanetLabels(nodes) {
    for (const label of this.planetLabels.values()) this.labelGroup.remove(label);
    this.planetLabels.clear();
    for (const node of nodes) {
      if (node.kind !== "planet") continue;
      const element = document.createElement("div");
      element.className = "kg-label kg-planet-label";
      element.style.pointerEvents = "none";
      const label = new CSS2DObject(element);
      label.position.set(node.__w3d.x, node.__w3d.y, node.__w3d.z);
      label.visible = false;
      this.planetLabels.set(node.id, label);
      this.labelGroup.add(label);
    }
  }

  rebuildTethers() {
    for (const entry of this.tetherLines) this.staticGroup.remove(entry.line);
    this.tetherLines = [];
    const anchorId = this.hoveredId ?? this.state?.selectedId;
    if (!anchorId) return;
    const anchor = this.model.nodesById.get(anchorId);
    if (!anchor || anchor.kind !== "planet") return;
    const events = tethersOf(this.model, anchorId);
    if (!events) return;
    for (const event of events) {
      const geometry = new LineGeometry();
      geometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const material = new LineMaterial({
        color: 0xffffff,
        linewidth: 0.8,
        transparent: true,
        opacity: 0.7,
        fog: true,
      });
      material.resolution.set(this.container.clientWidth, this.container.clientHeight);
      this.lineMaterials.push(material);
      const line = new Line2(geometry, material);
      this.staticGroup.add(line);
      this.tetherLines.push({ line, event });
    }
  }

  // ---- hover & selection ----

  handleHover(node) {
    this.hoveredId = node?.id ?? null;
    this.updateHoverHighlight();
    this.onHover?.(node ?? null, this.pointerX ?? 0, this.pointerY ?? 0);
  }

  handleClick(node) {
    if (!node) return;
    if (node.kind === "star") this.onGalaxyClick?.(node.galaxy);
    else this.onSelect?.(node);
  }

  /** §5.6 hover: the node's lines turn white; the rest drops to 40%. */
  updateHoverHighlight() {
    if (!this.constellation) return;
    const { segments, meta } = this.constellation;
    const colors = segments.geometry.getAttribute("color");
    const hueColor = new THREE.Color();
    const focus = Boolean(this.state?.focusGalaxyId);
    for (const entry of meta) {
      const hot = this.hoveredId && (entry.link.source === this.hoveredId || entry.link.target === this.hoveredId);
      if (entry.link.kind === "typed") continue;
      const baseOpacity = hot ? 1 : this.hoveredId ? 0.4 : focus ? 0.62 : 1;
      hueColor.set(this.model.galaxyOfNode(entry.s)?.hue ?? "#dbe6ff");
      if (hot) hueColor.set(0xffffff);
      colors.setXYZ(entry.index * 2, hueColor.r * baseOpacity, hueColor.g * baseOpacity, hueColor.b * baseOpacity);
      colors.setXYZ(entry.index * 2 + 1, hueColor.r * baseOpacity, hueColor.g * baseOpacity, hueColor.b * baseOpacity);
    }
    colors.needsUpdate = true;
    this.rebuildTethers();
  }

  // ---- camera ----

  focusGalaxy(galaxyId) {
    if (galaxyId) {
      const galaxy = this.model.galaxiesById.get(galaxyId);
      if (!galaxy) return;
      this.moveTo({
        target: { x: galaxy.cx, y: -galaxy.cy, z: galaxy.h },
        dist: galaxy.re * 4.2,
        el: ELEVATION.galaxy,
        az: 0,
        ms: FOCUS_MS,
        lateralShift: 0.13,
      });
    } else {
      this.moveTo({
        target: { ...OVERVIEW_TARGET },
        dist: this.overviewDistance(),
        el: ELEVATION.overview,
        az: 0,
        ms: FOCUS_MS,
      });
    }
  }

  playIntro() {
    if (this.introPlayed) return;
    this.introPlayed = true;
    const to = {
      target: { ...OVERVIEW_TARGET },
      dist: this.overviewDistance(),
      el: ELEVATION.overview,
      az: 0,
    };
    if (this.reduced) {
      Object.assign(this.cam, to);
      this.applyCamera();
      return;
    }
    // §7: 1.6 s ease from 1.6 × distance and elevation 0.9.
    Object.assign(this.cam, { ...to, dist: to.dist * 1.6, el: ELEVATION.intro });
    this.moveTo({ ...to, ms: INTRO_MS });
  }

  moveTo({ target, dist, el, az, ms, lateralShift = 0 }) {
    const to = this.applyLateralShift({ target, dist, el, az }, lateralShift);
    if (this.reduced || ms === 0) {
      this.cam = { ...to };
      this.applyCamera();
      return;
    }
    this.camAnim = { from: { ...this.cam }, to, start: performance.now(), ms };
  }

  /** Shift the look-at target sideways so the subject sits at 37% width. */
  applyLateralShift({ target, dist, el, az }, fraction) {
    if (!fraction) return { target: { ...target }, dist, el, az };
    const visibleWidth = 2 * dist * Math.tan((FOV * Math.PI) / 360) * this.aspect();
    // The camera right vector lies in the ecliptic plane.
    const rightX = Math.cos(az);
    const rightY = Math.sin(az);
    const shift = visibleWidth * fraction;
    return {
      target: { x: target.x + rightX * shift, y: target.y + rightY * shift, z: target.z },
      dist,
      el,
      az,
    };
  }

  aspect() {
    return Math.max(0.3, this.container.clientWidth / Math.max(1, this.container.clientHeight));
  }

  applyCamera() {
    const { az, el, dist, target } = this.cam;
    const cosEl = Math.cos(el);
    this.camera.position.set(
      target.x + dist * cosEl * Math.sin(az),
      target.y - dist * cosEl * Math.cos(az),
      target.z + dist * Math.sin(el),
    );
    this.camera.lookAt(target.x, target.y, target.z);
  }

  bindPointer() {
    const element = this.container;
    element.addEventListener("pointerdown", (event) => {
      this.lastInputAt = performance.now();
      if (event.button === 2) this.panning = { x: event.clientX, y: event.clientY };
      else if (event.button === 0) this.orbiting = { x: event.clientX, y: event.clientY };
    });
    element.addEventListener("pointermove", (event) => {
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
      if (this.orbiting) {
        this.lastInputAt = performance.now();
        const dx = event.clientX - this.orbiting.x;
        const dy = event.clientY - this.orbiting.y;
        this.orbiting = { x: event.clientX, y: event.clientY };
        this.camAnim = null;
        this.cam.az -= dx * 0.005;
        this.cam.el = clamp(this.cam.el + dy * 0.005, ELEVATION.min, ELEVATION.max);
        this.applyCamera();
      } else if (this.panning) {
        this.lastInputAt = performance.now();
        const dx = event.clientX - this.panning.x;
        const dy = event.clientY - this.panning.y;
        this.panning = { x: event.clientX, y: event.clientY };
        this.camAnim = null;
        const k = (2 * this.cam.dist * Math.tan((FOV * Math.PI) / 360)) / this.container.clientHeight;
        // Right vector and ground-projected up in world space.
        const rightX = Math.cos(this.cam.az);
        const rightY = Math.sin(this.cam.az);
        this.cam.target.x -= rightX * dx * k;
        this.cam.target.y -= rightY * dx * k;
        this.cam.target.z += dy * k * 0.6;
        this.applyCamera();
      }
    });
    const stop = () => {
      this.orbiting = null;
      this.panning = null;
    };
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointerleave", stop);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    element.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.lastInputAt = performance.now();
        this.camAnim = null;
        this.cam.dist *= event.deltaY < 0 ? 0.9 : 1.1;
        this.applyCamera();
      },
      { passive: false },
    );
    element.addEventListener("dblclick", () => {
      this.lastInputAt = performance.now();
      this.focusGalaxy(this.state?.focusGalaxyId ?? null);
    });
  }

  zoomBy(factor) {
    this.camAnim = null;
    this.cam.dist *= 1 / factor;
    this.applyCamera();
  }

  fitView() {
    this.focusGalaxy(this.state?.focusGalaxyId ?? null);
  }

  /** Search-hit pulse: an expanding ring sprite, twice (§5.6). */
  playSearchPulse(nodeId, reducedMotion) {
    if (reducedMotion) return;
    const node = this.model.nodesById.get(nodeId);
    if (!node) return;
    this.pulse = { node, startedAt: performance.now() };
  }

  // ---- frame loop ----

  animate() {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.clock.last) / 1000);
    this.clock.last = now;
    this.frameCount += 1;
    this.fpsFrames += 1;
    if (!this.model || !this.state) return;

    // Intro ease on first render.
    this.playIntro();

    // Camera animation / idle drift.
    if (this.camAnim) {
      const t = clamp((now - this.camAnim.start) / this.camAnim.ms, 0, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const { from, to } = this.camAnim;
      this.cam.az = from.az + (to.az - from.az) * e;
      this.cam.el = from.el + (to.el - from.el) * e;
      this.cam.dist = from.dist + (to.dist - from.dist) * e;
      for (const key of ["x", "y", "z"]) {
        this.cam.target[key] = from.target[key] + (to.target[key] - from.target[key]) * e;
      }
      this.applyCamera();
      if (t >= 1) this.camAnim = null;
    } else if (!this.reduced && now - this.lastInputAt > IDLE_DRIFT_DELAY_MS) {
      this.cam.az += IDLE_DRIFT_RAD_S * dt;
      this.applyCamera();
    }

    if (this.reduced) {
      this.updateDynamic(0);
    } else {
      this.clock.rotation += RING_ROTATION_RAD_S * dt;
      this.updateDynamic(dt);
    }

    // Galaxy-label visibility + captions follow the focus.
    const focusId = this.state.focusGalaxyId;
    for (const [id, label] of this.galaxyLabels) {
      label.visible = focusId ? id === focusId : true;
      const galaxy = this.model.galaxiesById.get(id);
      const caption = label.element.querySelector(".kg-galaxy-caption");
      if (caption && galaxy && galaxy.role !== "belt") {
        caption.textContent = this.t("galaxyCaption", { planets: galaxy.planets, events: galaxy.events });
      }
    }

    // Label collision at 10 Hz (§7).
    this.labelClock += dt;
    if (this.labelClock > 1 / LABEL_HZ) {
      this.labelClock = 0;
      this.updatePlanetLabels();
    }

    // Search-hit pulse ring.
    if (this.pulse) {
      const elapsed = now - this.pulse.startedAt;
      if (elapsed > 900 || this.reduced) {
        if (this.pulse.sprite) {
          this.staticGroup.remove(this.pulse.sprite);
          this.pulse.sprite = null;
        }
        this.pulse = null;
      } else if (this.pulse.node) {
        if (!this.pulse.sprite) {
          const ringCanvas = document.createElement("canvas");
          ringCanvas.width = 64;
          ringCanvas.height = 64;
          const ctx = ringCanvas.getContext("2d");
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(32, 32, 26, 0, TAU);
          ctx.stroke();
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: new THREE.CanvasTexture(ringCanvas),
              transparent: true,
              depthWrite: false,
              fog: false,
            }),
          );
          sprite.position.set(this.pulse.node.__w3d.x, this.pulse.node.__w3d.y, this.pulse.node.__w3d.z);
          this.staticGroup.add(sprite);
          this.pulse.sprite = sprite;
        }
        const phase = (elapsed % 450) / 450;
        const scale = 8 + phase * 26;
        this.pulse.sprite.scale.set(scale, scale, 1);
        this.pulse.sprite.material.opacity = 1 - phase;
      }
    }
  }

  /** Ring rotation, star breathing, typed particles, tether endpoints. */
  updateDynamic(dt) {
    // §7 reduced motion: a fully static universe — no rotation, no breathing,
    // no particles; only tether endpoints stay glued to their events.
    if (this.reduced) {
      this.updateTetherEndpoints();
      return;
    }
    for (const holder of this.ringHolders.values()) {
      holder.userData.spinner.rotation.z += RING_ROTATION_RAD_S * dt;
    }
    const breathe = 1 + 0.06 * Math.sin((performance.now() / 1000 / BREATH_PERIOD_S) * TAU);
    for (const corona of this.coronas) {
      corona.sprite.scale.set(corona.base * breathe, corona.base * breathe, 1);
    }
    for (const particle of this.particles) {
      particle.phase = (particle.phase + TYPED_PARTICLE_SPEED * dt) % 1;
      const { s, t, sprite } = particle;
      sprite.position.set(
        s.__w3d.x + (t.__w3d.x - s.__w3d.x) * particle.phase,
        s.__w3d.y + (t.__w3d.y - s.__w3d.y) * particle.phase,
        s.__w3d.z + (t.__w3d.z - s.__w3d.z) * particle.phase,
      );
    }
    this.updateTetherEndpoints();
  }

  updateTetherEndpoints() {
    if (this.tetherLines.length === 0) return;
    const anchorId = this.hoveredId ?? this.state.selectedId;
    const anchor = anchorId ? this.model.nodesById.get(anchorId) : null;
    if (!anchor) return;
    const a = anchor.__w3d;
    for (const { line, event } of this.tetherLines) {
      const w = this.eventWorldPosition(event);
      line.geometry.setFromPoints([
        new THREE.Vector3(a.x, a.y, a.z),
        new THREE.Vector3(w.x, w.y, w.z),
      ]);
    }
  }

  /** World position of an event, honoring its ring's current rotation. */
  eventWorldPosition(event) {
    const galaxy = this.model.galaxyOfNode(event);
    const holder = this.ringHolders.get(galaxy.id);
    const rot = holder ? holder.userData.spinner.rotation.z : 0;
    const dx = event.x - galaxy.cx;
    const dy = event.y - galaxy.cy;
    const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
    return {
      x: galaxy.cx + rx,
      y: -(galaxy.cy + ry * Math.cos(DISK_TILT)),
      z: galaxy.h - ry * Math.sin(DISK_TILT),
    };
  }

  /** Hidden measuring span: real text width for collision boxes (§5.5). */
  measuredTextWidth(text, font) {
    if (!this.measureEl) {
      this.measureEl = document.createElement("span");
      this.measureEl.className = "kg-label kg-measure";
      this.measureEl.style.visibility = "hidden";
      this.measureEl.style.whiteSpace = "nowrap";
      this.container.appendChild(this.measureEl);
      this.measureCache = new Map();
    }
    const key = `${font}|${text}`;
    let width = this.measureCache.get(key);
    if (width === undefined) {
      this.measureEl.style.font = font;
      this.measureEl.textContent = text;
      width = this.measureEl.offsetWidth || text.length * 10.5;
      this.measureCache.set(key, width);
    }
    return width;
  }

  /** Galaxy label fonts, matched to the CSS (narrow panels shrink both). */
  galaxyLabelFonts() {
    // The CSS media query keys on the viewport, not the stage width.
    const narrow = window.innerWidth <= 660;
    return {
      nameFont: narrow
        ? '600 13px "Songti SC", "Noto Serif SC", serif'
        : '600 17px "Songti SC", "Noto Serif SC", serif',
      nameSpacing: narrow ? "0.06em" : "0.14em",
      captionFont: narrow ? "10px sans-serif" : "11px sans-serif",
      captionSpacing: "0.02em",
    };
  }

  measuredSpaced(font, spacing, text) {
    if (!this.measureEl) {
      this.measureEl = document.createElement("span");
      this.measureEl.className = "kg-label kg-measure";
      this.measureEl.style.visibility = "hidden";
      this.measureEl.style.whiteSpace = "nowrap";
      this.container.appendChild(this.measureEl);
      this.measureCache = new Map();
    }
    const key = `${font}|${spacing}|${text}`;
    let width = this.measureCache.get(key);
    if (width === undefined) {
      this.measureEl.style.font = font;
      this.measureEl.style.letterSpacing = spacing;
      this.measureEl.textContent = text;
      width = this.measureEl.offsetWidth || text.length * 10.5;
      this.measureCache.set(key, width);
    }
    return width;
  }

  projectToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z);
    v.project(this.camera);
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    return {
      x: (v.x * 0.5 + 0.5) * width,
      y: (-v.y * 0.5 + 0.5) * height,
      behind: v.z >= 1,
    };
  }

  /** §5.5 label budget in screen space: ≤12 overview, ≤18 galaxy. */
  updatePlanetLabels() {
    if (!this.state) return;
    const focusId = this.state.focusGalaxyId;
    const budget = focusId ? 18 : 12;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const boxes = [];
    const overlaps = (box) => boxes.some((b) => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1));

    // Galaxy names and captions claim their boxes first (§5.5), so planet
    // names cannot cover them. Names are always shown; when the default spot
    // collides with an earlier box, try one slot above, then below, and keep
    // the default as the last resort.
    for (const [id, label] of this.galaxyLabels) {
      const galaxy = this.model.galaxiesById.get(id);
      if (!galaxy) continue;
      const p = this.projectToScreen(label.position.x, label.position.y, label.position.z);
      const onStage = focusId ? id === focusId : true;
      const major = galaxy.role !== "belt";
      const fonts = this.galaxyLabelFonts();
      const textWidth = this.measuredSpaced(
        major ? fonts.nameFont : "11px sans-serif",
        major ? fonts.nameSpacing : "0.03em",
        galaxy.id === "shared" ? this.t("sharedGalaxy") : galaxy.name,
      );
      void 0;
      let totalHeight = major ? 22 : 15;
      let captionWidth = 0;
      if (major) {
        captionWidth = this.measuredSpaced(
          fonts.captionFont,
          fonts.captionSpacing,
          this.t("galaxyCaption", { planets: galaxy.planets, events: galaxy.events }),
        );
        totalHeight += major ? (window.innerWidth <= 660 ? 16 : 18) : 0;
      }
      const halfW = Math.max(textWidth, captionWidth) / 2 + 4;
      const shown = onStage && !p.behind && p.x > -halfW && p.x < width + halfW && p.y > 0 && p.y < height;
      label.visible = shown;
      if (!shown) {
        label.element.style.translate = "";
        continue;
      }
      const step = totalHeight + 6;
      const boxAt = (offsetX, offsetY) => ({
        x0: p.x - halfW + offsetX,
        x1: p.x + halfW + offsetX,
        y0: p.y - totalHeight / 2 - 2 + offsetY,
        y1: p.y + totalHeight / 2 + 2 + offsetY,
      });
      let chosen = boxAt(0, 0);
      let chosenOffset = [0, 0];
      if (overlaps(chosen)) {
        // Two slots above/below, then two gentle sideways slots.
        const candidates = [
          [0, -step], [0, step], [0, -2 * step], [0, 2 * step],
          [-halfW * 1.2, -step], [halfW * 1.2, -step],
          [-halfW * 1.2, step], [halfW * 1.2, step],
          [-halfW * 2.6, 0], [halfW * 2.6, 0],
          [-halfW * 2.6, -step], [halfW * 2.6, -step],
          [-halfW * 2.6, step], [halfW * 2.6, step],
        ];
        for (const [dx, dy] of candidates) {
          const candidate = boxAt(dx, dy);
          if (overlaps(candidate)) continue;
          chosen = candidate;
          chosenOffset = [dx, dy];
          break;
        }
        label.element.style.translate = `${Math.round(chosenOffset[0])}px ${Math.round(chosenOffset[1])}px`;
      } else {
        label.element.style.translate = "";
      }
      boxes.push(chosen);
    }

    // §5.5: in the overview planet names appear only at 1.6× the fit zoom or
    // more — in 3D that is a camera-distance test (fit distance / current).
    const zoomedEnough =
      focusId || this.overviewDistance() / Math.max(1, this.cam.dist) >= 1.6;
    const projected = [];
    for (const [id, label] of this.planetLabels) {
      const node = this.model.nodesById.get(id);
      if (!node) continue;
      const p = this.projectToScreen(node.__w3d.x, node.__w3d.y, node.__w3d.z);
      const visible =
        zoomedEnough && !p.behind && p.x > 0 && p.x < width && p.y > 0 && p.y < height;
      projected.push({ id, label, x: p.x, y: p.y, visible, degree: node.degree ?? 0 });
      if (!visible) {
        label.visible = false;
        label.element.style.translate = "";
      }
    }

    // Greedy collision boxes, hovered first (§5.5).
    let shown = 0;
    let overlapCount = 0;
    const ordered = projected
      .filter((p) => p.visible)
      .sort((a, b) => (a.id === this.hoveredId ? -1 : b.id === this.hoveredId ? 1 : b.degree - a.degree || (a.id < b.id ? -1 : 1)));
    for (const candidate of ordered) {
      const modelNode = this.model.nodesById.get(candidate.id);
      const name = nodeDisplayName(this.model, modelNode, this.t);
      const textWidth = this.measuredTextWidth(name, "10.5px sans-serif");
      // CSS2DRenderer centers the element on its anchor, so the box is
      // symmetric around (x, y): DOM = [x − w/2, x + w/2] × [y − h/2, y + h/2].
      const halfW = textWidth / 2 + 5;
      const halfH = 9;
      let x = candidate.x + halfW + 8;
      const boxAt = (cx) => ({ x0: cx - halfW, x1: cx + halfW, y0: candidate.y - halfH, y1: candidate.y + halfH });
      let box = boxAt(x);
      // Keep the box on the canvas (§ defect-3: no edge clipping): prefer the
      // left side of the node, then slide whole; the box never shrinks.
      if (box.x1 > width - 4) {
        x = candidate.x - halfW - 8;
        box = boxAt(x);
      }
      const slide = Math.max(0, box.x1 - (width - 4)) - Math.min(0, box.x0 - 4);
      if (slide !== 0) {
        box.x0 += slide;
        box.x1 += slide;
        x += slide;
      }
      const fits = candidate.id === this.hoveredId || !overlaps(box);
      if (!fits) overlapCount += 1;
      if (shown < budget && fits) {
        boxes.push(box);
        candidate.label.element.textContent = name;
        // CSS `translate` composes with the transform CSS2DRenderer writes.
        candidate.label.element.style.translate = `${Math.round(x - candidate.x)}px 0`;
        candidate.label.visible = true;
        shown++;
      } else {
        candidate.label.visible = false;
      }
    }
    this.labelOverlapCount = overlapCount;
  }
}
