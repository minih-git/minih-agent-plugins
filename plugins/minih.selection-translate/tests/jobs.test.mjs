import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JobStore } = require("../lib/jobs.js");

function store(overrides = {}) {
  let clock = 1000;
  const instance = new JobStore({ now: () => clock, ...overrides });
  return { instance, advance: (ms) => (clock += ms) };
}

test("a started job is running and answers its own id only", () => {
  const { instance } = store();
  const id = instance.start({ modelKey: "openai/gpt-5" });
  assert.equal(instance.read(id).state, "running");
  assert.equal(instance.read("nope"), null);
});

test("settling records the answer once", () => {
  const { instance } = store();
  const id = instance.start();
  assert.equal(instance.settle(id, { state: "done", text: "你好" }), true);
  assert.equal(instance.read(id).text, "你好");
  assert.equal(instance.settle("nope", { state: "done" }), false);
});

test("a cancelled job never comes back, even when the model answers", () => {
  const { instance } = store();
  const id = instance.start();
  assert.equal(instance.cancel(id), true);
  assert.equal(instance.settle(id, { state: "done", text: "late answer" }), false);
  assert.equal(instance.read(id).state, "cancelled");
});

test("cancelAll stops everything in flight", () => {
  const { instance } = store();
  const first = instance.start();
  const second = instance.start();
  instance.cancelAll();
  assert.equal(instance.read(first).state, "cancelled");
  assert.equal(instance.read(second).state, "cancelled");
});

test("old jobs are dropped, both by age and by count", () => {
  const { instance, advance } = store({ maxJobs: 2, ttlMs: 10_000 });
  const first = instance.start();
  advance(11_000);
  const second = instance.start();
  assert.equal(instance.read(first), null, "a job older than the TTL is gone");

  const third = instance.start();
  const fourth = instance.start();
  assert.equal(instance.read(second), null, "the oldest job is dropped past the cap");
  assert.ok(instance.read(third) && instance.read(fourth));
  assert.equal(instance.size, 2);
});