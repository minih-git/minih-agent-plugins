import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TIMEOUT_SECONDS = 90;
export const MAX_TIMEOUT_SECONDS = 100;
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const operations = new AsyncLocalStorage();

export function validateHost(host) {
  if (typeof host !== 'string' || !host || host.length > 1024 || host.startsWith('-') || !/^[A-Za-z0-9_.@:[\]%+-]+$/.test(host)) {
    throw new Error('host must be an SSH alias, hostname, IPv6 address, or user@host; SSH options and whitespace are forbidden');
  }
  return host;
}

function validateParameters(name, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Tool arguments must be an object');
  validateHost(params.host);
  if (name === 'ssh-bash') {
    if (typeof params.command !== 'string' || !params.command.trim() || params.command.includes('\0')) throw new Error('command must be a nonempty string without NUL');
    if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout < 1 || params.timeout > MAX_TIMEOUT_SECONDS)) {
      throw new Error(`timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds`);
    }
    return;
  }
  if (typeof params.path !== 'string' || !params.path.trim() || params.path.includes('\0')) throw new Error('path must be a nonempty remote path without NUL');
  if (name === 'ssh-read') {
    for (const key of ['offset', 'limit']) {
      if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || params[key] < 1 || params[key] > 1000000000)) {
        throw new Error(`${key} must be an integer between 1 and 1000000000`);
      }
    }
  } else if (name === 'ssh-write') {
    if (typeof params.content !== 'string') throw new Error('content must be a string');
    if (Buffer.byteLength(params.content) > MAX_WRITE_BYTES) throw new Error('content exceeds the 8 MiB write limit');
  } else if (name === 'ssh-edit') {
    if (!Array.isArray(params.edits) || !params.edits.length) throw new Error('edits must contain at least one replacement');
    for (const edit of params.edits) {
      if (!edit || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' || (edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean')) {
        throw new Error('Each edit needs nonempty oldText, string newText, and optional boolean replaceAll');
      }
    }
  }
}

export function operationState() {
  const operation = operations.getStore();
  if (!operation) throw new Error('No active remote-tools operation');
  operation.signal.throwIfAborted();
  return operation.state;
}

export function waitForLock(pending) {
  const operation = operations.getStore();
  if (!operation) throw new Error('No active remote-tools operation');
  const { signal } = operation;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('SSH operation cancelled'));
    pending.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runTool(tool, params, signal, state, execute) {
  validateParameters(tool.name, params);
  signal?.throwIfAborted();
  const seconds = tool.name === 'ssh-bash' ? params.timeout ?? DEFAULT_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('SSH operation cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`SSH operation timed out after ${seconds}s`)), seconds * 1000);
  const operation = { signal: controller.signal, state, deadline: Date.now() + seconds * 1000 };
  try {
    return await operations.run(operation, execute);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function sshExec(host, command, options = {}) {
  validateHost(host);
  if (typeof command !== 'string' || command.includes('\0')) throw new Error('Invalid SSH command');
  const operation = operations.getStore();
  const signals = [...new Set([operation?.signal, options.signal].filter(Boolean))];
  for (const signal of signals) signal.throwIfAborted();
  const seconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TIMEOUT_SECONDS) throw new Error('Invalid SSH timeout');
  const remaining = Math.min(seconds * 1000, operation ? operation.deadline - Date.now() : Infinity);
  if (remaining <= 0) throw new Error('SSH operation timed out');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '--', host, command];
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    const stdout = [];
    const stderr = [];
    let captured = 0;
    let failure;
    let settled = false;
    let killTimer;
    let settleTimer;
    let timer;
    const listeners = [];

    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    };
    const finish = (error, exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal: exitSignal });
    };
    const stop = (error) => {
      if (settled || failure) return;
      failure = error instanceof Error ? error : new Error(String(error));
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 300);
      settleTimer = setTimeout(() => {
        kill('SIGKILL');
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish(failure);
      }, 1200);
    };
    const receive = (destination, callback, data) => {
      if (settled || failure) return;
      if (options.capture !== false) {
        captured += data.length;
        if (captured > MAX_CAPTURE_BYTES) { stop(new Error('SSH output exceeds the 16 MiB capture limit')); return; }
        destination.push(data);
      }
      try { callback?.(data); } catch (error) { stop(error); }
    };
    child.stdout.on('data', data => receive(stdout, options.onStdoutData, data));
    child.stderr.on('data', data => receive(stderr, options.onStderrData, data));
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stop(error); });
    child.on('error', error => finish(error));
    child.on('close', (code, exitSignal) => finish(failure, code, exitSignal));
    timer = setTimeout(() => stop(new Error(`SSH operation timed out after ${Math.ceil(remaining / 1000)}s`)), remaining);
    for (const signal of signals) {
      const listener = () => stop(new Error(signal.reason?.message || 'SSH operation cancelled'));
      listeners.push([signal, listener]);
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    }
    if (!failure) child.stdin.end(options.stdin);
  });
}
