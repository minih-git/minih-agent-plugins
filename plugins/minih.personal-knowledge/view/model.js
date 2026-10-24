/**
 * View model over a laid-out graph payload (design doc §3–§6).
 *
 * Both renderers (flat chart and 3D) read this one model, so visibility,
 * label names, neighbor sets, and tether caps behave identically in both.
 */

import { MACRO_STRETCH, SHARED_GALAXY_ID, nodeWorld3D } from "./vendor/layout.mjs";
import { nodeSeverity } from "./strings.js";

/** Planet-label prefixes dropped from display names (§5.5). */
const REFERENCE_TITLE_PREFIX = "资料 - ";

export function buildModel(payload) {
  const nodesById = new Map(payload.nodes.map((node) => [node.id, node]));
  const galaxiesById = new Map(payload.galaxies.map((galaxy) => [galaxy.id, galaxy]));
  const galaxyOfNode = (node) => galaxiesById.get(node.galaxy) ?? null;

  // One drawable line per unordered pair and predicate (§3.4).
  const groups = new Map();
  for (const link of payload.links) {
    const forward = link.source < link.target;
    const key = `${link.kind}:${link.predicate}:${forward ? `${link.source}|${link.target}` : `${link.target}|${link.source}`}`;
    const group = groups.get(key);
    if (!group) groups.set(key, [link]);
    else group.push(link);
  }
  const links = [...groups.values()].map((group) =>
    // Keep the canonical direction when both directions exist.
    group.length > 1
      ? group.find((link) => link.source < link.target) ?? group[0]
      : group[0],
  );

  const linksByNode = new Map();
  for (const link of links) {
    for (const id of [link.source, link.target]) {
      if (!linksByNode.has(id)) linksByNode.set(id, []);
      linksByNode.get(id).push(link);
    }
  }

  // Tether candidates: an event linked to a planet (either direction),
  // per planet, capped by the view at draw time (§5.4).
  const tethersByPlanet = new Map();
  for (const link of links) {
    if (link.kind !== "tether") continue;
    const source = nodesById.get(link.source);
    const target = nodesById.get(link.target);
    if (!source || !target) continue;
    const [planet, event] = source.kind === "moon" ? [target, source] : [source, target];
    if (!tethersByPlanet.has(planet.id)) tethersByPlanet.set(planet.id, []);
    tethersByPlanet.get(planet.id).push(event);
  }

  // Precompute 3D world positions once (§4 disk tilt).
  for (const node of payload.nodes) {
    const galaxy = galaxyOfNode(node);
    node.__w3d = galaxy ? nodeWorld3D(node, galaxy) : { x: node.x, y: -node.y, z: node.z ?? 0 };
  }

  return {
    payload,
    nodes: payload.nodes,
    nodesById,
    galaxies: payload.galaxies,
    galaxiesById,
    links,
    linksByNode,
    tethersByPlanet,
    frame: payload.frame ?? 600,
    galaxyOfNode,
  };
}

/** Display name of a galaxy: stripped project title; localized for shared. */
export function galaxyDisplayName(model, galaxyId, t) {
  if (galaxyId === SHARED_GALAXY_ID) return t("sharedGalaxy");
  return model.galaxiesById.get(galaxyId)?.name || galaxyId;
}

/** Display name of a node: planet titles drop their galaxy/资料 prefixes. */
export function nodeDisplayName(model, node, t) {
  let title = node.title ?? node.id;
  const galaxy = model.galaxyOfNode(node);
  if (galaxy?.name) {
    const prefix = `${galaxy.name} - `;
    if (title.startsWith(prefix)) title = title.slice(prefix.length);
  }
  if (title.startsWith(REFERENCE_TITLE_PREFIX)) title = title.slice(REFERENCE_TITLE_PREFIX.length);
  return title;
}

/** §5.3 magnitude class and planet radius at fit zoom. */
export function magnitudeOf(node) {
  return Math.min(4, Math.floor(Math.log2(1 + (node.degree ?? 0)) / 1.4));
}

export const PLANET_RADII = [1.4, 1.9, 2.5, 3.2, 4.0];

export function planetRadius(node, { galaxyView = false } = {}) {
  const base = PLANET_RADII[magnitudeOf(node)];
  return galaxyView ? base * 1.6 : base;
}

export function starRadius(node, galaxy) {
  return Math.min(8, 3.5 + 0.8 * Math.sqrt(1 + galaxy.planets));
}

/**
 * Visible nodes and links under the current layer toggles, class/stability
 * filters, and time-lapse cutoff (§8, §11).
 */
export function computeVisibility(model, state) {
  const { layers, filters, timelapseCutoff } = state;
  const visibleNodes = new Set();
  for (const node of model.nodes) {
    if (!layers.nav && node.kind === "nav") continue;
    if (!layers.memory && node.kind === "satellite") continue;
    if (!layers.archived && node.archived) continue;
    if (filters.class !== "all" && node.cls !== filters.class && !(filters.class === "unknown" && node.cls === "unknown")) continue;
    if (filters.stability !== "all" && (node.stability ?? "none") !== filters.stability) continue;
    if (timelapseCutoff && node.created && node.created > timelapseCutoff) continue;
    visibleNodes.add(node.id);
  }
  const visibleLinks = model.links.filter((link) => {
    if (!visibleNodes.has(link.source) || !visibleNodes.has(link.target)) return false;
    switch (link.kind) {
      case "constellation":
        return layers.constellation;
      case "lane":
        return layers.lanes;
      case "typed":
        return true;
      case "hub":
      case "parent":
      case "moon":
      case "satellite":
      case "ghost":
        return false; // §3.4 defaults: hidden outside their specific contexts
      case "tether":
        return false; // drawn only around a hovered or selected planet
      default:
        return false;
    }
  });
  return { visibleNodes, visibleLinks };
}

/** Constellation + typed neighbors for the drawer's 关联 group (§6.5). */
export function linkedNeighbors(model, nodeId) {
  const result = [];
  const seen = new Set();
  for (const link of model.linksByNode.get(nodeId) ?? []) {
    if (link.kind !== "constellation" && link.kind !== "typed") continue;
    const otherId = link.source === nodeId ? link.target : link.source;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    result.push({ node: model.nodesById.get(otherId), kind: link.kind, predicate: link.predicate });
  }
  return result;
}

/** Tethered events of a planet, capped per §5.4 (null when above the cap). */
export const TETHER_CAP = 12;

export function tethersOf(model, nodeId) {
  const events = model.tethersByPlanet.get(nodeId) ?? [];
  return events.length <= TETHER_CAP ? events : null;
}

export { MACRO_STRETCH, nodeSeverity };
