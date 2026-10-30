// A protocol-only edge fixture. Never loads LCU, the ChatGPT app, or a real desktop.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.argv[3] === 'apps') {
  await import('./apps.mjs');
  process.exit(0);
}

const trace = process.argv[2];
const record = entry => appendFileSync(trace, JSON.stringify(entry) + '\n');
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';
const server = new Server({ name: 'minih-lcu-contract-fixture', version: '1' }, {
  capabilities: { tools: {} }, instructions: 'Fixture computer-use instructions.',
});
let active;
let finishPending;
const cleanupAttempts = new Map();
record({ event: 'started', pid: process.pid });
process.on('exit', () => record({ event: 'exited', pid: process.pid }));
process.on('SIGTERM', () => process.exit(0));

if (process.env.LCU_MAC_CONTROL_SOCKET) {
  const control = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]);
      record({ event: 'control', request });
      if (!active || request.session_id !== active.session_id || request.turn_id !== active.turn_id) {
        socket.end(JSON.stringify({ ok: false, error: 'active turn mismatch' }) + '\n');
      } else if (request.type === 'status') {
        socket.end(JSON.stringify({ ok: true, result: { computerUse: { activeApplications: [
          { id: 'fixture', name: 'Fixture', bundleIdentifier: 'dev.minih.fixture', bundleURL: '' },
        ] } } }) + '\n');
      } else if (request.type === 'stop' && request.app === 'dev.minih.fixture') {
        finishPending?.();
        socket.end(JSON.stringify({ ok: true, result: { accepted: true } }) + '\n');
      } else {
        socket.end(JSON.stringify({ ok: false, error: 'unknown control' }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(process.env.LCU_MAC_CONTROL_SOCKET, resolve);
  });
  control.unref();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'js', description: 'Fixture original js.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
  } },
  { name: 'js_reset', description: 'Fixture original reset.', inputSchema: { type: 'object', properties: {} } },
  { name: 'turn_ended', description: 'Host only.', inputSchema: { type: 'object' } },
  { name: 'js_add_node_module_dir', description: 'Host only.', inputSchema: { type: 'object' } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args, _meta } = request.params;
  record({ name, args, meta: _meta });
  if (name === 'turn_ended') {
    const count = cleanupAttempts.get(args.session_id) ?? 0;
    cleanupAttempts.set(args.session_id, count + 1);
    if (args.session_id === 'retry-cleanup' && count === 0) {
      return { isError: true, content: [{ type: 'text', text: 'turn-ended handlers timed out' }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  }
  if (name === 'js_reset') return { content: [{ type: 'text', text: 'reset' }] };
  active = _meta['x-codex-turn-metadata'];
  if (args.code === 'image') return { content: [
    { type: 'text', text: 'Fixture screenshot.' }, { type: 'image', mimeType: 'image/png', data: PNG },
  ] };
  if (args.code === 'error') return { isError: true, content: [{ type: 'text', text: 'Original fixture error.' }] };
  if (args.code === 'pending') {
    return new Promise(resolve => {
      finishPending = () => resolve({ content: [{ type: 'text', text: 'Stopped by original control.' }] });
      extra.signal.addEventListener('abort', () => {
        record({ event: 'cancelled' });
        resolve({ content: [{ type: 'text', text: 'cancelled' }] });
      }, { once: true });
    });
  }
  if (args.code.startsWith('approve:') || args.code.startsWith('approve-session:')) {
    const sessionOnly = args.code.startsWith('approve-session:');
    const app = args.code.slice(args.code.indexOf(':') + 1);
    const response = await server.elicitInput({
      message: `Allow Computer Use to use ${app}?`,
      requestedSchema: { type: 'object', properties: {} },
      _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call',
        persist: sessionOnly ? ['session'] : ['session', 'always'], tool_name: 'get_app_state', tool_params: { app } },
    });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }
  if (args.code === 'origin') {
    const response = await server.elicitInput({
      message: 'Allow browser access to https://fixture.invalid?',
      requestedSchema: { type: 'object', properties: {} },
    });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }
  return { content: [{ type: 'text', text: args.code }] };
});
if (process.argv[3] === 'wait-before-connect') {
  record({ event: 'waiting-for-initialize' });
  process.stdin.resume();
  await new Promise(() => {});
}
await server.connect(new StdioServerTransport());
