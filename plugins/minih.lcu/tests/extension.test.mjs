import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import extension, { runtimeCommand, DISCOVERY_INSTRUCTIONS, STARTUP_TIMEOUT_MS } from '../agent/index.mjs';
import { fakeApi, fixtureEnvironment, PNG } from './helpers.mjs';

async function session(t, options = {}) {
  const edge = fixtureEnvironment();
  const host = fakeApi(options.id, options.select);
  t.after(async () => {
    try { await host.handlers.get('session_shutdown')(); } finally { edge.restore(); }
  });
  await extension(host.api);
  assert.deepEqual([...host.tools.keys()], ['js', 'js_reset'], 'Tools must exist before before_agent_start');
  const prompt = await host.handlers.get('before_agent_start')({ systemPrompt: 'Minih base', systemPromptOptions: {} }, host.ctx);
  await host.handlers.get('agent_start')({}, host.ctx);
  const execute = (code, signal) => host.tools.get('js').execute('fixture-call', { code }, signal, undefined, host.ctx);
  return { ...edge, ...host, prompt, execute };
}

// These checks run against the bundled contribution, exactly as an installed plugin loads it.
test('validates platform, argv, executable availability and unsafe approval overrides', () => {
  const base = { platform: 'darwin', arch: 'arm64', env: { LCU_MCP_COMMAND: JSON.stringify([process.execPath, 'argument with spaces']) } };
  assert.deepEqual(runtimeCommand(base), [process.execPath, 'argument with spaces']);
  assert.throws(() => runtimeCommand({ ...base, platform: 'win32' }), /only Apple Silicon macOS/);
  assert.throws(() => runtimeCommand({ ...base, arch: 'x64' }), /only Apple Silicon macOS/);
  assert.throws(() => runtimeCommand({ ...base, env: { LCU_ALLOW_AGENT_HOST_APPROVAL: '1' } }), /must not approve itself/);
  for (const value of ['node script.mjs', '[]', '["node"]', '[7]', '["/missing"]', '["/bin"]']) {
    assert.throws(() => runtimeCommand({ ...base, env: { LCU_MCP_COMMAND: value } }), /LCU_MCP_COMMAND|Cannot start LCU/);
  }
  assert.throws(() => runtimeCommand({ ...base, home: '/nonexistent', env: {} }), /--runtime-only/);
});

test('returns original instructions despite Desktop discarding prompt option mutations', async t => {
  const s = await session(t);
  assert.equal(s.prompt.systemPrompt, `Minih base\n\nFixture computer-use instructions.\n\n${DISCOVERY_INSTRUCTIONS}`);
  assert.deepEqual([...s.tools.keys()], ['js', 'js_reset']);
  assert.equal(s.tools.get('js').description, 'LCU computer use (desktop automation; cua_repl): Fixture original js.');
  assert.deepEqual(s.tools.get('js').parameters.required, ['code']);
  assert.equal(s.handlers.has('turn_end'), false);
  const next = await s.handlers.get('before_agent_start')({ systemPrompt: 'Fresh base', systemPromptOptions: {} }, s.ctx);
  assert.equal(next.systemPrompt, `Fresh base\n\nFixture computer-use instructions.\n\n${DISCOVERY_INSTRUCTIONS}`);
  assert.equal(next.systemPrompt.split('# LCU Computer Use').length, 2);
});

test('preserves images, original errors and session/call identities across model rounds', async t => {
  const s = await session(t);
  const screenshot = await s.execute('image');
  assert.deepEqual(screenshot.content, [
    { type: 'text', text: 'Fixture screenshot.' }, { type: 'image', mimeType: 'image/png', data: PNG },
  ]);
  await assert.rejects(s.execute('error'), /Original fixture error/);
  assert.equal((await s.execute('again')).content[0].text, 'again');
  const calls = s.entries().filter(entry => entry.name === 'js');
  const metadata = calls.map(entry => entry.meta['x-codex-turn-metadata']);
  assert.ok(metadata.every(meta => meta.session_id === 'fixture-session' && meta.call_id === 'fixture-call' && meta.model === 'fixture-model'));
  assert.equal(new Set(metadata.map(meta => meta.turn_id)).size, 1);
  assert.ok(metadata[0].turn_id);
  assert.equal(s.entries().some(entry => entry.name === 'turn_ended'), false);
});

for (const [label, choose, expected] of [
  ['allow once', options => options[0], 'accept'],
  ['decline', options => options.find(value => /decline/i.test(value)), 'decline'],
  ['dismiss', () => undefined, 'cancel'],
]) {
  test(`forwards native-app approval: ${label}`, async t => {
    let asked = 0;
    const s = await session(t, { select: async (_title, options) => { asked++; return choose(options); } });
    const response = JSON.parse((await s.execute('approve:dev.minih.fixture')).content[0].text);
    assert.equal(response.action, expected);
    assert.equal(asked, 1);
  });
}

test('refuses Minih and Terminal approvals before presenting any selector', async t => {
  const s = await session(t, { select: async () => assert.fail('Agent host approval must not be offered') });
  for (const id of ['org.hmini.agent', 'com.apple.Terminal']) {
    assert.equal(JSON.parse((await s.execute(`approve:${id}`)).content[0].text).action, 'decline');
  }
});

test('preserves browser prompt cancellation and headless fail-closed behavior', async t => {
  const s = await session(t, { select: async () => undefined });
  assert.equal(JSON.parse((await s.execute('origin')).content[0].text).action, 'cancel');
  s.ctx.hasUI = false;
  assert.equal(JSON.parse((await s.execute('approve:dev.minih.fixture')).content[0].text).action, 'cancel');
});

for (const stopReason of ['stop', 'aborted', 'error']) {
  test(`sends correct turn cleanup for ${stopReason}`, async t => {
    const s = await session(t);
    await s.execute('first');
    await s.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason }] }, s.ctx);
    const ended = s.entries().find(entry => entry.name === 'turn_ended');
    assert.equal(ended.args.hook_event_name, stopReason === 'stop' ? 'Stop' : 'Interrupt');
    assert.equal(ended.args.session_id, 'fixture-session');
    assert.equal(ended.args.turn_id, s.entries().find(entry => entry.name === 'js').meta['x-codex-turn-metadata'].turn_id);
    await assert.rejects(s.execute('outside-turn'), /active Pi agent turn/);
  });
}

test('retries failed original cleanup before allowing the next turn', async t => {
  const s = await session(t, { id: 'retry-cleanup' });
  await s.execute('first');
  await s.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, s.ctx);
  assert.match(s.notices.at(-1).message, /cleanup is pending/);
  await s.handlers.get('agent_start')({}, s.ctx);
  await s.execute('next');
  const names = s.entries().filter(entry => entry.name).map(entry => entry.name);
  assert.deepEqual(names, ['js', 'turn_ended', 'turn_ended', 'js']);
});

test('explicitly rejects target picking and reaches private Stop for a pending call', async t => {
  const s = await session(t);
  await s.commands.get('lcu').handler('pick', s.ctx);
  assert.match(s.notices.at(-1).message, /target picking is unavailable/);
  assert.deepEqual(s.commands.get('lcu').getArgumentCompletions(''), [{ value: 'stop', label: 'Stop active Computer Use' }]);
  const pending = s.execute('pending');
  await s.waitFor(entries => entries.some(entry => entry.args?.code === 'pending'));
  await s.commands.get('lcu').handler('stop', s.ctx);
  assert.equal((await pending).content[0].text, 'Stopped by original control.');
  assert.deepEqual(s.entries().filter(entry => entry.event === 'control').map(entry => entry.request.type), ['status', 'stop']);
});

test('forwards cancellation and closes the fixture child on shutdown', async t => {
  const s = await session(t);
  const abort = new AbortController();
  const pending = s.execute('pending', abort.signal);
  const rejected = assert.rejects(pending);
  await s.waitFor(entries => entries.some(entry => entry.args?.code === 'pending'));
  abort.abort();
  await rejected;
  await s.handlers.get('session_shutdown')();
  const pid = s.entries().find(entry => entry.event === 'started').pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('does not invent an identity when the host session API is unavailable', async t => {
  const edge = fixtureEnvironment();
  const host = fakeApi('');
  t.after(async () => {
    try { await host.handlers.get('session_shutdown')?.(); } finally { edge.restore(); }
  });
  await extension(host.api);
  await assert.rejects(host.handlers.get('before_agent_start')({ systemPrompt: 'base' }, host.ctx), /real Minih session ID/);
  assert.equal(edge.entries().filter(entry => entry.name === 'js').length, 0);
});

test('loads the packaged bundle in an isolated directory without node_modules', async t => {
  const edge = fixtureEnvironment();
  t.after(() => edge.restore());
  const directory = join(edge.directory, 'installed');
  mkdirSync(join(directory, 'agent'), { recursive: true });
  cpSync(new URL('../agent/index.mjs', import.meta.url), join(directory, 'agent/index.mjs'));
  cpSync(new URL('../main.cjs', import.meta.url), join(directory, 'main.cjs'));
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const packaged = await import(pathToFileURL(join(directory, manifest.contributes.agentExtensions[0])).href);
  const host = fakeApi('packaged-session');
  await packaged.default(host.api);
  try {
    const prompt = await host.handlers.get('before_agent_start')({ systemPrompt: 'base', systemPromptOptions: {} }, host.ctx);
    assert.match(prompt.systemPrompt, /Fixture computer-use instructions/);
    await host.handlers.get('agent_start')({}, host.ctx);
    const result = await host.tools.get('js').execute('packaged-call', { code: 'image' }, undefined, undefined, host.ctx);
    assert.equal(result.content[1].data, PNG);
  } finally {
    await host.handlers.get('session_shutdown')();
  }
});

test('bounds cold startup and closes the child before Desktop retires the factory', async t => {
  const edge = fixtureEnvironment();
  const argv = JSON.parse(process.env.LCU_MCP_COMMAND);
  process.env.LCU_MCP_COMMAND = JSON.stringify([...argv, 'wait-before-connect']);
  const host = fakeApi();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = extension(host.api);
  const settled = assert.rejects(pending, /LCU runtime startup timed out/);
  let pid;
  try {
    await edge.waitFor(entries => entries.some(entry => entry.event === 'waiting-for-initialize'));
    pid = edge.entries().find(entry => entry.event === 'started').pid;
    t.mock.timers.tick(STARTUP_TIMEOUT_MS);
    t.mock.timers.reset();
    await settled;
    await edge.waitFor(entries => entries.some(entry => entry.event === 'exited'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(host.tools.size, 0);
  } finally {
    t.mock.timers.reset();
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await settled;
    await host.handlers.get('session_shutdown')?.();
    edge.restore();
  }
});
