/**
 * Diacritics-insensitive text folding for Vietnamese (and other Latin scripts).
 *
 * `String.prototype.normalize('NFD')` decomposes most Vietnamese letters into a
 * base letter + combining marks (ị → i + U+0323), but đ/Đ (U+0111/U+0110) are
 * standalone letters with no decomposition, so they are mapped to "d" explicitly.
 */

const COMBINING_MARK = /\p{M}/u;
const WHITESPACE = /\s/u;

const SPECIAL_FOLDS: Record<string, string> = {
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  ø: 'o',
  Ø: 'o',
  ł: 'l',
  Ł: 'l',
};

export interface FoldOptions {
  /** Keep letter case (default false: everything is lower-cased). */
  caseSensitive?: boolean;
}

/** Fold one already-decomposed character; returns '' for combining marks. */
function foldChar(ch: string, caseSensitive: boolean): string {
  if (COMBINING_MARK.test(ch)) return '';
  const special = SPECIAL_FOLDS[ch];
  if (special !== undefined) {
    return caseSensitive && ch !== ch.toLowerCase() ? special.toUpperCase() : special;
  }
  return caseSensitive ? ch : ch.toLowerCase();
}

/** Fold a string: strip diacritics, đ → d, lower-case, collapse whitespace. */
export function fold(text: string, options: FoldOptions = {}): string {
  return foldWithMap(text, options).folded;
}

export interface FoldedText {
  folded: string;
  /** map[i] = index in the original string of folded character i. */
  map: number[];
}

/**
 * Fold `text` and keep an index map back into the original string, so matches
 * found in the folded text can be highlighted in the original one.
 * Whitespace runs collapse into a single space.
 */
export function foldWithMap(text: string, options: FoldOptions = {}): FoldedText {
  const caseSensitive = options.caseSensitive ?? false;
  let folded = '';
  const map: number[] = [];
  let lastWasSpace = false;
  // Iterate over code points of the original string; decompose each one.
  let i = 0;
  for (const cp of text) {
    if (WHITESPACE.test(cp)) {
      if (!lastWasSpace) {
        folded += ' ';
        map.push(i);
        lastWasSpace = true;
      }
    } else {
      for (const part of cp.normalize('NFD')) {
        const f = foldChar(part, caseSensitive);
        for (const c of f) {
          folded += c;
          map.push(i);
        }
      }
      if (!COMBINING_MARK.test(cp)) lastWasSpace = false;
    }
    i += cp.length;
  }
  return { folded, map };
}

export interface TextMatch {
  /** Index in the original text. */
  index: number;
  /** Length in the original text (includes trailing combining marks). */
  length: number;
}

export interface FindOptions extends FoldOptions {
  entireWord?: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Find all occurrences of `query` in `text`, ignoring diacritics (and case
 * unless `caseSensitive`). Returned positions refer to the original `text`.
 */
export function findMatches(text: string, query: string, options: FindOptions = {}): TextMatch[] {
  const q = fold(query, options).trim();
  if (!q) return [];
  const { folded, map } = foldWithMap(text, options);
  const matches: TextMatch[] = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(q, from);
    if (at < 0) break;
    from = at + q.length;
    if (options.entireWord) {
      const before = folded[at - 1];
      const after = folded[at + q.length];
      if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) continue;
    }
    const start = map[at]!;
    let end = map[at + q.length - 1]!;
    // Advance `end` past the last matched original code point and its marks.
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
    while (end < text.length && COMBINING_MARK.test(text[end]!)) end++;
    matches.push({ index: start, length: end - start });
  }
  return matches;
}

/** True when every whitespace-separated token of `query` occurs in `text` (folded). */
export function includesFolded(text: string, query: string): boolean {
  const t = fold(text);
  return fold(query)
    .split(' ')
    .filter(Boolean)
    .every((token) => t.includes(token));
}
