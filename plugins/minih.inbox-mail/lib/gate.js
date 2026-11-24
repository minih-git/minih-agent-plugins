"use strict";

/**
 * The plugin's own connection budget.
 *
 * The host lets one plugin hold eight TCP connections, and this plugin has no
 * account limit any more, so "one socket per mailbox" cannot be the design: five
 * hundred mailboxes would ask the host for five hundred sockets. Every session
 * this plugin opens — a poll, a message body, a flag change — goes through one
 * gate, and the gate never lets more than `limit` of them exist at once.
 *
 * The gate is a queue, not a semaphore with a timeout: a waiter is woken as soon
 * as a slot frees, and `run` settles with exactly what its function settled with.
 * Four is the default because it keeps a whole polling round inside half of the
 * host's ceiling, which leaves room for the app's own work and for a body fetch
 * that arrives while a round is running.
 */

const DEFAULT_LIMIT = 4;

function createGate(limit = DEFAULT_LIMIT) {
  const slots = Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT);
  let active = 0;
  const waiting = [];

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    /** How many sessions are open right now, for tests and for logging. */
    get active() {
      return active;
    },

    get waiting() {
      return waiting.length;
    },

    /** Run `fn` in a slot, queueing until one frees up. */
    run(fn) {
      return new Promise((resolve, reject) => {
        const start = () => {
          active += 1;
          Promise.resolve()
            .then(fn)
            .then(
              (value) => {
                release();
                resolve(value);
              },
              (error) => {
                release();
                reject(error);
              },
            );
        };
        if (active < slots) start();
        else waiting.push(start);
      });
    },
  };
}

module.exports = { DEFAULT_LIMIT, createGate };