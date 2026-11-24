import assert from "node:assert/strict";
import { test } from "node:test";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createGate } = require("../lib/gate.js");

/**
 * The gate is what keeps a plugin with no account limit inside the host's
 * eight-connection ceiling, so its rules are asserted directly: at most `limit`
 * bodies run at once, a waiter starts as soon as a slot frees, and a failing
 * body gives its slot back.
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("no more than the limit run at once, and the rest queue", async () => {
  const gate = createGate(2);
  const running = [];
  let peak = 0;
  const jobs = Array.from({ length: 5 }, (_, index) =>
    gate.run(async () => {
      running.push(index);
      peak = Math.max(peak, running.length);
      await tick();
      await tick();
      running.splice(running.indexOf(index), 1);
      return index;
    }),
  );
  const results = await Promise.all(jobs);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2, "the third body waited for a slot");
  assert.equal(gate.active, 0);
});

test("a failing body releases its slot instead of leaking it", async () => {
  const gate = createGate(1);
  await assert.rejects(
    gate.run(async () => {
      throw Object.assign(new Error("the mail server refused"), { code: "CONNECT_FAILED" });
    }),
    (error) => error.code === "CONNECT_FAILED",
  );
  assert.equal(gate.active, 0);
  // The next body still runs, which it would not if the slot had been lost.
  assert.equal(await gate.run(async () => "ok"), "ok");
});

test("the queue is served in order", async () => {
  const gate = createGate(1);
  const order = [];
  const jobs = [1, 2, 3].map((value) =>
    gate.run(async () => {
      order.push(value);
      await tick();
    }),
  );
  await Promise.all(jobs);
  assert.deepEqual(order, [1, 2, 3]);
});