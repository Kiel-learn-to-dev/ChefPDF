import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLANK_FORM,
  blankParams,
  defaultBlankSelection,
  readBlankRows,
  removalPlan,
  type BlankRow,
} from './blankModel';

const rows: BlankRow[] = [
  { index: 0, inkRatio: 0, hasText: false, hasAnnotations: false, blank: false },
  { index: 1, inkRatio: 0, hasText: false, hasAnnotations: false, blank: true },
  { index: 2, inkRatio: 0.2, hasText: true, hasAnnotations: false, blank: false },
  { index: 3, inkRatio: 0, hasText: false, hasAnnotations: false, blank: true },
];

describe('blankParams', () => {
  it('sends the sensitivity and keeps annotated pages by default', () => {
    expect(blankParams({ ...DEFAULT_BLANK_FORM, sensitivity: 0.2 })).toEqual({
      sensitivity: 0.2,
      borderMm: 5,
      keepIfAnnotations: true,
    });
  });
});

describe('readBlankRows', () => {
  it('reads the rows of page.findBlank and ignores malformed ones', () => {
    const data = { pages: [...rows, { index: 'x' }], candidates: [1, 3] };
    expect(readBlankRows(data)).toEqual(rows);
    expect(readBlankRows(undefined)).toEqual([]);
  });
});

describe('defaultBlankSelection', () => {
  it('selects the pages flagged blank', () => {
    expect(defaultBlankSelection(rows)).toEqual([1, 3]);
  });
});

describe('removalPlan', () => {
  const params = blankParams(DEFAULT_BLANK_FORM);

  it('uses page.removeBlank when the selection is exactly the candidates', () => {
    expect(removalPlan(rows, [3, 1], 4, params)).toEqual({ opId: 'page.removeBlank', params });
  });

  it('uses page.delete for any other selection', () => {
    expect(removalPlan(rows, [1], 4, params)).toEqual({
      opId: 'page.delete',
      params: { pages: [1] },
    });
  });

  it('refuses an empty selection and a selection of every page', () => {
    expect(removalPlan(rows, [], 4, params)).toBeNull();
    expect(removalPlan(rows, [0, 1, 2, 3], 4, params)).toBeNull();
  });
});
