import { describe, expect, it } from 'vitest';
import { planSplit, previewNames, renderName, unknownVariables } from './nameTemplate';

describe('renderName', () => {
  it('pads index to the digits of the total', () => {
    expect(
      renderName('{name}_{index}', { name: 'hopdong', index: 3, total: 12, start: 5, end: 6 }),
    ).toBe('hopdong_03.pdf');
    expect(renderName('{name}_{index}', { name: 'a', index: 3, total: 9, start: 1, end: 1 })).toBe(
      'a_3.pdf',
    );
  });

  it('renders start and end, keeps .pdf', () => {
    expect(
      renderName('{name} trang {start}-{end}.pdf', {
        name: 'bc',
        index: 1,
        total: 2,
        start: 1,
        end: 4,
      }),
    ).toBe('bc trang 1-4.pdf');
  });

  it('replaces illegal characters and falls back to default', () => {
    expect(renderName('a/b:{index}', { name: 'x', index: 1, total: 1, start: 1, end: 1 })).toBe(
      'a_b_1.pdf',
    );
    expect(renderName('  ', { name: 'x', index: 1, total: 1, start: 1, end: 1 })).toBe('x_1.pdf');
  });

  it('detects unknown variables', () => {
    expect(unknownVariables('{name}_{date}_{index}_{date}')).toEqual(['date']);
  });
});

describe('planSplit', () => {
  it('ranges', () => {
    expect(planSplit({ mode: 'ranges', pageCount: 10, ranges: '1-3,5' })).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
    ]);
    expect(planSplit({ mode: 'ranges', pageCount: 3, ranges: '1-9' })).toBeNull();
  });

  it('every N', () => {
    expect(planSplit({ mode: 'everyN', pageCount: 5, n: 2 })).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 5 },
    ]);
    expect(planSplit({ mode: 'everyN', pageCount: 5, n: 0 })).toBeNull();
  });

  it('odd/even', () => {
    expect(planSplit({ mode: 'oddEven', pageCount: 5 })).toHaveLength(2);
    expect(planSplit({ mode: 'oddEven', pageCount: 1 })).toHaveLength(1);
  });

  it('bookmarks', () => {
    expect(planSplit({ mode: 'bookmarks', pageCount: 10, bookmarkStarts: [3, 7] })).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 6 },
      { start: 7, end: 10 },
    ]);
    expect(planSplit({ mode: 'bookmarks', pageCount: 10, bookmarkStarts: [] })).toBeNull();
  });

  it('max size is unknown on the client', () => {
    expect(planSplit({ mode: 'maxSize', pageCount: 10 })).toBeNull();
  });

  it('preview names', () => {
    const groups = planSplit({ mode: 'everyN', pageCount: 30, n: 3 })!;
    expect(previewNames('{name}_{index}', 'bc', groups, 2)).toEqual(['bc_01.pdf', 'bc_02.pdf']);
  });
});
