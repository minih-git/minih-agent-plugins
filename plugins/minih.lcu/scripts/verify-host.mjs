// Headless contract acceptance using the real Minih extension runner, not the running app.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureEnvironment, PNG } from '../tests/helpers.mjs';

const desktop = process.argv[2] ?? process.env.MINIH_DESKTOP_ROOT;
if (!desktop) throw new Error('Usage: npm run verify:host -- /absolute/path/to/Minih-Agent-Desktop');
const root = process.argv[3] ? resolve(process.argv[3]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'lcu-host-'));
const output = join(work, 'runner.mjs');
const edge = fixtureEnvironment();
const runners = [];
try {
  await build({
    absWorkingDir: desktop,
    entryPoints: [join(desktop, 'packages/agent-runtime/src/extensions/runner.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { PI_BUNDLED_NODE: 'true' },
    banner: { js: "import { createRequire as minihHostCreateRequire } from 'node:module'; const require = minihHostCreateRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  const { TrustedExtensionRunner } = await import(pathToFileURL(output).href);
  function makeRunner(sessionId, choice = 'allow') {
    const diagnostics = [];
    const prompts = [];
    const notices = [];
    const bridge = {
      sessionId, cwd: edge.directory, getModel: () => ({ id: 'fixture-model' }),
      setModel: async () => true, getThinkingLevel: () => 'off', setThinkingLevel() {},
      isIdle: () => true, abort() {}, hasPendingMessages: () => false,
      getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => 'Minih base',
      getActiveTools: () => [], getAllTools: () => [], setActiveTools() {},
      getSessionName: () => sessionId, setSessionName() {}, sendUserMessage() {},
      waitForIdle: async () => {}, newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }), publishCommands() {},
      publishDiagnostics: entries => { diagnostics.splice(0, diagnostics.length, ...entries); },
      requestUi: async (_extension, request) => {
        if (request.kind === 'select') {
          prompts.push(request);
          const value = choice === 'allow' ? request.options[0]
            : choice === 'always' ? 'Always allow' : choice === 'deny' ? 'Decline' : undefined;
          return { kind: 'select', value };
        }
        notices.push(request);
        return { kind: request.kind };
      },
    };
    const runner = new TrustedExtensionRunner({
      specs: [{ id: 'minih.lcu', entry: join(root, 'agent/index.mjs'), root, label: 'LCU', source: 'user' }],
      bridge,
    });
    runners.push(runner);
    return { runner, diagnostics, prompts, notices };
  }

  const a = makeRunner('host-session-a');
  const b = makeRunner('host-session-b', 'dismiss');
  for (const s of [a, b]) {
    assert.equal((await s.runner.load())[0].state, 'loaded', JSON.stringify(s.diagnostics));
    const prompt = await s.runner.emitBeforeAgentStart('Use the fixture', 'Minih base');
    assert.match(prompt, /^Minih base\n\nFixture computer-use instructions\./);
    assert.match(prompt, /# LCU Computer Use/);
    assert.deepEqual(s.runner.getAgentTools().map(tool => tool.name), ['js', 'js_reset']);
    await s.runner.emit('agent_start', { type: 'agent_start' });
  }
  const call = (s, id, code, signal) => s.runner.getAgentTools().find(tool => tool.name === 'js').execute(id, { code }, signal);
  const image = await call(a, 'host-image', 'image');
  assert.equal(image.content[1].data, PNG);
  assert.equal(JSON.parse((await call(a, 'host-approval', 'approve:dev.minih.fixture')).content[0].text).action, 'accept');
  assert.equal(JSON.parse((await call(b, 'host-dismiss', 'approve:dev.minih.fixture')).content[0].text).action, 'cancel');
  assert.equal(a.prompts.length, 1);
  assert.equal(b.prompts.length, 1);
  await assert.rejects(call(a, 'host-error', 'error'), /Original fixture error/);
  const pending = call(a, 'host-pending', 'pending');
  await edge.waitFor(entries => entries.some(entry => entry.args?.code === 'pending'));
  assert.equal(await a.runner.runCommand('lcu', 'stop'), true);
  assert.equal((await pending).content[0].text, 'Stopped by original control.');
  for (const s of [a, b]) {
    await s.runner.emit('agent_end', { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
  }
  const entries = edge.entries();
  const calls = entries.filter(entry => entry.name === 'js');
  const sessionIds = new Set(calls.map(entry => entry.meta['x-codex-turn-metadata'].session_id));
  assert.deepEqual([...sessionIds].sort(), ['host-session-a', 'host-session-b']);
  const turns = new Map();
  for (const entry of calls) {
    const meta = entry.meta['x-codex-turn-metadata'];
    if (turns.has(meta.session_id)) assert.equal(turns.get(meta.session_id), meta.turn_id);
    turns.set(meta.session_id, meta.turn_id);
  }
  assert.equal(new Set(turns.values()).size, 2);
  for (const [sessionId, turnId] of turns) {
    const ended = entries.filter(entry => entry.name === 'turn_ended' && entry.args.session_id === sessionId);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].args.turn_id, turnId);
  }
  for (const s of [a, b]) assert.deepEqual(s.diagnostics, []);

  const permanent = makeRunner('permanent-session', 'always');
  assert.equal((await permanent.runner.load())[0].state, 'loaded');
  await permanent.runner.emitBeforeAgentStart('Remember the fixture', 'Minih base');
  await permanent.runner.emit('agent_start', { type: 'agent_start' });
  for (const id of ['first-permanent-call', 'repeat-permanent-call']) {
    assert.equal(JSON.parse((await call(permanent, id, 'approve:dev.minih.remembered')).content[0].text).action, 'accept');
  }
  assert.equal(permanent.prompts.length, 1, 'Permanent consent must be requested only once');
  await permanent.runner.dispose();

  const reloaded = makeRunner('reloaded-session', 'deny');
  assert.equal((await reloaded.runner.load())[0].state, 'loaded');
  await reloaded.runner.emitBeforeAgentStart('Use the remembered fixture', 'Minih base');
  await reloaded.runner.emit('agent_start', { type: 'agent_start' });
  assert.equal(JSON.parse((await call(reloaded, 'reloaded-call', 'approve:dev.minih.remembered')).content[0].text).action, 'accept');
  assert.equal(reloaded.prompts.length, 0, 'Saved approval must survive a new runner');
  writeFileSync(`${edge.trace}.apps.json`, JSON.stringify({ approvedBundleIdentifiers: [] }));
  assert.equal(JSON.parse((await call(reloaded, 'revoked-call', 'approve:dev.minih.remembered')).content[0].text).action, 'decline');
  assert.equal(reloaded.prompts.length, 1, 'External revocation must restore the prompt');
  assert.equal(edge.entries().filter(entry => entry.event === 'apps_owner_authenticated').length, 1);
  for (const s of [permanent, reloaded]) assert.deepEqual(s.diagnostics, []);
  await Promise.all(runners.map(runner => runner.dispose()));
  for (const entry of edge.entries().filter(entry => entry.event === 'started')) {
    assert.throws(() => process.kill(entry.pid, 0), { code: 'ESRCH' });
  }
  console.log('PASS real Minih runner: load, prompt, schemas, images, approvals, permanent save/reload/revocation, session isolation, Stop, cleanup and disposal.');
} finally {
  await Promise.all(runners.map(runner => runner.dispose()));
  edge.restore();
  rmSync(work, { recursive: true, force: true });
}
