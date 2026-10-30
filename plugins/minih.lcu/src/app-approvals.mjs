import { nativeAppApprovalOptions, nativeAppApprovalResponse } from '../vendor/lcu/adapters/client.mjs';
import { runLcuApps } from './lcu-apps.mjs';

/** Read the authoritative inventory each time; never cache permanent grants past revocation. */
async function approvedApps(command, signal) {
  const raw = await runLcuApps(command, ['--json'], signal);
  let inventory;
  try { inventory = JSON.parse(raw); }
  catch { throw new Error('Cannot read LCU app approvals: its inventory is not valid JSON. No approval was reused.'); }
  if (!Array.isArray(inventory?.apps) || inventory.apps.some(app =>
    !app || typeof app.bundleId !== 'string' || typeof app.blocked !== 'boolean')) {
    throw new Error('Cannot read LCU app approvals: invalid app inventory. No approval was reused.');
  }
  return new Set(inventory.apps.filter(app => !app.blocked).map(app => app.bundleId));
}

const rememberedResponse = (params, scope) => ({
  ...nativeAppApprovalResponse(params, scope), content: { source: 'computer-use-persisted-state' },
});

/** A single Minih session owns temporary grants; LCU owns permanent storage and owner authentication. */
export function createAppApprovals(command) {
  const sessionApps = new Set();
  const queued = new Map();
  const active = new Set();
  const owner = new AbortController();

  async function decide(params, request, ctx, signal) {
    signal.throwIfAborted();
    const app = request.resource;
    // Pass only exact bundle identities to app management, never paths, names or CLI switches.
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(app)) {
      throw new Error('Cannot remember LCU approval: the runtime did not supply an exact app bundle identifier.');
    }
    const supports = scope => request.choices.some(choice => choice.value === scope);
    if (supports('always') && (await approvedApps(command, signal)).has(app)) {
      signal.throwIfAborted();
      return rememberedResponse(params, 'always');
    }
    if (supports('session') && sessionApps.has(app)) return rememberedResponse(params, 'session');
    if (!ctx.hasUI || typeof ctx.ui?.select !== 'function') return { action: 'cancel' };

    const subtitle = params._meta?.subtitle;
    const title = [request.message, typeof subtitle === 'string' ? subtitle : '',
      supports('always') ? 'Always allow is shared across LCU sessions and may ask for Touch ID or your password.' : '']
      .filter(Boolean).join('\n\n');
    const label = await ctx.ui.select(title, request.choices.map(choice => choice.label), { signal });
    signal.throwIfAborted();
    const value = request.choices.find(choice => choice.label === label)?.value ?? 'cancel';
    if (value === 'always') {
      ctx.ui.notify('Confirm the permanent LCU app approval with Touch ID or your password. Cancelling will not grant access.', 'info');
      try {
        await runLcuApps(command, ['allow', app], signal);
        if (!(await approvedApps(command, signal)).has(app)) {
          throw new Error('LCU did not report the app in its saved approval inventory.');
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new Error(`Cannot save permanent LCU approval for ${app}: ${error.message}. The app was not accepted for this request.`);
      }
    } else if (value === 'session') {
      sessionApps.add(app);
    }
    signal.throwIfAborted();
    return nativeAppApprovalResponse(params, value);
  }

  return {
    handle(params, { signal, ctx }) {
      const request = nativeAppApprovalOptions(params);
      if (!request) return Promise.resolve({ action: 'cancel' });
      const owned = AbortSignal.any([signal, owner.signal]);
      const previous = queued.get(request.resource);
      const run = (async () => {
        // A previous request reports its own error. A queued request re-evaluates
        // current state rather than inheriting that failure or an Allow-once answer.
        if (previous) await previous.catch(() => {});
        return decide(params, request, ctx, owned);
      })();
      queued.set(request.resource, run);
      active.add(run);
      return run.finally(() => {
        active.delete(run);
        if (queued.get(request.resource) === run) queued.delete(request.resource);
      });
    },
    async close() {
      owner.abort();
      sessionApps.clear();
      await Promise.allSettled([...active]);
    },
  };
}
