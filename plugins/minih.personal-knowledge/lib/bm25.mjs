import { tokenize } from "./tokens.mjs";

/**
 * BM25F over note chunks (ADR 0001 §6, lexical channel).
 *
 * k1 = 1.2, b = 0.75. Field weights: title 3, aliases 3, path 2, heading
 * path 1.5, body 1. Field weights fold into per-chunk term frequencies at
 * index time, so one inverted scan serves every query.
 */

const K1 = 1.2;
const B = 0.75;

export const FIELD_WEIGHTS = { title: 3, aliases: 3, path: 2, headingPath: 1.5, body: 1 };

/** Weighted term frequencies for one chunk. */
export function chunkTermFrequencies({ title, aliases, path, headingPath, body }) {
  const frequencies = new Map();
  const add = (text, weight) => {
    for (const token of new Set(tokenize(text))) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + weight);
    }
  };
  add(title ?? "", FIELD_WEIGHTS.title);
  for (const alias of aliases ?? []) add(alias, FIELD_WEIGHTS.aliases);
  add((path ?? "").split("/").join(" "), FIELD_WEIGHTS.path);
  add((headingPath ?? []).join(" "), FIELD_WEIGHTS.headingPath);
  for (const token of tokenize(body ?? "")) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + FIELD_WEIGHTS.body);
  }
  return frequencies;
}

/**
 * A tiny scoring index over every chunk of the vault. `docs` is an array of
 * `{ id, path, frequencies, length }`; rebuild it whenever the index changes.
 */
export class BM25 {
  constructor(docs) {
    this.docs = docs;
    this.totalLength = docs.reduce((sum, doc) => sum + doc.length, 0);
    this.averageLength = docs.length > 0 ? this.totalLength / docs.length : 0;
    this.documentFrequency = new Map();
    for (const doc of docs) {
      for (const term of doc.frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  idf(term) {
    const n = this.docs.length;
    const df = this.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Score one query; returns `[doc, score]` pairs above zero, best first. */
  search(query, limit = 50) {
    const terms = [...new Set(tokenize(query))];
    const scores = new Map();
    for (const term of terms) {
      const idf = this.idf(term);
      if (idf <= 0) continue;
      for (const doc of this.docs) {
        const tf = doc.frequencies.get(term);
        if (!tf) continue;
        const denominator = tf + K1 * (1 - B + (B * doc.length) / (this.averageLength || 1));
        const score = idf * ((tf * (K1 + 1)) / denominator);
        scores.set(doc, (scores.get(doc) ?? 0) + score);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].path.localeCompare(b[0].path, "zh-CN"))
      .slice(0, limit);
  }
}
