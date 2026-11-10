/**
 * `lib/dashboard.mjs` — the two `.base` tables derived without Obsidian
 * (obsidian-independence §3).
 *
 * The rules must match `08 Standards/知识库仪表盘.base` exactly, so the cases
 * below are the formula's edge conditions: missing `verified`, the 30/90-day
 * windows at one day on each side, template and archive exclusion, and a
 * non-active status. `now` is injected, so no test depends on today's date.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_DUE, REVIEW_MISSING, REVIEW_VALID, buildDashboard, reviewStateOf } from "../lib/dashboard.mjs";

const NOW = new Date(2026, 10, 10); // local 2026-11-10

function note(relativePath, metadata) {
  const base = relativePath.split("/").pop() ?? relativePath;
  return {
    path: relativePath,
    metadata: { title: base.replace(/\.md$/i, ""), ...metadata },
  };
}

/** A minimal stand-in for `VaultIndex`: `paths()` and `note()`. */
function indexOf(records) {
  const byPath = new Map(records.map((record) => [record.path, record]));
  return {
    paths: () => [...byPath.keys()].sort(),
    note: (relative) => byPath.get(relative) ?? null,
  };
}

/** Whole days before NOW, as a `verified` date string. */
function daysAgo(days) {
  const date = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

test("review state follows the .base formula", () => {
  // Missing verified wins over everything else.
  assert.equal(reviewStateOf({ stability: "volatile" }, { now: NOW }), REVIEW_MISSING);
  assert.equal(reviewStateOf({ stability: "stable", verified: "" }, { now: NOW }), REVIEW_MISSING);
  // Volatile: due only after 30 days.
  assert.equal(reviewStateOf({ stability: "volatile", verified: daysAgo(29) }, { now: NOW }), REVIEW_VALID);
  assert.equal(reviewStateOf({ stability: "volatile", verified: daysAgo(30) }, { now: NOW }), REVIEW_VALID);
  assert.equal(reviewStateOf({ stability: "volatile", verified: daysAgo(31) }, { now: NOW }), REVIEW_DUE);
  // Mixed: due only after 90 days.
  assert.equal(reviewStateOf({ stability: "mixed", verified: daysAgo(89) }, { now: NOW }), REVIEW_VALID);
  assert.equal(reviewStateOf({ stability: "mixed", verified: daysAgo(91) }, { now: NOW }), REVIEW_DUE);
  // A stability the formula does not mention never counts as due.
  assert.equal(reviewStateOf({ stability: "stable", verified: daysAgo(400) }, { now: NOW }), REVIEW_VALID);
  assert.equal(reviewStateOf({ verified: daysAgo(400) }, { now: NOW }), REVIEW_VALID);
});

test("active projects: type project + status active, sorted by title, no other class", () => {
  const dashboard = buildDashboard(
    {
      index: indexOf([
        note("01 Projects/Project - Beta.md", { type: "project", status: "active", stability: "mixed", verified: "2026-10-01" }),
        note("01 Projects/Project - Alpha.md", { type: "project", status: "active" }),
        note("01 Projects/Project - Old.md", { type: "project", status: "archived" }),
        note("02 Areas/Topic.md", { type: "topic", status: "active" }),
        note("Templates/Project - Template.md", { type: "project", status: "active" }),
        note("04 Archive/Project - Gone.md", { type: "project", status: "active" }),
        note("08 Standards/规范.md", { type: "standard", status: "active" }),
      ]),
    },
    { now: NOW },
  );
  assert.deepEqual(
    dashboard.activeProjects.map((row) => row.path),
    ["01 Projects/Project - Alpha.md", "01 Projects/Project - Beta.md"],
  );
  assert.deepEqual(dashboard.activeProjects[1], {
    path: "01 Projects/Project - Beta.md",
    title: "Project - Beta",
    status: "active",
    stability: "mixed",
    verified: "2026-10-01",
  });
});

test("review due: active notes that are due or unverified, due first, then by title", () => {
  const dashboard = buildDashboard(
    {
      index: indexOf([
        note("01 Projects/Volatile Long.md", { type: "project", status: "active", stability: "volatile", verified: daysAgo(45) }),
        note("02 Areas/Unverified A.md", { type: "area", status: "active" }),
        note("02 Areas/Unverified B.md", { type: "area", status: "active" }),
        note("03 Resources/Mixed Old.md", { type: "reference", status: "active", stability: "mixed", verified: daysAgo(120), project: "[[Project - Alpha]]" }),
        note("03 Resources/Stable.md", { type: "reference", status: "active", stability: "stable", verified: daysAgo(500) }),
        note("03 Resources/Inactive.md", { type: "reference", status: "archived" }),
        note("Templates/Unverified Template.md", { type: "reference", status: "active" }),
        note("04 Archive/Unverified Archive.md", { type: "reference", status: "active" }),
        note("08 Standards/Dashboard.base", {}),
      ]),
    },
    { now: NOW },
  );
  assert.deepEqual(
    dashboard.reviewDue.map((row) => [row.title, row.reviewState]),
    [
      ["Mixed Old", REVIEW_DUE],
      ["Volatile Long", REVIEW_DUE],
      ["Unverified A", REVIEW_MISSING],
      ["Unverified B", REVIEW_MISSING],
    ],
  );
  const mixedOld = dashboard.reviewDue[0];
  assert.equal(mixedOld.type, "reference");
  assert.equal(mixedOld.project, "[[Project - Alpha]]");
  assert.equal(mixedOld.stability, "mixed");
  assert.equal(mixedOld.verified, daysAgo(120));
  assert.equal(mixedOld.verificationScope, null);
});

test("a .base file is not a markdown note and never appears", () => {
  const dashboard = buildDashboard(
    {
      index: indexOf([
        note("08 Standards/知识库仪表盘.base", { type: "project", status: "active" }),
        note("08 Standards/知识库仪表盘.md", { type: "project", status: "active" }),
      ]),
    },
    { now: NOW },
  );
  assert.deepEqual(
    dashboard.activeProjects.map((row) => row.path),
    ["08 Standards/知识库仪表盘.md"],
  );
});

test("an empty vault yields two empty tables", () => {
  const dashboard = buildDashboard({ index: indexOf([]) }, { now: NOW });
  assert.deepEqual(dashboard, { activeProjects: [], reviewDue: [] });
});
