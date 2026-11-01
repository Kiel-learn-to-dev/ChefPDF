import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEAM_FORM,
  checkSeamForm,
  seamParams,
  seamPlan,
  seamSliceCount,
  summarizeSeam,
  type SeamForm,
} from './seamModel';

const WITH_PATH: SeamForm = { ...DEFAULT_SEAM_FORM, path: '/tmp/seal.png' };

describe('seamPlan', () => {
  it('gives every page one strip when there are no sets', () => {
    const plan = seamPlan([0, 1, 2, 3], 0, true);
    expect(plan.map((s) => [s.page, s.strip, s.of])).toEqual([
      [0, 0, 4],
      [1, 1, 4],
      [2, 2, 4],
      [3, 3, 4],
    ]);
    expect(seamSliceCount(plan)).toBe(4);
  });

  it('splits the pages into sets of groupSize and numbers the strips inside each set', () => {
    const plan = seamPlan([0, 1, 2, 3, 4], 2, true);
    expect(plan.map((s) => s.set)).toEqual([0, 0, 1, 1, 2]);
    expect(plan.map((s) => s.strip)).toEqual([0, 1, 0, 1, 0]);
    expect(plan[4]).toMatchObject({ page: 4, of: 1 });
  });

  it('skips the first page of each set when cutFirstPage is false', () => {
    const plan = seamPlan([0, 1, 2, 3], 2, false);
    expect(plan.map((s) => s.page)).toEqual([1, 3]);
    expect(plan.every((s) => s.of === 1)).toBe(true);
  });

  it('never gives a page two strips and always keeps strips inside the set count', () => {
    for (let n = 1; n <= 12; n++) {
      for (let g = 0; g <= 5; g++) {
        for (const cut of [true, false]) {
          const pages = Array.from({ length: n }, (_, i) => i);
          const plan = seamPlan(pages, g, cut);
          expect(new Set(plan.map((s) => s.page)).size).toBe(plan.length);
          expect(plan.every((s) => s.strip >= 0 && s.strip < s.of)).toBe(true);
          expect(plan.every((s) => pages.includes(s.page))).toBe(true);
        }
      }
    }
  });
});

describe('checkSeamForm', () => {
  it('accepts a form with a seal and pages', () => {
    expect(checkSeamForm(WITH_PATH, 4, 0)).toEqual({ ok: true });
  });

  it('asks for a seal image first', () => {
    expect(checkSeamForm(DEFAULT_SEAM_FORM, 4, 0)).toEqual({ ok: false, field: 'path' });
  });

  it('rejects a non-integer or negative group size and out of range overlap', () => {
    expect(checkSeamForm({ ...WITH_PATH, groupSize: 2.5 }, 4, 0)).toEqual({
      ok: false,
      field: 'groupSize',
    });
    expect(checkSeamForm({ ...WITH_PATH, overlapMm: 51 }, 4, 0)).toEqual({
      ok: false,
      field: 'overlapMm',
    });
  });

  it('rejects a selection that leaves no page for a strip', () => {
    const one = { ...WITH_PATH, pages: { choice: 'current' as const, range: '' } };
    expect(checkSeamForm({ ...one, cutFirstPage: false }, 4, 0)).toEqual({
      ok: false,
      field: 'cutFirstPage',
    });
  });
});

describe('seamParams', () => {
  it('sends the core fields and omits the zero group size and natural width', () => {
    const p = seamParams({ ...WITH_PATH, groupSize: 0, scaleWidthMm: 0 }, 0, 4);
    expect(p).toMatchObject({
      path: '/tmp/seal.png',
      side: 'right',
      sliceMode: 'even',
      cutFirstPage: true,
      vertical: 'center',
      blendMultiply: true,
    });
    expect(p).not.toHaveProperty('groupSize');
    expect(p).not.toHaveProperty('scaleWidthMm');
  });

  it('sends the mm position as a number and the page selection', () => {
    const p = seamParams(
      { ...WITH_PATH, vertical: 'mm', verticalMm: 35, groupSize: 10, scaleWidthMm: 40 },
      2,
      30,
    );
    expect(p.vertical).toBe(35);
    expect(p.groupSize).toBe(10);
    expect(p.scaleWidthMm).toBe(40);
    expect(p.pages).toBeUndefined();
  });

  it('sends the odd selection as a page range', () => {
    const p = seamParams({ ...WITH_PATH, pages: { choice: 'odd', range: '' } }, 0, 4);
    expect(p.pageRange).toBe('odd');
  });
});

describe('summarizeSeam', () => {
  it('counts strips, sets and pages from the core result', () => {
    const strips = [
      { page: 0, strip: 1 },
      { page: 1, strip: 2 },
      { page: 2, strip: 1 },
      { page: 3, strip: 2 },
    ];
    expect(summarizeSeam(strips)).toEqual({ strips: 4, sets: 2, pages: 4 });
    expect(summarizeSeam([])).toEqual({ strips: 0, sets: 0, pages: 0 });
  });
});
