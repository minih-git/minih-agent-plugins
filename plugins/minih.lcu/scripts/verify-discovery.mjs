// First-turn acceptance through DesktopAgentRuntime, ToolSearch and a local SSE provider.
// External model and desktop boundaries are fixtures; no running app is attached.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureEnvironment, PNG } from '../tests/helpers.mjs';

const desktop = process.argv[2] ?? process.env.MINIH_DESKTOP_ROOT;
if (!desktop) throw new Error('Usage: node scripts/verify-discovery.mjs /absolute/path/to/Minih-Agent-Desktop [installed-plugin]');
const root = process.argv[3] ? resolve(process.argv[3]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'lcu-discovery-'));
const edge = fixtureEnvironment();
const requests = [];
const events = [];
const queries = ['LCU', 'cua_repl', 'js'];
const calls = [...queries.map(query => ({ name: 'ToolSearch', args: { query } })),
  { name: 'js', args: { code: 'image' } }];
let runtime;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  const call = calls[requests.length - 1];
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-call-${requests.length}`,
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
    : { role: 'assistant', content: 'Fixture screenshot received.' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta,
    finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const fetch = globalThis.fetch;
try {
  const output = join(work, 'runtime.mjs');
  await build({
    absWorkingDir: desktop, entryPoints: [join(desktop, 'packages/agent-runtime/src/runtime.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { PI_BUNDLED_NODE: 'true' },
    banner: { js: "import { createRequire as minihRuntimeRequire } from 'node:module'; const require = minihRuntimeRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  const { DesktopAgentRuntime } = await import(pathToFileURL(output).href);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(typeof url === 'string' || url instanceof URL ? url : url.url).origin, origin,
      'Acceptance must never call a real provider');
    return fetch(url, options);
  };
  runtime = new DesktopAgentRuntime({
    host: {
      call: async () => ({}),
      onNotification: () => () => {},
    },
    sessionId: 'lcu-first-turn', projectPath: edge.directory, mode: 'agent', thinkingLevel: 'off',
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    provider: {
      id: 'fixture', name: 'Local SSE fixture', apiKey: '', authKind: 'none',
      modelConfig: {
        source: 'generic', name: 'Vision fixture', baseUrl: `${origin}/v1`, reasoning: false,
        input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000, maxTokens: 2_000,
      },
      baseUrl: `${origin}/v1`, modelId: 'fixture', supportsReasoning: false, supportedThinkingLevels: ['off'],
    },
    commandShell: { id: 'bash', label: 'Bash', dialect: 'posix', available: true, isDefault: true },
    trustedExtensions: [{ id: 'minih.lcu', entry: join(root, 'agent/index.mjs'), root,
      label: 'LCU Computer Use', source: 'plugin' }],
    onEvent: ({ event }) => events.push(event),
  });
  await runtime.loadTrustedExtensions();
  assert.equal(runtime.getTrustedExtensionReports()[0].state, 'loaded');
  await runtime.prompt('Use LCU to screenshot the fixture window without clicking or typing.');
  assert.equal(requests.length, calls.length + 1, 'All scripted model rounds must complete');
  const firstPrompt = requests[0].messages.filter(message => ['system', 'developer'].includes(message.role))
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  assert.match(firstPrompt, /^- js:.*LCU/im, 'The first request must advertise the LCU js tool, before any search');
  assert.match(firstPrompt, /^- js_reset:.*LCU/im, 'The reset tool must also appear in the first directory');
  assert.match(firstPrompt, /ToolSearch[^\n]*LCU/, 'First-turn guidance must map LCU to tool discovery');
  assert.match(firstPrompt, /Fixture computer-use instructions\./, 'Original instructions must be preserved');
  const names = new Map(events.filter(event => event.type === 'tool_start')
    .map(event => [event.toolCallId, event.toolName]));
  const searchResults = events.filter(event => event.type === 'tool_end' && names.get(event.toolCallId) === 'ToolSearch');
  assert.equal(searchResults.length, queries.length);
  for (let i = 0; i < queries.length; i++) {
    const result = searchResults[i].result;
    assert.equal(searchResults[i].isError, false);
    assert.ok(result.details.matches.includes('js'), `${queries[i]} must find js`);
  }
  const screenshot = events.find(event => event.type === 'tool_end' && names.get(event.toolCallId) === 'js');
  assert.equal(screenshot?.isError, false);
  assert.equal(screenshot.result.content[1].data, PNG);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes(PNG), 'Image must reach the fixture model request');
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.ok(edge.entries().some(entry => entry.name === 'js' && entry.args.code === 'image'));
  assert.ok(edge.entries().some(entry => entry.name === 'turn_ended' && entry.args.hook_event_name === 'Stop'));
  assert.ok(!events.some(event => event.type === 'tool_start' && ['Bash', 'Read', 'Grep', 'Glob'].includes(event.toolName)),
    'Discovery must not require shell or filesystem exploration');
  console.log('PASS first-turn runtime: initial tool directory, LCU/cua_repl/js searches, activation, original instructions, js screenshot, provider image delivery and Stop cleanup.');
} finally {
  await runtime?.dispose();
  globalThis.fetch = fetch;
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  edge.restore();
  rmSync(work, { recursive: true, force: true });
}
