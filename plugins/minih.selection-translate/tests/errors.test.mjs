import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HINTS, describeFailure } = require("../lib/errors.js");

test("every failure the host can answer with has reader-facing text", () => {
  for (const code of ["PERMISSION_DENIED", "RATE_LIMITED", "TIMEOUT", "INVALID_ARGUMENT", "ABORTED"]) {
    const { message } = describeFailure(code);
    assert.equal(message, HINTS[code]);
    assert.match(message, /[\u4e00-\u9fff]/);
  }
});

test("an unknown code still answers something readable", () => {
  const { message, detail } = describeFailure("SOMETHING_NEW", new Error("boom"));
  assert.equal(message, HINTS.FAILED);
  assert.equal(detail, "boom");
});

test("the host's own English text never becomes the visible line", () => {
  const { message, detail } = describeFailure("TIMEOUT", new Error("plugin completion timed out"));
  assert.equal(message, HINTS.TIMEOUT);
  assert.equal(detail, "plugin completion timed out");
  assert.equal(describeFailure("FAILED", undefined).detail, "");
});