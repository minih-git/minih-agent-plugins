#!/usr/bin/env node

/**
 * Regenerate `catalog.json` from the plugin sources and packages in this
 * repository.
 *
 * The layout it reads is the distribution contract Minih-Agent-Desktop's
 * plugin marketplace consumes:
 *
 *   plugins/<id>/manifest.json                 plugin source and manifest
 *   packages/<id>-<version>.piplug             the built package
 *   catalog.json                               what a client downloads first
 *
 * Package URLs stay relative, so a mirror that serves the same tree serves the
 * same bytes and the digest in this catalog keeps matching.
 *
 * `releases.json` records when each version was first published. It is written
 * once per version and then left alone, so regenerating the catalog does not
 * rewrite publication history.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Filled in by whoever publishes: the repository this catalog is served from. */
const ARTIFACT_BASE_URL = "https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main";
const CATALOG_NAME = "Minih-Agent-Desktop Plugins";
const CATALOG_HOMEPAGE = "https://github.com/minih-git/minih-agent-plugins";
const PUBLISHER_ID = "minih-git";

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  const bytes = await readFile(path);
  return { shasum: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

function semverKey(version) {
  const match = String(version)
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? "",
  };
}

function compareVersions(left, right) {
  const a = semverKey(left);
  const b = semverKey(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  // A prerelease sorts before the release it precedes.
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}

/**
 * Origin of a redistributed plugin.
 *
 * `preserved` means the directory carries the upstream artifacts unchanged, so
 * the provenance entry can point at the repository those bytes came from.
 */
const PROVENANCE = {
  "local.remote-tools": {
    sourceRepository: "https://github.com/jiege6-66/pi-desktop-remote-tools",
    sourceRef: "v0.1.0",
    builder: "repack@minih-agent-plugins",
  },
};

async function main() {
  const pluginRoot = join(root, "plugins");
  const packageRoot = join(root, "packages");
  const entries = await readdir(pluginRoot, { withFileTypes: true });
  const releases = await readJson(join(root, "releases.json"), {});
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const plugins = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(join(pluginRoot, entry.name, "manifest.json"), null);
    if (!manifest?.id || !manifest.version) {
      throw new Error(`plugins/${entry.name}/manifest.json has no id or version`);
    }
    const packageName = `${manifest.id}-${manifest.version}.piplug`;
    const packagePath = join(packageRoot, packageName);
    if (!existsSync(packagePath)) {
      throw new Error(`missing package: packages/${packageName}`);
    }
    const { shasum, sizeBytes } = await sha256(packagePath);
    const releaseKey = `${manifest.id}@${manifest.version}`;
    if (!releases[releaseKey]) {
      releases[releaseKey] = now;
      process.stdout.write(`recorded first publication of ${releaseKey}\n`);
    }
    const engines = manifest.engines ?? {};
    const version = {
      version: manifest.version,
      publishedAt: releases[releaseKey],
      shasum,
      url: `packages/${packageName}`,
      sizeBytes,
      permissions: manifest.permissions ?? [],
      yanked: false,
    };
    const minHost = engines.piDesktop ?? engines.minihAgentDesktop;
    if (minHost) version.minMinihAgent = minHost;
    const provenance = PROVENANCE[manifest.id];
    if (provenance) {
      version.provenance = { ...provenance, sourcePath: `plugins/${manifest.id}` };
    }
    const versions = [version].sort((left, right) => compareVersions(right.version, left.version));

    const catalogEntry = {
      id: manifest.id,
      name: manifest.name ?? manifest.id,
      description: manifest.description ?? "",
      author: manifest.author ?? "",
      icon_url: null,
      categories: manifest.categories ?? [],
      verified: false,
      // Community trust: this repository redistributes plugins other people
      // published. Only the project's own plugin could claim `verified`.
      trust: "community",
      publisher_id: PUBLISHER_ID,
      homepage: manifest.homepage ?? null,
      repository: PROVENANCE[manifest.id]?.sourceRepository ?? null,
      safety_notes: manifest.safetyNotes ?? null,
      i18n: manifest.i18n ?? null,
      versions,
    };
    plugins.push(catalogEntry);
  }

  const catalog = {
    schema_version: 1,
    provider_id: "official",
    catalog_id: null,
    name: CATALOG_NAME,
    homepage: CATALOG_HOMEPAGE,
    updated_at: now,
    generated_at: now,
    policy_version: null,
    artifact_base_url: ARTIFACT_BASE_URL,
    plugins,
  };

  await writeFile(join(root, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(join(root, "releases.json"), `${JSON.stringify(releases, null, 2)}\n`);
  process.stdout.write(`catalog.json: ${plugins.length} plugin(s)\n`);
}

await main();
