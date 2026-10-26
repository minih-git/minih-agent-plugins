"use strict";

/**
 * In-flight translation jobs, and the answers the renderer polls for.
 *
 * Why a job store at all: a `plugin.call` from the host renderer has to answer
 * within 2s (`RENDERER_CALL_TIMEOUT_MS`), while one completion may take up to
 * 90s. So `translate` starts the work and answers with an id, and the renderer
 * polls `poll` for the settled result. Nothing here touches the host API, so
 * the state machine is unit tested with a controlled clock.
 */

/** Kept jobs; older ones are dropped as new ones start. */
const MAX_JOBS = 8;
/** How long a settled job still answers a poll, for a late or repeated one. */
const JOB_TTL_MS = 5 * 60_000;

class JobStore {
  constructor({ now = Date.now, maxJobs = MAX_JOBS, ttlMs = JOB_TTL_MS } = {}) {
    this.now = now;
    this.maxJobs = maxJobs;
    this.ttlMs = ttlMs;
    /** @type {Map<string, {id: string, state: string, startedAt: number, settledAt: number|null}>} */
    this.jobs = new Map();
    this.seq = 0;
  }

  /** A running job; cancelling it drops whatever the model answers later. */
  start(meta = {}) {
    this.prune();
    const id = `job-${++this.seq}`;
    this.jobs.set(id, {
      id,
      state: "running",
      startedAt: this.now(),
      settledAt: null,
      ...meta,
    });
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.jobs.keys().next();
      if (oldest.done) break;
      this.jobs.delete(oldest.value);
    }
    return id;
  }

  /**
   * Record the outcome of a job. A cancelled job keeps its state: the answer
   * arrived after the reader walked away, and nothing should resurface.
   */
  settle(id, patch) {
    const job = this.jobs.get(id);
    if (!job || job.state === "cancelled") return false;
    Object.assign(job, patch, { settledAt: this.now() });
    return true;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === "running") {
      job.state = "cancelled";
      job.settledAt = this.now();
    }
    return true;
  }

  /** Cancel everything in flight — what an unload does. */
  cancelAll() {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  /** `{ state: "done" | "error", ... }` and friends; `null` for an unknown id. */
  read(id) {
    return this.jobs.get(id) ?? null;
  }

  get size() {
    return this.jobs.size;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      const at = job.settledAt ?? job.startedAt;
      if (at < cutoff) this.jobs.delete(id);
      else break;
    }
  }
}

module.exports = { JOB_TTL_MS, MAX_JOBS, JobStore };