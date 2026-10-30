import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Run the existing LCU CLI without a shell or inherited provider secrets. Own its helper tree. */
export function runLcuApps(command, args, signal) {
  signal.throwIfAborted();
  const operation = `LCU apps ${args[0]}`;
  const timeout = args[0] === 'allow' ? 300_000 : 15_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'apps', ...args], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...getDefaultEnvironment(), LCU_NO_UPDATE_CHECK: '1' },
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let failure;
    let forceKill;
    const kill = how => {
      if (!child.pid) return;
      try { process.kill(-child.pid, how); }
      catch (error) {
        if (error.code !== 'ESRCH') failure = new Error(`${operation}: could not stop its helper process (${error.message})`);
      }
    };
    const stop = error => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      forceKill = setTimeout(() => kill('SIGKILL'), 1000);
      forceKill.unref();
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop(new Error(`${operation} timed out; approval was not confirmed.`)), timeout);
    for (const [stream, append] of [
      [child.stdout, text => { stdout += text; }],
      [child.stderr, text => { stderr += text; }],
    ]) {
      stream.setEncoding('utf8');
      stream.on('data', text => {
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_OUTPUT_BYTES) stop(new Error(`${operation} returned too much output.`));
        else append(text);
      });
    }
    child.once('error', error => { failure = new Error(`${operation} could not start: ${error.message}`); });
    child.once('close', (code, exitSignal) => {
      // The CLI can exit before an authentication helper that ignored SIGTERM.
      // Retire that still-owned process group before clearing the escalation.
      if (failure) kill('SIGKILL');
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${operation} failed (${code ?? exitSignal}): ${stderr.trim().slice(0, 800) || 'No diagnostic was returned.'}`));
      else resolve(stdout);
    });
  });
}
