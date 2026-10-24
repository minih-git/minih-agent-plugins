#!/usr/bin/env node
/**
 * Refresh the code this plugin vendors.
 *
 * `plugins/minih.personal-knowledge/` is the plugin exactly as it installs, so
 * everything it needs at runtime is committed: the host never runs `npm
 * install` or downloads code when a user enables a plugin. This script bundles
 * the pinned dev dependencies into the committed vendor files:
 *
 *   lib/vendor/yaml.mjs     the `yaml` package as one self-contained ESM file
 *                           (frontmatter parsing with round-trip Documents)
 *   view/vendor/*.mjs       `force-graph` (flat chart mode) and
 *                           `universe-3d` (`3d-force-graph` + `three` +
 *                           bloom/output/CSS2D add-ons in one `three` copy)
 *                           for the Knowledge Universe view
 *   THIRD_PARTY_NOTICES.md  licenses of everything vendored above
 *
 *   node scripts/build.mjs --lib    # only lib/vendor/yaml.mjs (test speed)
 *   node scripts/build.mjs          # everything
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");
const libOnly = process.argv.includes("--lib");
// esbuild ships CJS; import it through createRequire.
const requireFromHere = createRequire(import.meta.url);

function bundle(entry, outfile) {
  const { buildSync } = requireFromHere(join(modules, "esbuild", "lib", "main.js"));
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "inline",
    minify: true,
    sourcemap: false,
    outfile,
    logLevel: "silent",
  });
  const bytes = result?.outputFiles?.[0]?.contents?.length ?? 0;
  return bytes;
}

function copyYaml() {
  // The `yaml` package ships a self-contained browser ESM bundle; bundling it
  // ourselves keeps one pinned, minified file instead of a package tree.
  bundle(join(modules, "yaml", "browser", "index.js"), join(root, "lib", "vendor", "yaml.mjs"));
}

function copyViewLibraries() {
  const vendor = join(root, "view", "vendor");
  mkdirSync(vendor, { recursive: true });
  // Chart mode (flat star chart).
  bundle(join(modules, "force-graph", "dist", "force-graph.mjs"), join(vendor, "force-graph.mjs"));
  // 3D star map: one bundle re-exporting 3d-force-graph, three, and the
  // three add-ons (bloom, output, CSS2D labels, fat lines) so everything
  // shares a single three instance (design doc §7).
  bundle(join(root, "scripts", "vendor-universe-3d.entry.mjs"), join(vendor, "universe-3d.mjs"));
  // The pure layout module, so the view never reaches outside view/ for a
  // module import (panel browsers may sandbox the view directory).
  bundle(join(root, "lib", "layout.mjs"), join(vendor, "layout.mjs"));
}

function notices() {
  const sources = [
    ["yaml", "yaml", "ISC"],
    ["3d-force-graph", "3d-force-graph", "MIT"],
    ["force-graph", "force-graph", "MIT"],
    ["three", "three.js", "MIT"],
    ["d3-force-3d", "d3-force-3d", "ISC"],
  ];
  const lines = [
    "# Third-party notices",
    "",
    "Vendored code rebuilt by `scripts/build.mjs` from the pinned dev",
    "dependencies in `package.json`. Licenses below are reproduced from the",
    "upstream packages; see each package repository for the full text.",
    "",
  ];
  for (const [dir, name, license] of sources) {
    const licensePath = join(modules, dir, "LICENSE");
    let text = "";
    try {
      text = readFileSync(licensePath, "utf8").trim();
    } catch {
      text = `See the upstream ${name} repository for the complete ${license} license text.`;
    }
    lines.push(`## ${name} (${license})`, "", text, "");
  }
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
}

function requiredFiles() {
  const required = ["lib/vendor/yaml.mjs"];
  if (!libOnly) required.push("view/vendor/force-graph.mjs", "view/vendor/universe-3d.mjs", "view/vendor/layout.mjs", "THIRD_PARTY_NOTICES.md");
  const missing = required.filter((relative) => {
    try {
      return readFileSync(join(root, relative)) === null;
    } catch {
      return true;
    }
  });
  return missing;
}

const mode = libOnly ? "lib" : "full";
if (!libOnly) {
  rmSync(join(root, "view", "vendor"), { recursive: true, force: true });
}
copyYaml();
if (!libOnly) {
  copyViewLibraries();
  notices();
}
const missing = requiredFiles();
if (missing.length > 0) {
  process.stderr.write(`build failed, missing: ${missing.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`minih.personal-knowledge: vendored ${mode} build refreshed\n`);
