import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import lcuExtension from '../vendor/lcu/adapters/pi/index.ts';
import { KNOWN_AGENT_HOSTS } from '../vendor/lcu/adapters/host-guard.mjs';
import { createAppApprovals } from './app-approvals.mjs';

// The sidecar's own bundled Node can share this app bundle. Upstream ancestor
// detection deliberately skips that bundle, so name Minih explicitly as well.
KNOWN_AGENT_HOSTS.set('org.hmini.agent', 'Minih-Agent-Desktop');

export const STARTUP_TIMEOUT_MS = 25_000; // Leave cleanup time inside Desktop's 30-second factory budget.
export const DISCOVERY_INSTRUCTIONS = [
  '# LCU Computer Use',
  'LCU desktop automation is available through the registered `js` and `js_reset` tools.',
  'Call ToolSearch with query `LCU` (or the exact tool name `js` / `js_reset`) before invoking an inactive tool.',
  '`cua_repl` in the original runtime instructions refers to these tools, not a separate Minih tool.',
  'Use the registered tools for LCU tasks. Do not search plugin files or install shell commands merely to discover them.',
  'If tools are unavailable, report the extension load error rather than bypassing it with shell-based desktop control.',
  'Original app/site approvals and all runtime instructions still apply.',
].join('\n');

/** A trusted local argv override is supported; no shell expansion is performed. */
export function runtimeCommand({ env = process.env, platform = process.platform, arch = process.arch, home = homedir() } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('LCU Computer Use 0.1 supports only Apple Silicon macOS. No desktop process was started.');
  }
  if (env.LCU_ALLOW_AGENT_HOST_APPROVAL === '1') {
    throw new Error('LCU Computer Use refuses LCU_ALLOW_AGENT_HOST_APPROVAL=1: the agent host must not approve itself.');
  }
  let command = [join(home, '.local/share/lcu/current/bin/lcu')];
  if (env.LCU_MCP_COMMAND) {
    try {
      command = JSON.parse(env.LCU_MCP_COMMAND);
    } catch {
      throw new Error('LCU_MCP_COMMAND must be a JSON argv array, not a shell command.');
    }
  }
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || !part) || !isAbsolute(command[0])) {
    throw new Error('LCU_MCP_COMMAND must be a nonempty string array whose executable path is absolute.');
  }
  try {
    if (!statSync(command[0]).isFile()) throw new Error('not a file');
    accessSync(command[0], constants.X_OK);
  } catch {
    throw new Error(`Cannot start LCU: ${command[0]} is not an executable file. Install the pinned LCU release with --runtime-only, then start a new Minih session. This plugin never installs it automatically.`);
  }
  return command;
}

function requireSession(ctx) {
  const id = ctx.sessionManager?.getSessionId?.();
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('LCU requires a real Minih session ID. Update Minih before using this plugin.');
  }
}

/** Keep the upstream adapter authoritative; translate only Desktop compatibility gaps. */
export default async function minihLcu(pi) {
  const command = runtimeCommand();
  const approvals = createAppApprovals(command);
  const compatible = {
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        description: `LCU computer use (${tool.name === 'js' ? 'desktop automation' : 'runtime reset'}; cua_repl): ${tool.description}`,
      });
    },
    on(event, handler) {
      if (event === 'before_agent_start') {
        pi.on(event, async (payload, ctx) => {
          requireSession(ctx);
          // Desktop discards in-place systemPromptOptions mutations. Use Pi's
          // supported legacy return path so original instructions reach the model.
          const result = await handler({ ...payload, systemPromptOptions: undefined }, ctx);
          return { ...result, systemPrompt: `${result.systemPrompt}\n\n${DISCOVERY_INSTRUCTIONS}` };
        });
      } else if (event === 'agent_start') {
        pi.on(event, (payload, ctx) => {
          requireSession(ctx);
          return handler(payload, ctx);
        });
      } else if (event === 'agent_end') {
        pi.on(event, (payload, ctx) => {
          const last = [...payload.messages].reverse().find(message => message.role === 'assistant');
          // An errored agent run is an interruption, not a successful Stop.
          const context = last?.stopReason === 'error' ? { ...ctx, signal: AbortSignal.abort() } : ctx;
          return handler(payload, context);
        });
      } else if (event === 'session_shutdown') {
        pi.on(event, async (payload, ctx) => {
          try { await approvals.close(); } finally { await handler(payload, ctx); }
        });
      } else {
        pi.on(event, handler);
      }
    },
    registerCommand(name, definition) {
      if (name !== 'lcu') return pi.registerCommand(name, definition);
      pi.registerCommand(name, {
        ...definition,
        description: 'Stop active LCU computer use. Target picking is unavailable in Minih.',
        getArgumentCompletions: prefix => [{ value: 'stop', label: 'Stop active Computer Use' }]
          .filter(item => item.value.startsWith(prefix)),
        async handler(args, ctx) {
          if (args.trim() !== 'stop') {
            ctx.ui.notify(args.trim() === 'pick'
              ? 'LCU target picking is unavailable in Minih because its extension editor API is not supported. Name the target in your next message instead.'
              : 'Usage: /lcu stop. Desktop actions still require the original app approvals.', 'warning');
            return;
          }
          return definition.handler(args, ctx);
        },
      });
    },
  };
  const startup = new AbortController();
  const timeout = setTimeout(() => startup.abort(new Error(
    'LCU runtime startup timed out before tool registration. Check the local runtime, then start a new Minih session.',
  )), STARTUP_TIMEOUT_MS);
  try {
    // Desktop snapshots the catalog immediately after loading the extension.
    await lcuExtension(compatible, { command, connectOnLoad: true, startupSignal: startup.signal,
      onNativeApproval: approvals.handle });
  } finally {
    clearTimeout(timeout);
  }
}
