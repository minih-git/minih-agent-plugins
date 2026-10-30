// Exercise the shipped Rust marketplace installer in a fresh, disposable data root.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [host, input, desktop] = process.argv.slice(2);
if (!host || !input || !desktop) throw new Error('Usage: node scripts/verify-marketplace.mjs /absolute/path/to/host-core catalog.json-or-url /absolute/path/to/Minih-Agent-Desktop');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'lcu-market-'));
const dataDir = join(work, 'host-data');
const catalogPath = join(work, 'catalog.json');
const data = /^https:\/\//.test(input)
  ? await (async () => {
    const response = await fetch(input, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Catalog download failed: HTTP ${response.status}`);
    return response.json();
  })() : JSON.parse(readFileSync(resolve(input), 'utf8'));
const offered = data.plugins.find(plugin => plugin.id === 'minih.lcu');
assert.ok(offered, 'LCU must be discoverable in the real catalog');
assert.equal(offered.versions.length, 1);
const version = offered.versions[0];
assert.equal(version.version, '0.1.2');
assert.deepEqual(version.permissions, ['agent.extension']);
assert.equal(version.minMinihAgent, '>=1.1.3');
const catalog = { ...data, plugins: [structuredClone(offered)] };
if (!/^https:\/\//.test(input)) {
  catalog.artifact_base_url = pathToFileURL(dirname(resolve(input))).href;
}
const expectedHash = version.shasum;
const save = hash => {
  catalog.plugins[0].versions[0].shasum = hash;
  writeFileSync(catalogPath, JSON.stringify(catalog));
};
save('0'.repeat(64));
const child = spawn(resolve(host), [], {
  cwd: work, stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: work, RUST_LOG: 'error',
    MINIH_AGENT_DATA_DIR: dataDir,
    MINIH_AGENT_PLUGIN_MARKET_URL: pathToFileURL(catalogPath).href,
    // Keep any explicitly configured download proxy inside this child only.
    ...Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'].filter(key => process.env[key])
      .map(key => [key, process.env[key]])),
  },
});
let sequence = 0;
const pending = new Map();
let diagnostic = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', text => { diagnostic = (diagnostic + text).slice(-2000); });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  if (!waiter) return;
  pending.delete(response.id);
  clearTimeout(waiter.timer);
  if (response.error) waiter.reject(new Error(JSON.stringify(response.error)));
  else waiter.resolve(response.result);
});
child.on('exit', () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`Isolated Host exited before its RPC response: ${diagnostic}`));
  }
  pending.clear();
});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
try {
  const protocol = readFileSync(join(resolve(desktop), 'packages/shared/src/protocol.ts'), 'utf8')
    .match(/export const PROTOCOL_VERSION = (\d+)/);
  assert.ok(protocol, 'The authoritative Host protocol version must be available');
  const handshake = await rpc('app.handshake', { protocolVersion: Number(protocol[1]) });
  assert.equal(handshake.protocolVersion, Number(protocol[1]));
  assert.ok(handshake.capabilities.includes('plugins'));
  await rpc('market.refresh', { force: true });
  const found = await rpc('market.search', { query: 'LCU' });
  assert.ok(found.plugins.some(plugin => plugin.id === 'minih.lcu'));
  await assert.rejects(rpc('market.install', {
    id: 'minih.lcu', version: '0.1.2', enable: true, grantedPermissions: ['agent.extension'],
  }), /INTEGRITY|checksum/i, 'Mismatched package hashes must be refused');
  save(expectedHash);
  await rpc('market.refresh', { force: true });
  await assert.rejects(rpc('market.install', {
    id: 'minih.lcu', version: '0.1.2', enable: true, grantedPermissions: [],
  }), /PERMISSION_DENIED|missing grant/i, 'Omitting the trusted-code grant must refuse installation');
  const installed = await rpc('market.install', {
    id: 'minih.lcu', version: '0.1.2', enable: true, grantedPermissions: ['agent.extension'], autoUpdate: false,
  });
  const plugin = installed.result.plugin;
  assert.equal(plugin.id, 'minih.lcu');
  assert.equal(plugin.version, '0.1.2');
  assert.equal(plugin.source, 'marketplace');
  assert.equal(plugin.enabled, true);
  assert.deepEqual(plugin.permissions, ['agent.extension']);
  assert.ok(plugin.path.startsWith(dataDir));
  assert.equal(plugin.marketplace.shasum, expectedHash);
  const manifest = JSON.parse(readFileSync(join(plugin.path, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['agent.extension']);
  const build = JSON.parse(readFileSync(join(plugin.path, 'agent/build.json'), 'utf8'));
  assert.equal(createHash('sha256').update(readFileSync(join(plugin.path, 'agent/index.mjs'))).digest('hex'), build.sha256);
  assert.ok(!existsSync(join(plugin.path, 'node_modules')));
  const run = spawnSync(process.execPath, [join(root, 'scripts/verify-host.mjs'),
    resolve(desktop), plugin.path], {
    encoding: 'utf8', timeout: 120_000, env: process.env,
  });
  if (run.status !== 0) throw new Error(`Marketplace-installed extension acceptance failed: ${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes('PASS real Minih runner:'));
  console.log(`PASS marketplace 0.1.2: discover, reject bad checksum/missing grant, install with explicit grant, verify package metadata and execute installed extension regressions (${expectedHash}).`);
} finally {
  child.stdin.end();
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  lines.close();
  rmSync(work, { recursive: true, force: true });
}
