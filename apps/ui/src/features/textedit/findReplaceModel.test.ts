import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIND_FORM,
  buildFindParams,
  groupByPage,
  matchHighlights,
  summarize,
  validateForm,
  type FindMatch,
  type FindReplaceData,
} from './findReplaceModel';

const m = (pageIndex: number, before: string): FindMatch => ({
  pageIndex,
  lineId: `L${pageIndex}`,
  before,
  after: 'Công ty Mới',
  rect: [10, 20, 90, 30],
  fit: 'none',
  fontSize: 11,
  tracking: 0,
  overflow: 0,
  fontTo: 'Helvetica',
});

describe('validateForm', () => {
  it('needs a search text', () => {
    expect(validateForm(DEFAULT_FIND_FORM, 3)).toBe('FIND_REQUIRED');
  });

  it('rejects an invalid regular expression only when regex is on', () => {
    const form = { ...DEFAULT_FIND_FORM, find: '(abc' };
    expect(validateForm(form, 3)).toBeNull();
    expect(validateForm({ ...form, regex: true }, 3)).toBe('INVALID_REGEX');
  });

  it('checks the page range of the page scope', () => {
    const form = { ...DEFAULT_FIND_FORM, find: 'a', scope: 'pages' as const };
    expect(validateForm({ ...form, pageRange: '' }, 3)).toBe('PAGE_RANGE');
    expect(validateForm({ ...form, pageRange: '2-9' }, 3)).toBe('PAGE_RANGE');
    expect(validateForm({ ...form, pageRange: '1,3' }, 3)).toBeNull();
  });
});

describe('buildFindParams', () => {
  it('builds the params of a preview over all pages', () => {
    const p = buildFindParams({ ...DEFAULT_FIND_FORM, find: 'ACME', replace: 'Beta' }, 5, true);
    expect(p).toMatchObject({
      find: 'ACME',
      replace: 'Beta',
      preview: true,
      caseSensitive: false,
      regex: false,
    });
    expect(p.pages).toBeUndefined();
  });

  it('sends the pages as sorted 0-based indices, without duplicates', () => {
    const p = buildFindParams(
      { ...DEFAULT_FIND_FORM, find: 'x', scope: 'pages', pageRange: '3,1,3' },
      5,
      false,
    );
    expect(p.pages).toEqual([0, 2]);
    expect(p.preview).toBe(false);
  });
});

describe('groupByPage', () => {
  it('groups the matches by page in ascending order', () => {
    const groups = groupByPage([m(2, 'a'), m(0, 'b'), m(2, 'c')]);
    expect(groups.map((g) => g.pageIndex)).toEqual([0, 2]);
    expect(groups[1]!.matches.map((x) => x.before)).toEqual(['a', 'c']);
  });
});

describe('summarize', () => {
  it('counts replaced lines, pages, substitutions and skipped reasons', () => {
    const data: FindReplaceData = {
      matches: [m(0, 'a'), m(2, 'b')],
      replaced: 2,
      fontSubstitutions: [{ pageIndex: 2, lineId: 'L2', from: 'Helvetica', to: 'BeVietnamPro' }],
      skipped: [
        { pageIndex: 1, lineId: 'x', reason: 'ARTIFACT' },
        { pageIndex: 1, lineId: 'y', reason: 'ARTIFACT' },
        { pageIndex: 3, lineId: 'z', reason: 'TEXT_GLYPH_MISSING', missing: ['ệ'] },
      ],
      preview: false,
    };
    expect(summarize(data)).toEqual({
      replaced: 2,
      pages: [0, 2],
      substitutions: 1,
      skippedByReason: { ARTIFACT: 2, TEXT_GLYPH_MISSING: 1 },
      fonts: ['BeVietnamPro'],
    });
  });
});

describe('matchHighlights', () => {
  it('keeps the page and the box of each match', () => {
    expect(matchHighlights([m(1, 'a')])).toEqual([{ pageIndex: 1, rect: [10, 20, 90, 30] }]);
  });
});
