#!/usr/bin/env node
/**
 * Refresh the runtime this plugin ships.
 *
 * `plugins/minih.terminal/` is the plugin exactly as it installs, so the native
 * module and the browser assets live inside it and are committed: the host never
 * runs `npm install`, a compiler, or downloaded code when a user enables a
 * plugin. This script rebuilds those two folders from the pinned dev
 * dependencies and reports which platforms the result can run on.
 *
 *   pnpm install                                  # once, in this directory
 *   node scripts/build.mjs                        # development build
 *   node scripts/build.mjs --require-platforms linux-x64,linux-arm64
 *                                                 # release build: exit 1 when any
 *                                                 # required platform has no asset
 *
 * A development build may carry a subset — that is what a machine without a
 * Linux toolchain produces — but it says so and is never described as a
 * three-platform delivery. Nothing is written until the platform question is
 * answered, so a refused release build leaves the committed tree untouched.
 */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PLATFORMS, planNativeAssets, unmetPlatforms } from "./native-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");

/** xterm asset: source, then destination inside `view/vendor`. */
const VIEW_ASSETS = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-search/lib/addon-search.js", "addon-search.js"],
];

const report = { copied: 0, bytes: 0 };

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Copy one file, keeping its executable bit.
 *
 * node-pty's macOS `spawn-helper` arrives without that bit from some stores, and
 * a helper that cannot be executed fails the spawn with a bare
 * "posix_spawnp failed".
 */
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (statSync(from).mode & 0o111) chmodSync(to, 0o755);
  report.copied += 1;
  report.bytes += statSync(to).size;
}

function copyTree(from, to, skip = () => false) {
  for (const file of walk(from)) {
    if (skip(file)) continue;
    copy(file, join(to, relative(from, file)));
  }
}

function relativeFiles(dir) {
  return walk(dir).map((file) => relative(dir, file).split(sep).join("/"));
}

// --- decide the native payload before touching the tree -------------------

const pty = join(modules, "node-pty");
const prebuildsRoot = join(pty, "prebuilds");
const prebuilds = {};
for (const entry of readdirSync(prebuildsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  prebuilds[entry.name] = relativeFiles(join(prebuildsRoot, entry.name));
}

// A `node-pty` compiled on this machine (`npm_config_build_from_source=1`) lands
// in `build/Release`. That is the documented Linux path, so it counts as this
// host's own platform when no prebuild exists for it.
const releaseRoot = join(pty, "build", "Release");
const localBuild = statSync(releaseRoot, { throwIfNoEntry: false })?.isDirectory()
  ? { platform: `${process.platform}-${process.arch}`, files: relativeFiles(releaseRoot) }
  : null;

const plan = planNativeAssets({ prebuilds, localBuild });
const carried = plan.platforms.map((entry) => entry.platform);

const flagIndex = process.argv.indexOf("--require-platforms");
if (flagIndex >= 0) {
  const requested = String(process.argv[flagIndex + 1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = requested.filter((platform) => !RELEASE_PLATFORMS.includes(platform));
  if (requested.length === 0 || unknown.length > 0) {
    process.stderr.write(
      `--require-platforms needs known ids (${RELEASE_PLATFORMS.join(", ")}); got ${requested.join(", ") || "nothing"}\n`,
    );
    process.exit(1);
  }
  const unmet = unmetPlatforms(plan, requested);
  if (unmet.length > 0) {
    process.stderr.write(
      `release build refused: no PTY assets for ${unmet.join(", ")}. Build node-pty from source on each of them (npm_config_build_from_source=1 pnpm rebuild node-pty) and re-run there. Nothing was written.\n`,
    );
    process.exit(1);
  }
}

// --- write the vendored runtime -------------------------------------------

rmSync(join(root, "view", "vendor"), { recursive: true, force: true });
rmSync(join(root, "vendor", "node-pty"), { recursive: true, force: true });

for (const [source, name] of VIEW_ASSETS) {
  copy(join(modules, source), join(root, "view", "vendor", name));
}

copy(join(pty, "package.json"), join(root, "vendor", "node-pty", "package.json"));
copyTree(join(pty, "lib"), join(root, "vendor", "node-pty", "lib"), (file) =>
  file.endsWith(".map") || file.endsWith(".test.js"),
);
for (const entry of plan.platforms) {
  const from = entry.source === "prebuild" ? join(prebuildsRoot, entry.platform) : releaseRoot;
  const to = join(root, "vendor", "node-pty", "prebuilds", entry.platform);
  for (const file of entry.files) copy(join(from, file), join(to, file));
  try {
    chmodSync(join(to, "spawn-helper"), 0o755);
  } catch {
    // Only macOS carries a helper; every other platform has none.
  }
  if (entry.source === "local-build") {
    process.stdout.write(`  packaged ${entry.platform} from this machine's build/Release\n`);
  }
}

// --- verify and report ----------------------------------------------------

const required = [
  "manifest.json",
  "main.js",
  "lib/terminal-engine.js",
  "lib/shells.js",
  "view/index.html",
  "view/terminal.js",
  "view/terminal.css",
  "view/vendor/xterm.js",
  "view/vendor/xterm.css",
  "view/vendor/addon-fit.js",
  "view/vendor/addon-search.js",
  "vendor/node-pty/package.json",
  "vendor/node-pty/lib/index.js",
];
const absent = required.filter(
  (file) => !statSync(join(root, file), { throwIfNoEntry: false })?.isFile(),
);
if (absent.length > 0) {
  process.stderr.write(`build failed, missing: ${absent.join(", ")}\n`);
  process.exit(1);
}

const megabytes = (report.bytes / 1024 / 1024).toFixed(2);
process.stdout.write(
  `minih.terminal: ${report.copied} files refreshed, ${megabytes} MB, PTY platforms: ${carried.join(", ") || "none"}\n`,
);
for (const entry of plan.missing) {
  process.stdout.write(`  missing ${entry.platform}: ${entry.files.join(", ")}\n`);
}
if (flagIndex >= 0) {
  process.stdout.write(`release build: every required platform is present\n`);
} else if (plan.missing.length > 0) {
  process.stdout.write(
    "  this is a development build for a platform subset, not a three-platform delivery\n",
  );
}
