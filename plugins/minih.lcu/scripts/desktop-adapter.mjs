/**
 * Desktop retires preflight hooks on Stop. Upstream Pi's connect() has no
 * cancellation input, so propagate the owning hook/tool signal to the existing
 * client and close that client on cancellation. Raw vendored files stay intact.
 */
export function desktopAdapter(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`Pinned LCU adaptation no longer matches: ${before}`);
    source = source.replace(before, after);
  };
  replace('connectOnLoad?: boolean;', 'connectOnLoad?: boolean;\n  startupSignal?: AbortSignal;');
  replace('startupSignal?: AbortSignal;', `startupSignal?: AbortSignal;
  onNativeApproval?: (params: unknown, context: { signal: AbortSignal; ctx: ExtensionContext }) => Promise<unknown>;`);
  replace('if (nativeApproval) {', `if (nativeApproval) {
              if (options.onNativeApproval) return options.onNativeApproval(params, { signal, ctx });`);
  replace('return connected().then(() => undefined);', 'return connected(options.startupSignal).then(() => undefined);');
  replace('async function connected() {', 'async function connected(signal?: AbortSignal) {\n    signal?.throwIfAborted();');
  replace('const current = await connected();', 'const current = await connected(signal);');
  replace('async function sessionSurface() {', 'async function sessionSurface(signal?: AbortSignal) {');
  replace('await connected();\n    return surface!;', 'await connected(signal);\n    return surface!;');
  replace('const { instructions } = await sessionSurface();', 'const { instructions } = await sessionSurface(ctx.signal);');
  replace('await candidate.connect();\n        bridge = candidate;', `let onAbort: (() => void) | undefined;
        const retired = new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          await Promise.race([candidate.connect(), retired]);
          signal?.throwIfAborted();
        } catch (error) {
          await candidate.close();
          throw error;
        } finally {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
        bridge = candidate;`);
  return source;
}

/** Make an in-flight initial/restarted transport visible to close() immediately. */
export function desktopClient(source) {
  const before = 'const next = openLink();\n        tools = await start(next);\n        link = next;\n        connected = true;';
  if (source.split(before).length !== 3) throw new Error('Pinned LCU client startup ownership no longer matches');
  source = source.replaceAll(before, `const next = openLink();
        link = next;
        tools = await start(next);
        if (closed) throw new Error('LCU was closed during startup');
        connected = true;`);
  const close = 'closed = true;\n      await settled();\n      const wasConnected = connected;\n      connected = false;\n      try { await link?.client.close(); }';
  if (source.split(close).length !== 2) throw new Error('Pinned LCU client close ownership no longer matches');
  return source.replace(close, `closed = true;
      const wasConnected = connected;
      connected = false;
      try {
        await link?.client.close();
        await settled();
      }`);
}
