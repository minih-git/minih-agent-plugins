import assert from "node:assert/strict";
import test from "node:test";

import { groupReviewChanges, mapStatusChange } from "../lib/migrate-rules.mjs";

const RELEASE_VOCAB = ["planned", "succeeded", "failed", "rolled-back"];
const RECORD_VOCAB = ["open", "done"];
const PROJECT_VOCAB = ["active", "paused", "done", "archived"];
const TOPIC_VOCAB = ["active", "archived"];

test("status mapping: legacy completion words map to the class vocabulary", () => {
  for (const value of ["completed", "complete", "done", "success", "successful"]) {
    assert.deepEqual(mapStatusChange(value, "release", RELEASE_VOCAB), {
      to: "succeeded",
      to2: undefined,
      rule: "status-synonym",
    });
  }
  for (const value of ["completed", "complete", "done", "finished"]) {
    assert.deepEqual(mapStatusChange(value, "record", RECORD_VOCAB).to, "done");
    assert.deepEqual(mapStatusChange(value, "project", PROJECT_VOCAB).to, "done");
  }
});

test("status mapping: with-warning compounds map the main word and keep the original as outcome", () => {
  assert.deepEqual(mapStatusChange("complete-with-warning", "release", RELEASE_VOCAB), {
    to: "succeeded",
    to2: { outcome: "complete-with-warning" },
    rule: "status-synonym",
  });
  // A valid vocabulary word plus an extra phrase stays on the outcome path.
  assert.deepEqual(mapStatusChange("done with warning", "record", RECORD_VOCAB), {
    to: "done",
    to2: { outcome: "done with warning" },
    rule: "status-to-outcome",
  });
});

test("status mapping: unmappable values get null, never a class default", () => {
  // `active` is not release vocabulary and not a release synonym: the old
  // code suggested `planned` here, which is the opposite meaning.
  assert.deepEqual(mapStatusChange("active", "release", RELEASE_VOCAB), {
    to: null,
    rule: "status-unmappable",
  });
  // A release synonym is not valid for other classes either.
  assert.deepEqual(mapStatusChange("completed", "topic", TOPIC_VOCAB).to, null);
  // Words that only look related do not map.
  assert.deepEqual(mapStatusChange("completing", "record", RECORD_VOCAB).to, null);
});

test("status mapping: prefix matching keeps priority over synonyms", () => {
  // `rolled-back-x` starts with the vocabulary value `rolled-back`.
  assert.deepEqual(mapStatusChange("rolled-back-x", "release", RELEASE_VOCAB), {
    to: "rolled-back",
    to2: { outcome: "rolled-back-x" },
    rule: "status-to-outcome",
  });
});

test("review grouping: changes group by rule and from → to with counts", () => {
  const notes = [
    {
      path: "a.md",
      changes: [
        { key: "status", from: "completed", to: "succeeded", rule: "status-synonym", review: true },
      ],
    },
    {
      path: "b.md",
      changes: [
        { key: "status", from: "completed", to: "succeeded", rule: "status-synonym", review: true },
        { key: "status", from: "active", to: null, rule: "status-unmappable", review: true },
      ],
    },
    {
      path: "c.md",
      changes: [{ key: "type", from: "deployment", to: "release", rule: "type-alias", review: false }],
    },
  ];
  const groups = groupReviewChanges(notes);
  assert.equal(groups.length, 2, "auto changes are not grouped");
  const synonyms = groups.find((group) => group.rule === "status-synonym");
  assert.deepEqual(
    { key: synonyms.key, from: synonyms.from, to: synonyms.to, count: synonyms.count },
    { key: "status", from: "completed", to: "succeeded", count: 2 },
  );
  const unmappable = groups.find((group) => group.rule === "status-unmappable");
  assert.equal(unmappable.to, "需人工决定");
  assert.equal(unmappable.count, 1);
});
