/**
 * Human page ranges ("1-3, 5, 7-9", 1-based) <-> 0-based page indices.
 * Also accepts "-3" (start..3), "5-" (5..end), "end"/"cuối" keyword is not supported on purpose.
 */

export type PageRangeError = 'empty' | 'syntax' | 'outOfRange' | 'reversed';

export interface PageGroup {
  /** 1-based inclusive. */
  start: number;
  end: number;
}

export type ParseResult =
  | { ok: true; groups: PageGroup[]; pages: number[] }
  | { ok: false; error: PageRangeError; token?: string };

const PART = /^(\d*)\s*(?:-|–)\s*(\d*)$|^(\d+)$/;

/**
 * Parse a 1-based range string. `pages` are 0-based, de-duplicated and in
 * the order written (so "3,1" gives [2, 0]); `groups` keep each comma part.
 */
export function parsePageRanges(input: string, pageCount: number): ParseResult {
  const parts = input
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'empty' };
  const groups: PageGroup[] = [];
  for (const part of parts) {
    const m = PART.exec(part);
    if (!m) return { ok: false, error: 'syntax', token: part };
    let start: number;
    let end: number;
    if (m[3] !== undefined) {
      start = end = Number(m[3]);
    } else {
      if (!m[1] && !m[2]) return { ok: false, error: 'syntax', token: part };
      start = m[1] ? Number(m[1]) : 1;
      end = m[2] ? Number(m[2]) : pageCount;
    }
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      return { ok: false, error: 'outOfRange', token: part };
    }
    if (start > end) return { ok: false, error: 'reversed', token: part };
    groups.push({ start, end });
  }
  const seen = new Set<number>();
  const pages: number[] = [];
  for (const g of groups) {
    for (let p = g.start; p <= g.end; p++) {
      if (!seen.has(p - 1)) {
        seen.add(p - 1);
        pages.push(p - 1);
      }
    }
  }
  return { ok: true, groups, pages };
}

/** Format 0-based indices as a compact 1-based range string ("1-3,5"). Sorted. */
export function formatPageRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[++i]!;
    }
    out.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
    i++;
  }
  return out.join(',');
}

/** All 0-based indices [0, count). */
export function allPages(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}
