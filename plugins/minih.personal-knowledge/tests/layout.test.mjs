import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VaultIndex } from "../lib/vault-index.mjs";
import { loadOntology } from "../lib/ontology.mjs";
import { buildGraphPayload } from "../lib/graph.mjs";
import {
  applyUniverseLayout,
  drawableLinks,
  galaxyOf,
  kindOf,
} from "../lib/layout.mjs";
import { initialViewMode, MODE_3D, MODE_CHART } from "../view/view-mode.js";
import { isolatedHome } from "./helpers/home.mjs";
// Keep every fixture away from the real ~/.personal-knowledge (see helpers/home.mjs).
await isolatedHome();

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = () => new Date("2026-07-17T00:00:00Z");

/**
 * A synthetic vault that exercises every classification rule: project stars,
 * project-linked planets, the `01 Projects/<Name>/` folder rule, untyped
 * navigation names, events (including the `deployment` alias), cross-galaxy
 * lanes, constellation lines, tethers, hub links, a typed predicate, and a
 * ghost.
 */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-layout-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "01 Projects", "Solo"), { recursive: true });
  const write = async (name, content) => writeFile(path.join(vault, name), content);
  const note = (meta, body = "") => `---\n${meta}---\n${body}\n`;
  await write("Project - Demo.md", note("title: \"Project - Demo\"\ntype: project\nstatus: active\nrepo: /repo/demo\n"));
  await write("项目 - Solo.md", note("title: \"项目 - Solo\"\ntype: project\nstatus: active\n"));
  await write("Demo Topic A.md", note(
    "title: Demo Topic A\ntype: topic\nstatus: active\nproject: \"[[Project - Demo]]\"\n",
    "Mutual [[Demo Topic B]] and cross-galaxy [[Solo Note]], ghost [[Ghosted]].\n",
  ));
  await write("Demo Topic B.md", note(
    "title: Demo Topic B\ntype: topic\nstatus: active\nproject: \"[[Project - Demo]]\"\n",
    "Back to [[Demo Topic A]], on to [[Demo Topic C]], hub [[Home]].\n",
  ));
  await write("Demo Topic C.md", note(
    "title: Demo Topic C\ntype: topic\nstatus: active\nproject: \"[[Project - Demo]]\"\ndepends_on: \"[[Project - Demo]]\"\n",
    "Event tether source: [[Demo Decision 1]].\n",
  ));
  await write("Demo Decision 1.md", note(
    "title: Demo Decision 1\ntype: decision\nstatus: accepted\nproject: \"[[Project - Demo]]\"\n",
    "Led to [[Demo Deployment 1]].\n",
  ));
  await write("Demo Deployment 1.md", note(
    "title: Demo Deployment 1\ntype: deployment\nstatus: succeeded\nproject: \"[[Project - Demo]]\"\n",
  ));
  await write("01 Projects/Solo/Solo Note.md", note(
    "title: Solo Note\nstatus: active\n",
  ));
  await write("Home.md", note("title: Home\n"));
  await write("Demo 总览.md", note("title: Demo 总览\n"));
  await write("Nav MOC.md", note("title: Nav MOC\ntype: moc\n"));
  await write("Demo Shared Planet.md", note("title: Demo Shared Planet\ntype: reference\nstatus: active\n"));

  const index = new VaultIndex({ root: vault, config: { ignoreFolders: [] }, now });
  await index.refresh({ force: true });
  const ontology = await loadOntology({ pluginRoot: PLUGIN_ROOT, index });
  const payload = buildGraphPayload({ index, ontology, now: now(), vaultName: "Knowledge" });
  const byTitle = new Map(payload.nodes.map((node) => [node.title, node]));
  return { index, ontology, payload, byTitle };
}

test("galaxy inference: project field, folder rule, then shared", async () => {
  const { payload, byTitle } = await fixture();
  assert.equal(byTitle.get("Project - Demo").galaxy, "Project - Demo.md", "a project note is its own galaxy");
  assert.equal(byTitle.get("Demo Topic A").galaxy, "Project - Demo.md", "project field wins");
  assert.equal(byTitle.get("Solo Note").galaxy, "项目 - Solo.md", "01 Projects/<Name>/ maps to the prefixed project title");
  assert.equal(byTitle.get("Demo Shared Planet").galaxy, "shared", "everything else is shared");
});

test("kind rules: star, moon (events), nav by family and by navigationNamePatterns, planet", async () => {
  const { payload, byTitle } = await fixture();
  assert.equal(byTitle.get("Project - Demo").kind, "star");
  assert.equal(byTitle.get("Demo Decision 1").kind, "moon");
  assert.equal(byTitle.get("Demo Deployment 1").kind, "moon", "deployment resolves to release, so an event");
  assert.equal(byTitle.get("Home").kind, "nav", "untyped note matching a navigation name pattern");
  assert.equal(byTitle.get("Demo 总览").kind, "nav");
  assert.equal(byTitle.get("Nav MOC").kind, "nav", "navigation family");
  assert.equal(byTitle.get("Demo Shared Planet").kind, "planet");
  // The pattern rule only applies to untyped notes.
  const typed = { id: "Reports Home.md", cls: "topic", family: "entity", title: "Reports Home" };
  assert.equal(
    kindOf(typed, { navigationNamePatterns: [/^Home$/] }),
    "planet",
    "a typed note never becomes nav by name",
  );
});

test("the deployment alias reads as release", async () => {
  const { ontology, byTitle } = await fixture();
  assert.equal(ontology.resolveClass("deployment"), "release");
  const deployment = byTitle.get("Demo Deployment 1");
  assert.equal(deployment.cls, "release");
  assert.equal(deployment.family, "event");
});

test("ring split: the first ceil(n/3) planets by degree are inner", async () => {
  const { payload } = await fixture();
  const demoPlanets = payload.nodes
    .filter((node) => node.galaxy === "Project - Demo.md" && node.kind === "planet")
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || (a.id < b.id ? -1 : 1));
  const innerCount = Math.ceil(demoPlanets.length / 3);
  const inner = demoPlanets.filter((node) => node.ring === "inner");
  const outer = demoPlanets.filter((node) => node.ring === "outer");
  assert.equal(inner.length, innerCount);
  assert.deepEqual(inner, demoPlanets.slice(0, innerCount), "inner = top degrees, id tie-break");
  assert.equal(inner.length + outer.length, demoPlanets.length);
  // Solo Note is its galaxy's only planet: inner.
  assert.equal(payload.nodes.find((node) => node.id === "01 Projects/Solo/Solo Note.md").ring, "inner");
});

test("link kinds on the fixture: one line per unordered pair per predicate", async () => {
  const { payload, byTitle } = await fixture();
  const counts = {};
  for (const link of drawableLinks(payload.links)) {
    counts[link.kind] = (counts[link.kind] ?? 0) + 1;
  }
  // Every project-field note contributes one parent link (predicate project):
  // Demo Topic A/B/C, Demo Decision 1, Demo Deployment 1.
  assert.equal(counts.parent, 5);
  assert.equal(counts.constellation, 2, "A↔B and B→C inside the demo galaxy");
  assert.equal(counts.lane, 1, "A→Solo Note is one lane for the galaxy pair");
  assert.equal(counts.hub, 1, "B→Home touches a nav node");
  assert.equal(counts.typed, 1, "depends_on predicate");
  assert.equal(counts.tether, 1, "C→Demo Decision 1 (event-planet, same galaxy)");
  assert.equal(counts.moon, 1, "Decision→Deployment is an event-event link in one galaxy");
  // Ghosts never become links; they are reported separately.
  assert.ok(!counts.ghost);
  assert.deepEqual(payload.ghosts.map((ghost) => ghost.id), ["Ghosted"]);

  // The overview's visible lines are constellation + typed + one lane per pair.
  const lanePairs = new Set(
    drawableLinks(payload.links)
      .filter((link) => link.kind === "lane")
      .map((link) => {
        const a = payload.nodes.find((node) => node.id === link.source).galaxy;
        const b = payload.nodes.find((node) => node.id === link.target).galaxy;
        return a < b ? `${a}|${b}` : `${b}|${a}`;
      }),
  );
  const overview = (counts.constellation ?? 0) + lanePairs.size + (counts.typed ?? 0);
  assert.equal(overview, 4);

  // Mutually-linked notes are drawn once: A→B and B→A collapse to one line.
  const ab = drawableLinks(payload.links).filter(
    (link) =>
      link.kind === "constellation" &&
      { [link.source]: 1, [link.target]: 1 }["Demo Topic A.md"] &&
      { [link.source]: 1, [link.target]: 1 }["Demo Topic B.md"],
  );
  assert.equal(ab.length, 1);
});

test("payload carries galaxies, positions, and the applied-layout flag", async () => {
  const { payload } = await fixture();
  assert.equal(payload.layoutApplied, true);
  const galaxies = payload.galaxies;
  const shared = galaxies.find((galaxy) => galaxy.id === "shared");
  assert.ok(shared);
  assert.equal(shared.cx, 0);
  assert.equal(shared.cy, 0);
  const demo = galaxies.find((galaxy) => galaxy.id === "Project - Demo.md");
  assert.ok(demo);
  assert.equal(demo.name, "Project - Demo", "titles without a configured prefix stay as they are");
  assert.equal(demo.hue, "#f2c27b", "the largest major galaxy takes the first rank hue");
  const solo = galaxies.find((galaxy) => galaxy.id === "项目 - Solo.md");
  assert.ok(solo);
  assert.equal(solo.name, "Solo", "the project-title prefix is stripped for the folder-rule project");
  for (const node of payload.nodes) {
    assert.equal(typeof node.x, "number");
    assert.equal(typeof node.y, "number");
    assert.equal(typeof node.z, "number");
    assert.ok(node.galaxy);
  }
});

test("layout determinism: shuffling the input order gives identical positions", async () => {
  const { index, ontology } = await fixture();
  const first = buildGraphPayload({ index, ontology, now: now(), vaultName: "K" });
  const shuffled = buildGraphPayload({ index, ontology, now: now(), vaultName: "K" });
  // Deterministic shuffle of both arrays.
  for (let i = shuffled.nodes.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [shuffled.nodes[i], shuffled.nodes[j]] = [shuffled.nodes[j], shuffled.nodes[i]];
  }
  for (let i = shuffled.links.length - 1; i > 0; i--) {
    const j = (i * 104729 + 7) % (i + 1);
    [shuffled.links[i], shuffled.links[j]] = [shuffled.links[j], shuffled.links[i]];
  }
  applyUniverseLayout(shuffled, {
    navigationNamePatterns: ontology.navigationNamePatterns,
    projectTitlePrefixes: ontology.projectTitlePrefixes,
  });
  assert.equal(shuffled.nodes.length, first.nodes.length);
  const byId = new Map(shuffled.nodes.map((node) => [node.id, node]));
  for (const node of first.nodes) {
    const other = byId.get(node.id);
    assert.ok(other, `node ${node.id} survives the shuffle`);
    assert.equal(other.galaxy, node.galaxy);
    assert.equal(other.kind, node.kind);
    assert.equal(other.ring ?? null, node.ring ?? null);
    for (const axis of ["x", "y", "z"]) {
      assert.ok(Math.abs(other[axis] - node[axis]) < 1e-9, `${axis} matches for ${node.id}`);
    }
  }
  assert.deepEqual(
    shuffled.galaxies.map((g) => [g.id, g.cx, g.cy, g.R, g.hue, g.role]),
    first.galaxies.map((g) => [g.id, g.cx, g.cy, g.R, g.hue, g.role]),
  );
});

test("galaxyOf and kindOf handle minimal inputs", () => {
  const nodesById = new Map([["P.md", { id: "P.md", cls: "project" }]]);
  const projectsByFolderName = new Map([["Solo", "P.md"]]);
  assert.equal(galaxyOf({ id: "N.md", cls: "topic", project: "P.md" }, { nodesById, projectsByFolderName }), "P.md");
  assert.equal(galaxyOf({ id: "01 Projects/Solo/N.md" }, { nodesById, projectsByFolderName }), "P.md");
  assert.equal(galaxyOf({ id: "somewhere/N.md" }, { nodesById, projectsByFolderName }), "shared");
  assert.equal(kindOf({ cls: "project", family: "entity" }), "star");
  assert.equal(kindOf({ cls: "record", family: "event" }), "moon");
  assert.equal(kindOf({ cls: "unknown", family: "entity", id: "X 总览.md" }, { navigationNamePatterns: [/(总览|索引)$/] }), "nav");
  assert.equal(kindOf({ cls: "memory", family: "memory" }), "satellite");
});

test("WebGL-failure fallback logic (§12.6)", () => {
  // Default is 3D.
  assert.deepEqual(initialViewMode({ webglAvailable: true, storedMode: null }), {
    mode: MODE_3D,
    showFallbackNotice: false,
  });
  // A stored chart choice is honored when WebGL exists.
  assert.deepEqual(initialViewMode({ webglAvailable: true, storedMode: MODE_CHART }), {
    mode: MODE_CHART,
    showFallbackNotice: false,
  });
  // Without WebGL the view falls back to the chart and shows the notice…
  assert.deepEqual(initialViewMode({ webglAvailable: false, storedMode: null }), {
    mode: MODE_CHART,
    showFallbackNotice: true,
  });
  // …unless the user had already picked the chart themselves.
  assert.deepEqual(initialViewMode({ webglAvailable: false, storedMode: MODE_CHART }), {
    mode: MODE_CHART,
    showFallbackNotice: false,
  });
  // A stored 3D choice with no WebGL falls back with the notice.
  assert.deepEqual(initialViewMode({ webglAvailable: false, storedMode: MODE_3D }), {
    mode: MODE_CHART,
    showFallbackNotice: true,
  });
});
