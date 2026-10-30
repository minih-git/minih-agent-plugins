import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = fileURLToPath(new URL('./fixtures/mcp.mjs', import.meta.url));
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';

export function fixtureEnvironment() {
  const directory = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'lcu-test-'));
  const trace = join(directory, 'trace.jsonl');
  writeFileSync(trace, '');
  const values = { LCU_MCP_COMMAND: JSON.stringify([process.execPath, fixture, trace]),
    LCU_DIAGNOSTIC_LOG: '0', LCU_SURFACE_CACHE: '0', LCU_APPROVED_ORIGINS: undefined,
    LCU_ALLOW_AGENT_HOST_APPROVAL: undefined };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const entries = () => readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return {
    directory, trace, entries,
    async waitFor(predicate) {
      if (predicate(entries())) return entries();
      let watcher;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          const check = () => { if (predicate(entries())) resolve(); };
          watcher = watch(trace, check);
          timer = setTimeout(() => reject(new Error('MCP fixture synchronization timed out')), 5000);
          check();
        });
      } finally {
        watcher?.close();
        clearTimeout(timer);
      }
      return entries();
    },
    restore() {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function fakeApi(sessionId = 'fixture-session', select = async (_message, options) => options[0]) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notices = [];
  const api = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    model: { id: 'fixture-model' }, hasUI: true,
    ui: { select, notify: (message, level) => notices.push({ message, level }) },
  };
  return { api, ctx, handlers, tools, commands, notices };
}
