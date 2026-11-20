import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const rules = require("../lib/rules.js");

/**
 * The importance rule is the whole feature, and it must be explainable: every
 * case below is one sentence a user could have written in Settings.
 */

const SETTINGS = {
  importantSenders: "boss@example.com, @family.example, 财务",
  keywords: "发票, invoice",
};

const from = (name, address) => ({ name, address });

test("a full address on the list is an alert", () => {
  const verdict = rules.classify({ subject: "hi", from: from("B", "boss@example.com") }, SETTINGS);
  assert.equal(verdict.level, "alert");
  assert.deepEqual(verdict.reasons, [{ kind: "sender", value: "boss@example.com" }]);
});

test("a domain entry matches every address there", () => {
  const verdict = rules.classify({ subject: "hi", from: from("", "mum@family.example") }, SETTINGS);
  assert.equal(verdict.level, "alert");
});

test("a bare word matches the start of the address or anywhere in the name", () => {
  assert.equal(rules.classify({ subject: "x", from: from("", "财务部@corp.example") }, SETTINGS).level, "alert");
  assert.equal(rules.classify({ subject: "x", from: from("张财务", "z@corp.example") }, SETTINGS).level, "alert");
});

test("a keyword matches the subject or the sender's name, case-insensitively", () => {
  assert.equal(rules.classify({ subject: "请开发票", from: from("", "a@b.c") }, SETTINGS).level, "alert");
  assert.equal(rules.classify({ subject: "Your INVOICE", from: from("", "a@b.c") }, SETTINGS).level, "alert");
  const verdict = rules.classify({ subject: "hello", from: from("Invoice Bot", "a@b.c") }, SETTINGS);
  assert.deepEqual(verdict.reasons, [{ kind: "keyword", value: "invoice" }]);
});

test("an urgent header makes a stranger's mail an alert", () => {
  const headers = new Map([["importance", "high"]]);
  assert.deepEqual(rules.classify({ subject: "x", from: from("", "a@b.c") }, SETTINGS, headers).reasons, [
    { kind: "header", value: "urgent" },
  ]);
  const priority = new Map([["x-priority", "1"]]);
  assert.equal(rules.classify({ subject: "x", from: from("", "a@b.c") }, SETTINGS, priority).level, "alert");
  // X-Priority 2 is "high" on the five-step scale, and deliberately not urgent.
  const medium = new Map([["x-priority", "2"]]);
  assert.equal(rules.classify({ subject: "x", from: from("", "a@b.c") }, SETTINGS, medium).level, "digest");
});

test("anything else is a digest, with no reason attached", () => {
  const verdict = rules.classify({ subject: "Weekly newsletter", from: from("News", "news@example.com") }, SETTINGS);
  assert.deepEqual(verdict, { level: "digest", reasons: [] });
});

test("an empty settings list never matches, and a junk value is not a rule", () => {
  const empty = { importantSenders: "", keywords: "" };
  assert.equal(rules.classify({ subject: "发票", from: from("财务", "a@b.c") }, empty).level, "digest");
  assert.deepEqual(rules.splitList("  ,,\n "), []);
  assert.deepEqual(rules.splitList("a，b;c\nd"), ["a", "b", "c", "d"]);
});

test("the digest summary counts senders once, by address", () => {
  const summary = rules.digestSenders([
    { from: from("A", "a@b.c") },
    { from: from("A again", "a@b.c") },
    { from: from("", "d@e.f") },
  ]);
  assert.deepEqual(summary, [
    { label: "A", count: 2 },
    { label: "d@e.f", count: 1 },
  ]);
});
