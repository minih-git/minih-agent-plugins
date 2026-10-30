import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import extension from '../agent/index.mjs';
import { fakeApi, fixtureEnvironment } from './helpers.mjs';

async function acceptance(t) {
  const edge = fixtureEnvironment();
  const hosts = [];
  t.after(async () => {
    try { await Promise.all(hosts.map(host => host.handlers.get('session_shutdown')?.())); }
    finally { edge.restore(); }
  });
  const open = async (select, id = `session-${hosts.length}`) => {
    const host = fakeApi(id, select);
    hosts.push(host);
    await extension(host.api);
    await host.handlers.get('before_agent_start')({ systemPrompt: 'base' }, host.ctx);
    await host.handlers.get('agent_start')({}, host.ctx);
    return {
      ...host,
      execute: async (code = 'approve:dev.minih.fixture', signal) => {
        const result = await host.tools.get('js').execute('approval-call', { code }, signal, undefined, host.ctx);
        return JSON.parse(result.content[0].text);
      },
    };
  };
  return { ...edge, open, store: `${edge.trace}.apps.json`, control: `${edge.trace}.apps-control.json` };
}
const choose = label => async (_title, options) => {
  assert.ok(options.includes(label), `Original runtime must offer ${label}`);
  return label;
};

test('Always allow saves the canonical LCU grant and survives a new extension instance', async t => {
  const f = await acceptance(t);
  let prompts = 0;
  const host = await f.open(async (...args) => { prompts++; return choose('Always allow')(...args); });
  assert.equal((await host.execute()).action, 'accept');
  assert.ok(existsSync(f.store), 'Always allow must be persisted, not just forwarded in metadata');
  assert.deepEqual(JSON.parse(readFileSync(f.store, 'utf8')).approvedBundleIdentifiers, ['dev.minih.fixture']);
  assert.equal((await host.execute()).action, 'accept');
  assert.equal(prompts, 1, 'The same app must not prompt again after saving');
  const reloaded = await f.open(async () => assert.fail('A saved grant must survive extension reload'));
  assert.equal((await reloaded.execute()).action, 'accept');
  assert.equal(f.entries().filter(entry => entry.event === 'apps_owner_authenticated').length, 1);
});

test('session approval is reused across turns but never leaks to another session', async t => {
  const f = await acceptance(t);
  let prompts = 0;
  const host = await f.open(async (...args) => { prompts++; return choose('Allow for this session')(...args); });
  assert.equal((await host.execute())._meta.persist, 'session');
  assert.equal((await host.execute()).action, 'accept');
  await host.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, host.ctx);
  await host.handlers.get('agent_start')({}, host.ctx);
  assert.equal((await host.execute()).action, 'accept');
  assert.equal(prompts, 1);
  assert.equal(existsSync(f.store), false);
  const other = await f.open(choose('Decline'));
  assert.equal((await other.execute()).action, 'decline');
});

for (const choice of ['Allow once', 'Decline', undefined]) {
  test(`${choice ?? 'dismiss'} does not save or reuse a grant`, async t => {
    const f = await acceptance(t);
    let prompts = 0;
    const host = await f.open(async () => { prompts++; return choice; });
    await host.execute();
    await host.execute();
    assert.equal(prompts, 2);
    assert.equal(existsSync(f.store), false);
    assert.equal(f.entries().filter(entry => entry.event === 'apps_owner_authenticated').length, 0);
  });
}

test('reads fresh canonical state so external revocation takes effect immediately', async t => {
  const f = await acceptance(t);
  writeFileSync(f.store, JSON.stringify({ approvedBundleIdentifiers: ['dev.minih.fixture', 'dev.other.app'], retained: true }));
  let prompts = 0;
  const host = await f.open(async () => { prompts++; return 'Decline'; });
  assert.equal((await host.execute()).action, 'accept');
  assert.equal(prompts, 0);
  writeFileSync(f.store, JSON.stringify({ approvedBundleIdentifiers: ['dev.other.app'], retained: true }));
  assert.equal((await host.execute()).action, 'decline');
  assert.equal(prompts, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.store, 'utf8')), { approvedBundleIdentifiers: ['dev.other.app'], retained: true });
});

test('a permanent grant cannot override a runtime that offers session scope only', async t => {
  const f = await acceptance(t);
  writeFileSync(f.store, JSON.stringify({ approvedBundleIdentifiers: ['dev.minih.fixture'] }));
  const host = await f.open(choose('Decline'));
  assert.equal((await host.execute('approve-session:dev.minih.fixture')).action, 'decline');
});

test('concurrent same-app requests reuse a newly saved grant without upgrading Allow once', async t => {
  const f = await acceptance(t);
  let prompts = 0;
  const host = await f.open(async () => { prompts++; return 'Always allow'; });
  const results = await Promise.all([host.execute(), host.execute()]);
  assert.ok(results.every(response => response.action === 'accept'));
  assert.equal(prompts, 1);
  assert.equal(f.entries().filter(entry => entry.event === 'apps_owner_authenticated').length, 1);
});

for (const control of [{ fail: 'allow' }, { skipWrite: true }]) {
  test(`save failure is observable and never pretends the app was remembered: ${JSON.stringify(control)}`, async t => {
    const f = await acceptance(t);
    writeFileSync(f.control, JSON.stringify(control));
    const host = await f.open(choose('Always allow'));
    await assert.rejects(host.execute(), /save|persist|remember/i);
    assert.equal(existsSync(f.store), false);
  });
}

test('corrupt approval inventory fails closed without presenting or granting permanent approval', async t => {
  const f = await acceptance(t);
  writeFileSync(f.control, JSON.stringify({ invalidList: true }));
  const host = await f.open(async () => assert.fail('Invalid approval state must not be used'));
  await assert.rejects(host.execute(), /approval|inventory|list/i);
  assert.equal(existsSync(f.store), false);
});

test('protected hosts remain blocked even when the canonical inventory contains them', async t => {
  const f = await acceptance(t);
  writeFileSync(f.store, JSON.stringify({ approvedBundleIdentifiers: ['org.hmini.agent', 'com.apple.Terminal'] }));
  const host = await f.open(async () => assert.fail('A protected host must never ask for permission'));
  for (const app of ['org.hmini.agent', 'com.apple.Terminal']) {
    assert.equal((await host.execute(`approve:${app}`)).action, 'decline');
  }
  assert.equal(f.entries().some(entry => entry.event === 'apps_command'), false);
});

test('rejects paths, CLI switches and shell-shaped app identities before executing a command', async t => {
  const f = await acceptance(t);
  const host = await f.open(async () => assert.fail('Invalid app identities must not request consent'));
  for (const app of ['--allow-all', '/Applications/Calculator.app', 'dev.app;touch /tmp/unsafe', 'Calculator']) {
    await assert.rejects(host.execute(`approve:${app}`), /exact app bundle identifier/);
  }
  assert.equal(f.entries().some(entry => entry.event === 'apps_command'), false);
});

test('cancelling owner authentication kills the helper tree and saves nothing', async t => {
  const f = await acceptance(t);
  writeFileSync(f.control, JSON.stringify({ waitForAuth: true }));
  const host = await f.open(choose('Always allow'));
  const abort = new AbortController();
  const pending = host.execute(undefined, abort.signal);
  const rejected = assert.rejects(pending);
  let wait;
  try {
    await f.waitFor(entries => entries.some(entry => entry.event === 'apps_auth_wait'));
    wait = f.entries().find(entry => entry.event === 'apps_auth_wait');
    abort.abort();
    await rejected;
    await host.handlers.get('session_shutdown')();
    assert.throws(() => process.kill(wait.pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(wait.helperPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(f.store), false);
  } finally {
    if (wait) for (const pid of [wait.pid, wait.helperPid]) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});
