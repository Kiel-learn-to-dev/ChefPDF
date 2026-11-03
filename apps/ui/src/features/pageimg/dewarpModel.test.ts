import { describe, expect, it } from 'vitest';
import { applyParams, previewParams, readPreviewData, reviewPages } from './dewarpModel';

describe('curved-page dewarp parameters', () => {
  it('previews up to three pages from the selected range, using 0-based indexes', () => {
    expect(previewParams('2-5,8', 10)).toEqual({ pages: [1, 2, 3] });
    expect(previewParams('', 2)).toEqual({ pages: [0, 1] });
  });

  it('rejects an invalid range and preserves empty as all pages for apply', () => {
    expect(previewParams('2-99', 10)).toBeNull();
    expect(applyParams('', 8)).toEqual({ minConfidence: 0.35 });
    expect(applyParams('1,4', 8)).toEqual({ pages: [0, 3], minConfidence: 0.35 });
  });

  it('reads usable preview rows and reports pages that need review', () => {
    const data = {
      pages: [
        { pageIndex: 0, status: 'done', confidence: 0.8 },
        { pageIndex: 1, status: 'review' },
        { pageIndex: 2, status: 'skipped', reason: 'NO_DOMINANT_IMAGE' },
      ],
    };
    expect(readPreviewData(data).pages.map((p) => p.pageIndex)).toEqual([0, 2]);
    expect(reviewPages(data)).toEqual([1]);
    expect(reviewPages(null)).toEqual([]);
  });
});
