import { fold } from '../../lib/diacritics';

export interface Matchable {
  id: string;
  title: string;
  keywords?: string[];
}

/**
 * Score how well `query` matches an item (higher is better), or null when it
 * does not match. Diacritics- and case-insensitive ("ky so" matches "Ký số").
 */
export function scoreMatch(query: string, item: Matchable): number | null {
  const q = fold(query).trim();
  if (!q) return 0;
  const title = fold(item.title);
  const keywords = (item.keywords ?? []).map((k) => fold(k));
  const words = title.split(' ');
  const tokens = q.split(' ');

  if (title === q) return 1000;
  if (title.startsWith(q)) return 900 - title.length;
  if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 800 - title.length;
  if (title.includes(q)) return 700 - title.indexOf(q);
  if (keywords.some((k) => k.startsWith(q))) return 600;
  if (tokens.every((t) => title.includes(t) || keywords.some((k) => k.includes(t)))) return 500;
  const sub = subsequenceScore(q.replaceAll(' ', ''), title);
  if (sub !== null) return 100 + sub;
  return null;
}

/** Fuzzy subsequence score in [0, 100): rewards contiguous runs and word starts. */
function subsequenceScore(q: string, text: string): number | null {
  let ti = 0;
  let score = 0;
  let run = 0;
  for (const ch of q) {
    const found = text.indexOf(ch, ti);
    if (found < 0) return null;
    const atWordStart = found === 0 || text[found - 1] === ' ';
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (atWordStart ? 3 : 0) - Math.min(3, found - ti) * 0.5;
    ti = found + 1;
  }
  return Math.max(0, Math.min(99, score));
}

/** Filter and sort items by match score (stable for equal scores). */
export function rankMatches<T extends Matchable>(query: string, items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i, score: scoreMatch(query, item) }))
    .filter((x): x is { item: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}
