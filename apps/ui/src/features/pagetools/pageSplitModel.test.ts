import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SPLIT_FORM,
  pageSplitIssues,
  pageSplitParams,
  type PageSplitForm,
} from './pageSplitModel';

const split = (patch: Partial<PageSplitForm> = {}): PageSplitForm => ({
  ...DEFAULT_PAGE_SPLIT_FORM,
  ...patch,
});

describe('pageSplitIssues', () => {
  it('is clean for the default two-column split', () => {
    expect(pageSplitIssues(split(), 5)).toEqual([]);
  });

  it('needs at least two pieces and at most ten rows or columns', () => {
    expect(pageSplitIssues(split({ rows: 1, cols: 1 }), 5)).toEqual(['pieces']);
    expect(pageSplitIssues(split({ rows: 11 }), 5)).toEqual(['rows']);
    expect(pageSplitIssues(split({ cols: 0 }), 5)).toEqual(['cols']);
  });

  it('checks the overlap and the page selector', () => {
    expect(pageSplitIssues(split({ overlapMm: 60 }), 5)).toEqual(['overlap']);
    expect(pageSplitIssues(split({ scope: 'pages', pagesText: '8' }), 5)).toEqual(['pages']);
  });
});

describe('pageSplitParams', () => {
  it('sends the grid, overlap and order; pages only when selected', () => {
    expect(pageSplitParams(split({ rows: 2, cols: 1, overlapMm: 3, order: 'rtl' }), 5)).toEqual({
      rows: 2,
      cols: 1,
      overlapMm: 3,
      order: 'rtl',
    });
    expect(pageSplitParams(split({ scope: 'pages', pagesText: '1,3' }), 5)).toMatchObject({
      pages: [0, 2],
    });
  });
});
