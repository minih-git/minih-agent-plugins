/**
 * Lexical tokens for BM25F (ADR 0001 §6).
 *
 * Lowercased ASCII words (split on non-alphanumeric characters, with the
 * hyphenated whole also kept) and CJK character bigrams. A CJK run of one
 * character becomes a unigram. This makes reordering (`资产服务器` after
 * indexing `服务器资产`) and partial phrases match.
 */

const CJK_RUN = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/;

export function tokenize(text) {
  const tokens = [];
  const lowered = String(text ?? "").toLowerCase();
  const runs = lowered.split(CJK_RUN);
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (!run) continue;
    if (i % 2 === 1) {
      if (run.length === 1) {
        tokens.push(run);
        continue;
      }
      for (let j = 0; j + 1 < run.length; j += 1) tokens.push(run.slice(j, j + 2));
      continue;
    }
    for (const word of run.split(/[^a-z0-9-]+/)) {
      const trimmed = word.replace(/^-+|-+$/g, "");
      if (!trimmed) continue;
      tokens.push(trimmed);
      if (trimmed.includes("-")) {
        for (const part of trimmed.split("-")) if (part) tokens.push(part);
      }
    }
  }
  return tokens;
}

/**
 * CJK-aware size estimate (ADR 0004 §5): one token per CJK character, a
 * quarter token for everything else, rounded up. The `chars / 4` habit
 * understates Chinese text by about four times, which is what made the old
 * context pack look affordable.
 */
const CJK_RANGES = [
  [0x3000, 0x9fff], // CJK punctuation, kana-adjacent symbols, ideographs
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
  [0xac00, 0xd7af], // Hangul syllables
  [0x3040, 0x30ff], // hiragana and katakana
];

function isCjk(codePoint) {
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function estimateTokens(text) {
  const value = String(text ?? "");
  let tokens = 0;
  for (const character of value) {
    tokens += isCjk(character.codePointAt(0)) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}
