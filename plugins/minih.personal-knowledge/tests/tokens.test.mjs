import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokens, tokenize } from "../lib/tokens.mjs";

test("CJK characters count one token each and ASCII a quarter", () => {
  assert.equal(estimateTokens("甲".repeat(100)), 100);
  assert.ok(estimateTokens("甲".repeat(100)) >= 100);
  assert.equal(estimateTokens("a".repeat(100)), 25);
  assert.equal(estimateTokens(""), 0);
});

test("mixed text sums both rates and rounds up", () => {
  // 10 CJK + 10 ASCII = 10 + 2.5 = 12.5 → 13.
  assert.equal(estimateTokens(`${"中".repeat(10)}${"x".repeat(10)}`), 13);
  assert.equal(estimateTokens("áé"), 1, "a non-CJK, non-ASCII letter is still a quarter");
});

test("tokenize stays the lexical tokenizer it was", () => {
  assert.deepEqual(tokenize("EasyTier 服务器"), ["easytier", "服务", "务器"]);
});