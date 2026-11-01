import { describe, expect, it } from 'vitest';
import {
  backgroundRemoveParams,
  groupByPage,
  readBackgrounds,
  readBackgroundResult,
} from './backgroundModel';

const data = {
  backgrounds: [
    { pageIndex: 2, id: 'b2', kind: 'image', bbox: [0, 0, 595, 842], coverage: 0.97, fill: null },
    {
      pageIndex: 0,
      id: 'b0',
      kind: 'rectangle',
      bbox: [0, 0, 595, 842],
      coverage: 0.9,
      fill: '#F5F5F5',
    },
    { pageIndex: 0, id: 'b1', kind: 'fill', bbox: [0, 0, 100, 100], coverage: 0.2, fill: null },
    { id: 'broken' },
  ],
};

describe('readBackgrounds and groupByPage', () => {
  it('reads backgrounds and groups them per page in page order', () => {
    const items = readBackgrounds(data);
    expect(items.map((i) => i.id)).toEqual(['b2', 'b0', 'b1']);
    const pages = groupByPage(items);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 2]);
    expect(pages[0]!.items.map((i) => i.id)).toEqual(['b0', 'b1']);
    expect(pages[0]!.coverage).toBe(0.9);
  });

  it('tolerates a missing result', () => {
    expect(readBackgrounds(null)).toEqual([]);
    expect(groupByPage([])).toEqual([]);
  });
});

describe('backgroundRemoveParams', () => {
  it('removes on all pages without a page list', () => {
    expect(backgroundRemoveParams('remove', '#ffffff', { kind: 'all' }, 3)).toEqual({
      mode: 'remove',
    });
  });

  it('replaces the colour on the current page', () => {
    expect(
      backgroundRemoveParams('replaceColor', '#FFFFFF', { kind: 'current', page: 1 }, 3),
    ).toEqual({ mode: 'replaceColor', color: '#FFFFFF', pages: [1] });
  });

  it('refuses a bad colour or a bad page range', () => {
    expect(backgroundRemoveParams('replaceColor', 'white', { kind: 'all' }, 3)).toBeNull();
    expect(backgroundRemoveParams('remove', '', { kind: 'range', text: '7' }, 3)).toBeNull();
  });

  it('reads the number of objects changed', () => {
    expect(readBackgroundResult({ objects: 4 })).toBe(4);
    expect(readBackgroundResult({})).toBe(0);
  });
});
