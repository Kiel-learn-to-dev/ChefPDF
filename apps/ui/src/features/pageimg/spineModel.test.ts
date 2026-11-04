import { describe, expect, it } from 'vitest';
import {
  clampPercent,
  readSpinePreview,
  spineApplyParams,
  spinePreviewParams,
  startPercent,
} from './spineModel';

describe('spine model', () => {
  it('previews at most three pages, all pages when the field is empty', () => {
    expect(spinePreviewParams('', 5)).toEqual({ pages: [0, 1, 2, 3, 4].slice(0, 3) });
    expect(spinePreviewParams('4-6', 10)).toEqual({ pages: [3, 4, 5] });
    expect(spinePreviewParams('9-12', 5)).toBeNull();
  });

  it('auto mode sends no fraction; manual mode sends one fraction for the range', () => {
    expect(spineApplyParams('2', 5, 'auto', 50)).toEqual({ pages: [1], order: 'ltr' });
    expect(spineApplyParams('', 5, 'manual', 45.3)).toEqual({ mode: 'x', x: 0.453, order: 'ltr' });
    expect(spineApplyParams('', 5, 'manual', 5)).toBeNull();
    expect(spineApplyParams('', 5, 'manual', 95)).toBeNull();
  });

  it('starts the slider at the automatic position of the first previewed page', () => {
    expect(startPercent({ pages: [{ pageIndex: 0, status: 'done', autoX: 0.4721 }] })).toBe(47.2);
    expect(startPercent({ pages: [{ pageIndex: 0, status: 'skipped' }] })).toBe(50);
    expect(clampPercent(3)).toBe(10);
    expect(clampPercent(99)).toBe(90);
  });

  it('keeps only well-formed preview rows', () => {
    const data = readSpinePreview({
      pages: [
        { pageIndex: 1, status: 'done', autoX: 0.5 },
        { pageIndex: 'x', status: 'done' },
        null,
      ],
    });
    expect(data.pages.map((r) => r.pageIndex)).toEqual([1]);
    expect(readSpinePreview(null).pages).toEqual([]);
  });
});
