/**
 * Pure rules for the ontology migration plan (ADR 0001 §5).
 *
 * Kept dependency-free so `scripts/ontology-migrate.mjs` and the unit tests
 * share one implementation. The status mapping exists because guessing a
 * class default is semantically wrong (`release: completed → planned`); a
 * value that cannot be mapped honestly gets `to: null` and waits for a human.
 */

/**
 * Observed legacy status values and their class-specific vocabulary
 * replacements. Only classes whose vocabulary actually contains the target
 * are listed. Unlisted classes have no honest automatic mapping.
 */
export const STATUS_SYNONYMS = {
  release: {
    completed: "succeeded",
    complete: "succeeded",
    done: "succeeded",
    success: "succeeded",
    successful: "succeeded",
  },
  record: {
    completed: "done",
    complete: "done",
    done: "done",
    finished: "done",
  },
  project: {
    completed: "done",
    complete: "done",
    done: "done",
    finished: "done",
  },
};

/**
 * Map one out-of-vocabulary `status` value to a proposal.
 *
 * Priority: an existing vocabulary value followed by extra words (`done with
 * warning` → `done`, original kept as outcome) beats a synonym mapping;
 * `*-with-warning` compounds map their main word and keep the original in
 * `outcome`. Returns `{ to: null, rule: "status-unmappable" }` when no honest
 * mapping exists — callers must treat that as "human decides" and never
 * substitute a class default.
 *
 * @param {string} value the note's current status
 * @param {string|null} cls the resolved class of the note
 * @param {string[]} vocabulary the class's valid status values
 */
export function mapStatusChange(value, cls, vocabulary) {
  const text = String(value);
  const prefix = vocabulary.find(
    (entry) => text.startsWith(`${entry}-`) || text.startsWith(`${entry} `),
  );
  if (prefix) {
    return { to: prefix, to2: { outcome: text }, rule: "status-to-outcome" };
  }
  const mainWord = text.replace(/-with-.*$/, "");
  const synonym = STATUS_SYNONYMS[cls]?.[mainWord];
  if (synonym) {
    return {
      to: synonym,
      to2: mainWord === text ? undefined : { outcome: text },
      rule: "status-synonym",
    };
  }
  return { to: null, rule: "status-unmappable" };
}

/**
 * Group review changes by rule and from → to so a human can approve whole
 * groups instead of line items.
 *
 * @param {Array<{ path: string, changes: Array<object> }>} notes plan notes
 * @returns {Array<{ key: string, rule: string, from: string, to: string, count: number, notes: number }>}
 */
export function groupReviewChanges(notes) {
  const groups = new Map();
  for (const note of notes) {
    for (const change of note.changes) {
      if (!change.review) continue;
      const from = change.from ?? "∅";
      const to = change.to === null || change.to === undefined ? "需人工决定" : String(change.to);
      const mapKey = `${change.key}|${change.rule}|${from}|${to}`;
      let group = groups.get(mapKey);
      if (!group) {
        group = { key: change.key, rule: change.rule, from, to, count: 0, paths: [] };
        groups.set(mapKey, group);
      }
      group.count += 1;
      if (group.paths.length < 3) group.paths.push(note.path);
    }
  }
  return [...groups.values()].map(({ key, rule, from, to, count, paths }) => ({
    key,
    rule,
    from,
    to,
    count,
    notes: paths.length,
    examplePaths: paths,
  }));
}
