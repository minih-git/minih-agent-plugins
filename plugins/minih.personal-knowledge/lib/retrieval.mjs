/**
 * Fusion and ranking (ADR 0001 §6).
 *
 * Lexical and vector channels each contribute their top 50; reciprocal rank
 * fusion `Σ 1 / (60 + rank)` merges them. Graph expansion adds up to 5 typed
 * neighbors per top-10 note at 0.3× the parent score. Archived notes rank at
 * 0.5×, notes past their review window at 0.85×.
 */

const RRF_K = 60;
const CHANNEL_LIMIT = 50;
const EXPANSION_PARENTS = 10;
const EXPANSION_NEIGHBORS = 5;
const EXPANSION_FACTOR = 0.3;
const ARCHIVED_FACTOR = 0.5;
const STALE_FACTOR = 0.85;

/** Reciprocal rank fusion over channels of note keys (best key first). */
export function reciprocalRankFusion(channels) {
  const scores = new Map();
  for (const channel of channels) {
    channel.forEach((key, rank) => {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * `neighbors(key)` returns typed neighbor keys (`project`, `depends_on`,
 * `resolved_by` edges). Parents keep their score; neighbors join at 0.3×.
 */
export function expandWithGraph(fused, neighbors) {
  const expanded = new Map(fused);
  const parents = fused.slice(0, EXPANSION_PARENTS);
  for (const [key, score] of parents) {
    let added = 0;
    for (const neighbor of neighbors(key) ?? []) {
      if (added >= EXPANSION_NEIGHBORS) break;
      if (expanded.has(neighbor)) continue;
      expanded.set(neighbor, score * EXPANSION_FACTOR);
      added += 1;
    }
  }
  return [...expanded.entries()].sort((a, b) => b[1] - a[1]);
}

export function rerank(entries, { archived, stale }) {
  return entries.map(([key, score]) => {
    let factor = 1;
    if (archived(key)) factor *= ARCHIVED_FACTOR;
    if (stale(key)) factor *= STALE_FACTOR;
    return [key, score * factor];
  });
}

/** Compose the per-call `retrieval` block; every state names its reason. */
export function retrievalState({ enabled, vectorReady, reason = null, pendingChunks = 0 }) {
  const state = {
    lexical: "ready",
    vector: enabled ? (vectorReady ? "ready" : "unavailable") : "disabled",
  };
  if (reason) state.reason = reason;
  if (pendingChunks > 0) {
    state.vector = vectorReady ? "partial" : state.vector;
    state.pendingChunks = pendingChunks;
  }
  return state;
}
