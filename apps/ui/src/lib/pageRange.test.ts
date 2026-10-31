import { describe, expect, it } from 'vitest';
import { allPages, formatPageRanges, parsePageRanges } from './pageRange';

describe('parsePageRanges', () => {
  it('parses single pages and ranges', () => {
    const r = parsePageRanges('1-3, 5,7-9', 10);
    expect(r).toEqual({
      ok: true,
      groups: [
        { start: 1, end: 3 },
        { start: 5, end: 5 },
        { start: 7, end: 9 },
      ],
      pages: [0, 1, 2, 4, 6, 7, 8],
    });
  });

  it('supports open ranges', () => {
    const r = parsePageRanges('-2, 9-', 10);
    expect(r.ok && r.pages).toEqual([0, 1, 8, 9]);
  });

  it('keeps written order and de-duplicates', () => {
    const r = parsePageRanges('3,1,3', 5);
    expect(r.ok && r.pages).toEqual([2, 0]);
  });

  it('reports errors', () => {
    expect(parsePageRanges('', 5)).toEqual({ ok: false, error: 'empty' });
    expect(parsePageRanges('a', 5)).toMatchObject({ ok: false, error: 'syntax', token: 'a' });
    expect(parsePageRanges('1-9', 5)).toMatchObject({ ok: false, error: 'outOfRange' });
    expect(parsePageRanges('0', 5)).toMatchObject({ ok: false, error: 'outOfRange' });
    expect(parsePageRanges('4-2', 5)).toMatchObject({ ok: false, error: 'reversed' });
    expect(parsePageRanges('-', 5)).toMatchObject({ ok: false, error: 'syntax' });
  });

  it('accepts en dash and semicolons', () => {
    const r = parsePageRanges('1–2; 4', 5);
    expect(r.ok && r.pages).toEqual([0, 1, 3]);
  });
});

describe('formatPageRanges', () => {
  it('compacts consecutive pages', () => {
    expect(formatPageRanges([0, 1, 2, 4, 6, 7, 8])).toBe('1-3,5,7-9');
    expect(formatPageRanges([4, 0, 1])).toBe('1-2,5');
    expect(formatPageRanges([])).toBe('');
  });

  it('round-trips', () => {
    const r = parsePageRanges(formatPageRanges([0, 2, 3, 9]), 10);
    expect(r.ok && r.pages).toEqual([0, 2, 3, 9]);
  });
});

describe('allPages', () => {
  it('lists indices', () => {
    expect(allPages(3)).toEqual([0, 1, 2]);
  });
});
