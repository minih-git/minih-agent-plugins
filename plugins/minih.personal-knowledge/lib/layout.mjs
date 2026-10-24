/**
 * Knowledge Universe v2: classification and deterministic layout
 * (design doc `docs/design/knowledge-universe-v2.md` §3–§5).
 *
 * Pure module: no randomness, no I/O, and every ordering sorts on node
 * properties with an id tie-break, so the same notes produce the same
 * positions for any input order. `lib/graph.mjs` applies it to the payload
 * and the view reuses the same module, which keeps the 3D view, the flat
 * chart, and the tests on one set of numbers.
 *
 * Idempotent: running it again on a payload that gained memory satellites
 * (P4) re-derives everything and only adds the new positions.
 */

const TAU = Math.PI * 2;

/** §4 macro stretch: screens are wider than tall; galaxies stay circular. */
export const MACRO_STRETCH = 1.4;

/** §4 galaxy disk tilt in radians, far side up. */
export const DISK_TILT = 0.38;

/** Id of the galaxy that holds every note without a project (§3.1 rule 4). */
export const SHARED_GALAXY_ID = "shared";

/** §5.2 palette: the four largest major galaxies, then the cycle. */
export const MAJOR_HUES = ["#f2c27b", "#7fd3e0", "#b9a7f5", "#8fe3b0"];
export const MAJOR_HUE_CYCLE = ["#f0a3b5", "#a3c8f0", "#d9e38f"];
export const SHARED_HUE = "#dbe6ff";
export const BELT_HUE = "#e8e2d0";

export const DEFAULT_PROJECT_TITLE_PREFIXES = ["项目 - "];
export const DEFAULT_NAVIGATION_NAME_PATTERNS = ["(总览|索引)$", "^Home$"];

/** Strip one of the configured project title prefixes ("项目 - X" → "X"). */
export function stripProjectTitle(title, prefixes = DEFAULT_PROJECT_TITLE_PREFIXES) {
  let result = String(title ?? "");
  for (const prefix of prefixes) {
    if (prefix && result.startsWith(prefix)) {
      result = result.slice(prefix.length);
      break;
    }
  }
  return result;
}

function byIdKey(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byDegreeDesc(a, b) {
  return (b.degree ?? 0) - (a.degree ?? 0) || byIdKey(a, b);
}

function byCreatedThenId(a, b) {
  return String(a.created ?? "").localeCompare(String(b.created ?? "")) || byIdKey(a, b);
}

function fileNameOf(node) {
  const base = String(node.id ?? "").split("/").pop();
  return base.replace(/\.md$/i, "");
}

/**
 * §3.2 kind rules. The first that applies wins:
 * project → star, event family → moon, navigation family or an untyped note
 * whose file name matches `navigationNamePatterns` → nav, else planet.
 * Memory satellites (P4, family "memory") keep kind "satellite" so they can
 * sit just outside the event ring (§13).
 */
export function kindOf(node, { navigationNamePatterns = [] } = {}) {
  if (node.family === "memory" || node.cls === "memory") return "satellite";
  if (node.cls === "project") return "star";
  if (node.family === "event") return "moon";
  if (node.family === "navigation") return "nav";
  if (node.cls === "unknown") {
    const name = fileNameOf(node);
    if (navigationNamePatterns.some((pattern) => pattern.test(name))) return "nav";
  }
  return "planet";
}

/**
 * §3.1 galaxy rules, first that applies wins: a project note is its own
 * galaxy; `project` pointing at a project note wins next; a note under
 * `01 Projects/<Name>/` belongs to the project titled "<prefix><Name>";
 * anything else is `shared`.
 */
export function galaxyOf(node, { nodesById, projectsByFolderName }) {
  if (node.cls === "project") return node.id;
  if (node.project && nodesById.get(node.project)?.cls === "project") return node.project;
  const match = /^01 Projects\/([^/]+)\//.exec(String(node.id ?? ""));
  if (match && projectsByFolderName.has(match[1])) return projectsByFolderName.get(match[1]);
  return SHARED_GALAXY_ID;
}

/** §4 galaxy radius. */
export function galaxyRadius(planets) {
  return 30 + 20 * Math.sqrt(Math.max(1, planets));
}

/** §4 3D galaxy height: 0 for shared, 46·sin(2θ+1) major, 18·sin(2θ+1) belt. */
export function galaxyHeight(galaxy) {
  if (galaxy.role === "shared") return 0;
  const amplitude = galaxy.role === "belt" ? 18 : 46;
  return amplitude * Math.sin(2 * Math.atan2(galaxy.cy, galaxy.cx) + 1);
}

/** World-space center of a galaxy in 3D (world Y = −y, §4). */
export function galaxyWorld3D(galaxy) {
  return { x: galaxy.cx, y: -galaxy.cy, z: galaxyHeight(galaxy) };
}

/**
 * §4 disk tilt: a note at offset (dx, dy) from its galaxy center sits at
 * X = cx + dx, Y = −(cy + dy·cos TILT), Z = h − dy·sin TILT. `node.z` already
 * stores the Z component; this returns the full 3D point.
 */
export function nodeWorld3D(node, galaxy) {
  const dx = node.x - galaxy.cx;
  const dy = node.y - galaxy.cy;
  return {
    x: galaxy.cx + dx,
    y: -(galaxy.cy + dy * Math.cos(DISK_TILT)),
    z: galaxyHeight(galaxy) - dy * Math.sin(DISK_TILT),
  };
}

/**
 * §3.4 link kinds. Each unordered pair is one line per predicate; the rules
 * apply in the order ghost, hub, typed, parent, lane, tether, moon,
 * constellation (calibrated on the real vault: 104 constellation, 19 lanes,
 * 4 typed visible in the overview). Memory links are a satellite's own kind
 * and stay hidden; the view draws them never (satellites sit by their
 * galaxy, §13).
 */
export function linkKind(link, nodesById) {
  const source = nodesById.get(link.source);
  const target = nodesById.get(link.target);
  if (!source || !target) return "ghost";
  if (link.predicate === "memory") return "satellite";
  if (source.kind === "nav" || target.kind === "nav") return "hub";
  if (link.predicate !== "wikilink" && link.predicate !== "project") return "typed";
  if (link.predicate === "project") return "parent";
  if (source.galaxy !== target.galaxy) {
    return source.kind === "moon" || target.kind === "moon" ? "tether" : "lane";
  }
  if (source.kind === "star" || target.kind === "star") return "parent";
  if (source.kind === "planet" && target.kind === "planet") return "constellation";
  if (source.kind === "moon" && target.kind === "moon") return "moon";
  return "tether";
}

/**
 * One drawable line per unordered note pair and predicate, keeping the
 * canonical direction (lexicographically smaller endpoint pair) so the
 * result does not depend on input order.
 */
export function drawableLinks(links) {
  const groups = new Map();
  for (const link of links) {
    const key = `${link.kind}:${link.predicate}:${
      link.source < link.target ? `${link.source}|${link.target}` : `${link.target}|${link.source}`
    }`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, [link]);
    } else {
      group.push(link);
      // Prefer the canonical direction; keep the first otherwise.
      if (link.source < link.target && group[0].source > group[0].target) {
        group.push(group.shift());
      }
    }
  }
  return [...groups.values()].map((group) => group[0]);
}

function placeRing(items, centerX, centerY, radius, startAngle, { minGap = 0, out } = {}) {
  const count = items.length;
  if (!count) return;
  // §4: when the arc between slots falls below `minGap`, alternate slots
  // between 0.88 r and 1.12 r.
  const split = count > 1 && minGap > 0 && (TAU * radius) / count < minGap;
  items.forEach((item, index) => {
    const angle = startAngle + (TAU * index) / count;
    const r = split ? radius * (index % 2 ? 1.12 : 0.88) : radius;
    out.set(item.id, { x: centerX + r * Math.cos(angle), y: centerY + r * Math.sin(angle) });
  });
}

function placeGalaxyMembers(galaxy, centerX, centerY, angle, positions) {
  const R = galaxyRadius(galaxy.planets.length);
  galaxy.cx = centerX;
  galaxy.cy = centerY;
  galaxy.R = R;
  galaxy.angle = angle;
  galaxy.re = R + 12;
  positions.set(galaxy.star?.id ?? SHARED_GALAXY_ID, { x: centerX, y: centerY });
  const ranked = [...galaxy.planets].sort(byDegreeDesc);
  const innerCount = Math.ceil(ranked.length / 3);
  ranked.forEach((planet, index) => {
    planet.ring = index < innerCount ? "inner" : "outer";
  });
  // §4 ring starts: inner faces the center, outer trails by 0.3 rad.
  placeRing(ranked.slice(0, innerCount), centerX, centerY, R * 0.48, angle + Math.PI, { minGap: 11, out: positions });
  placeRing(ranked.slice(innerCount), centerX, centerY, R * 0.86, angle + Math.PI + 0.3, { minGap: 11, out: positions });
  // Events run clockwise from 12 o'clock by created date.
  const events = [...galaxy.moons].sort(byCreatedThenId);
  placeRing(events, centerX, centerY, galaxy.re, -Math.PI / 2, { out: positions });
  // Navigation pages hover near the core; hidden by default (§8 layers).
  placeRing([...galaxy.nav].sort(byIdKey), centerX, centerY, R * 0.25, 0, { out: positions });
  // Memory satellites sit just outside the event ring (§13).
  placeRing([...galaxy.satellites].sort(byCreatedThenId), centerX, centerY, galaxy.re + 10, -Math.PI / 2, { out: positions });
}

/**
 * Classify the payload and lay it out, mutating and returning it. Nodes gain
 * `galaxy`, `kind`, `ring` (planets), `x`, `y`, `z`; links gain `kind`; the
 * payload gains `galaxies[]` and `frame`, plus `layoutApplied` so a consumer
 * can tell the work is done.
 */
export function applyUniverseLayout(payload, options = {}) {
  const prefixes = options.projectTitlePrefixes ?? DEFAULT_PROJECT_TITLE_PREFIXES;
  const rawPatterns = options.navigationNamePatterns ?? DEFAULT_NAVIGATION_NAME_PATTERNS;
  const navigationNamePatterns = rawPatterns
    .map((pattern) => (pattern instanceof RegExp ? pattern : safeRegExp(pattern)))
    .filter(Boolean);

  const nodes = payload.nodes ?? [];
  const links = payload.links ?? [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  // Folder rule: map "01 Projects/<Name>/" to the project note titled
  // "<prefix><Name>"; ties resolve to the smallest id for determinism.
  const projectsByFolderName = new Map();
  for (const node of nodes) {
    if (node.cls !== "project") continue;
    const folderName = stripProjectTitle(node.title, prefixes);
    const existing = projectsByFolderName.get(folderName);
    if (!existing || node.id < existing) projectsByFolderName.set(folderName, node.id);
  }

  // Classification.
  const galaxies = new Map();
  const galaxyOfId = (id) => {
    let galaxy = galaxies.get(id);
    if (!galaxy) {
      galaxy = { id, star: null, planets: [], moons: [], nav: [], satellites: [] };
      galaxies.set(id, galaxy);
    }
    return galaxy;
  };
  for (const node of nodes) {
    node.kind = kindOf(node, { navigationNamePatterns });
    node.galaxy = galaxyOf(node, { nodesById, projectsByFolderName });
    const galaxy = galaxyOfId(node.galaxy);
    if (node.kind === "star") galaxy.star = node;
    else if (node.kind === "planet") galaxy.planets.push(node);
    else if (node.kind === "moon") galaxy.moons.push(node);
    else if (node.kind === "satellite") galaxy.satellites.push(node);
    else galaxy.nav.push(node);
  }

  // Macro layout: shared at the origin, major galaxies by angular share, the
  // single-project belt on an outer ring (§4).
  const positions = new Map();
  const shared = galaxyOfId(SHARED_GALAXY_ID);
  shared.role = "shared";
  placeGalaxyMembers(shared, 0, 0, 0, positions);

  const majors = [...galaxies.values()]
    .filter((galaxy) => galaxy.id !== SHARED_GALAXY_ID && galaxy.planets.length > 0)
    .sort((a, b) => b.planets.length + b.moons.length - (a.planets.length + a.moons.length) || byIdKey(a.star ?? a, b.star ?? b));
  const belt = [...galaxies.values()]
    .filter((galaxy) => galaxy.id !== SHARED_GALAXY_ID && galaxy.planets.length === 0)
    .sort((a, b) => {
      const nameA = stripProjectTitle(a.star?.title ?? a.id, prefixes);
      const nameB = stripProjectTitle(b.star?.title ?? b.id, prefixes);
      return nameA < nameB ? -1 : nameA > nameB ? 1 : byIdKey(a.star ?? a, b.star ?? b);
    });

  majors.forEach((galaxy, index) => {
    galaxy.role = "major";
    galaxy.hue = index < MAJOR_HUES.length ? MAJOR_HUES[index] : MAJOR_HUE_CYCLE[(index - MAJOR_HUES.length) % MAJOR_HUE_CYCLE.length];
  });
  for (const galaxy of belt) {
    galaxy.role = "belt";
    galaxy.hue = BELT_HUE;
  }
  shared.hue = SHARED_HUE;

  const weightOf = (galaxy) => galaxyRadius(galaxy.planets.length) + 26;
  const totalWeight = majors.reduce((sum, galaxy) => sum + weightOf(galaxy), 0);
  let accumulated = 0;
  let reachOfOtherMajors = 0;
  let largestSector = null;
  majors.forEach((galaxy, index) => {
    const share = (TAU * weightOf(galaxy)) / totalWeight;
    const angle = accumulated + share / 2;
    accumulated += share;
    const R = galaxyRadius(galaxy.planets.length);
    const distance = Math.max(shared.re + 110 + R, (R + 26) / Math.sin(Math.min(share / 2, Math.PI / 2)));
    placeGalaxyMembers(galaxy, MACRO_STRETCH * distance * Math.cos(angle), distance * Math.sin(angle), angle, positions);
    if (index === 0) largestSector = { angle, halfWidth: Math.atan2(R + 60, distance) + 0.12 };
    else reachOfOtherMajors = Math.max(reachOfOtherMajors, distance + R + 12);
  });

  // The belt spreads over the full circle minus the largest galaxy's sector.
  const beltRadius = Math.max(reachOfOtherMajors + 95, shared.re + 12 + 260);
  if (belt.length > 0 && largestSector) {
    const span = TAU - 2 * largestSector.halfWidth;
    belt.forEach((galaxy, index) => {
      const angle = largestSector.angle + largestSector.halfWidth + (span * (index + 0.5)) / belt.length;
      placeGalaxyMembers(galaxy, MACRO_STRETCH * beltRadius * Math.cos(angle), beltRadius * Math.sin(angle), angle, positions);
    });
  }

  // Frame radius: the largest node distance measured unstretched, plus margin.
  let frame = 0;
  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    node.x = position.x;
    node.y = position.y;
    frame = Math.max(frame, Math.hypot(position.x / MACRO_STRETCH, position.y));
  }
  frame += 70;

  // 3D heights (§4): galaxy planes tilt by DISK_TILT, far side up.
  for (const galaxy of galaxies.values()) {
    galaxy.h = galaxyHeight(galaxy);
  }
  for (const node of nodes) {
    const galaxy = galaxies.get(node.galaxy);
    if (!galaxy) continue;
    const dy = node.y - galaxy.cy;
    node.z = galaxyHeight(galaxy) - dy * Math.sin(DISK_TILT);
  }

  // §3.4 link kinds.
  for (const link of links) {
    link.kind = linkKind(link, nodesById);
  }

  payload.galaxies = [...galaxies.values()].map((galaxy) => ({
    id: galaxy.id,
    name: galaxy.star ? stripProjectTitle(galaxy.star.title, prefixes) : "",
    hue: galaxy.hue,
    role: galaxy.role,
    planets: galaxy.planets.length,
    events: galaxy.moons.length,
    satellites: galaxy.satellites.length,
    nav: galaxy.nav.length,
    cx: galaxy.cx,
    cy: galaxy.cy,
    R: galaxy.R,
    re: galaxy.re,
    angle: galaxy.angle,
    h: galaxy.h,
  }));
  payload.frame = frame;
  payload.layoutApplied = true;
  return payload;
}

function safeRegExp(source) {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}
