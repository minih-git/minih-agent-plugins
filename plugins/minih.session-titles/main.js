"use strict";
const { buildRequest, selectModel, normalizeTitle } = require("./lib/prompt.js");

/** One activation owns subscriptions, per-session serialization and bounded retry state. */
function createTitlePlugin(host) {
  let generation = 0;
  let active = false;
  const running = new Map();
  const attempts = new Map();
  const refreshed = new Map();
  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > 1000) map.delete(map.keys().next().value);
  };

  async function compose(sessionId, fingerprint, token) {
    let modelKey;
    try {
      const settings = await host.plugin.getSettings();
      if (!active || token !== generation || settings.enabled === false || (fingerprint && settings.retitleAfterCompaction === false)) return false;
      const context = await host.session.getAutoTitleContext({
        sessionId, includeMaterial: true,
        ...(fingerprint ? { summaryFingerprint: fingerprint } : {}),
      });
      if (!context || !active || token !== generation) return false;
      const models = await host.models.list();
      if (!active || token !== generation) return false;
      const model = selectModel(models, settings.model, context.modelKey);
      modelKey = model.key;
      const attemptKey = JSON.stringify([sessionId, model.key, settings.thinkingLevel || "off"]);
      if (fingerprint) {
        if (refreshed.get(sessionId) === fingerprint) return false;
      } else {
        const count = attempts.get(attemptKey) || 0;
        if (count >= 3) return false;
        remember(attempts, attemptKey, count + 1);
      }
      const request = buildRequest(context, model, settings.thinkingLevel || "off");
      const result = await host.agent.complete(request);
      if (!active || token !== generation) return false;
      const title = normalizeTitle(result.text);
      if (!title) throw Object.assign(new Error("The model returned no title"), { code: "EMPTY_TITLE" });
      const latest = await host.plugin.getSettings();
      if (!active || token !== generation || latest.enabled === false || (fingerprint && latest.retitleAfterCompaction === false)) return false;
      if (fingerprint && title === context.expectedTitle) {
        remember(refreshed, sessionId, fingerprint);
        return true;
      }
      const written = await host.session.setAutoTitle({
        sessionId, expectedTitle: context.expectedTitle, title,
        ...(fingerprint ? { summaryFingerprint: fingerprint } : {}),
      });
      if (written.updated && fingerprint) remember(refreshed, sessionId, fingerprint);
      console.info("Session title result", { sessionId, modelKey, updated: written.updated });
      return written.updated;
    } catch (error) {
      // The code is useful without logging request text, provider bodies or secrets.
      console.warn("Session title generation failed", { sessionId, modelKey, code: error?.code || error?.errorCode || "COMPLETION_FAILED" });
      return false;
    }
  }

  function start(sessionId, fingerprint) {
    if (!active || typeof sessionId !== "string" || !sessionId || sessionId.startsWith("native-pi:") || sessionId.startsWith("remote:")) return Promise.resolve(false);
    if (running.has(sessionId)) return running.get(sessionId);
    const token = generation;
    // Reserve before any async work to prevent duplicate completions.
    const promise = Promise.resolve().then(() => compose(sessionId, fingerprint, token));
    running.set(sessionId, promise);
    void promise.finally(() => { if (running.get(sessionId) === promise) running.delete(sessionId); });
    return promise;
  }
  const onPrompt = ({ sessionId }) => start(sessionId);
  const onTurnEnded = async ({ sessionId }) => {
    const token = generation;
    const prior = running.get(sessionId);
    if (prior && await prior) return;
    if (token === generation) return start(sessionId);
  };
  const onCompacted = async ({ sessionId, summaryFingerprint }) => {
    const token = generation;
    if (typeof summaryFingerprint !== "string" || !summaryFingerprint) return;
    await running.get(sessionId);
    if (token === generation) return start(sessionId, summaryFingerprint);
  };
  const subscriptions = [["session:promptSent", onPrompt], ["session:turnEnded", onTurnEnded], ["session:compacted", onCompacted]];
  return {
    onLoad() {
      if (active) return;
      active = true;
      generation += 1;
      for (const [name, handler] of subscriptions) host.events.on(name, handler);
    },
    onUnload() {
      active = false;
      generation += 1;
      for (const [name, handler] of subscriptions) host.events.off(name, handler);
      running.clear(); attempts.clear(); refreshed.clear();
    },
  };
}
module.exports = globalThis.pi ? createTitlePlugin(globalThis.pi) : {};
module.exports.createTitlePlugin = createTitlePlugin;
