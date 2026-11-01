import { describe, expect, it } from 'vitest';
import {
  clampTolerance,
  matchesPerPage,
  readPickedObject,
  readSimilarResult,
  similarParams,
} from './removeSimilarModel';

describe('readPickedObject', () => {
  it('reads the object of a content.hitTest result', () => {
    expect(
      readPickedObject({
        pageIndex: 1,
        object: { id: 'p1:ab:0', pageIndex: 1, kind: 'image', bbox: [1, 2, 3, 4] },
      }),
    ).toEqual({ id: 'p1:ab:0', pageIndex: 1, kind: 'image', bbox: [1, 2, 3, 4] });
  });

  it('returns null when the point is on no object', () => {
    expect(readPickedObject({ pageIndex: 0, object: null })).toBeNull();
    expect(readPickedObject(undefined)).toBeNull();
  });
});

describe('similarParams', () => {
  it('builds the content.removeSimilar params and clamps the tolerance', () => {
    expect(similarParams({ id: 'o1', pageIndex: 2 }, 'others', 99, true)).toEqual({
      pageIndex: 2,
      objectId: 'o1',
      scope: 'others',
      toleranceMm: 20,
      dryRun: true,
    });
    expect(clampTolerance(-3)).toBe(0);
    expect(clampTolerance(Number.NaN)).toBe(2);
  });
});

describe('readSimilarResult', () => {
  it('reads the matches and the dry-run flag', () => {
    const r = readSimilarResult({
      dryRun: true,
      matches: [
        { id: 'a', pageIndex: 0, bbox: [1, 1, 2, 2] },
        { id: 'b', pageIndex: 3, bbox: [1, 1, 2, 2] },
        { id: 'c', pageIndex: 3, bbox: [5, 5, 6, 6] },
      ],
      removedObjects: 0,
    });
    expect(r.dryRun).toBe(true);
    expect(r.matches).toHaveLength(3);
    expect(matchesPerPage(r.matches)).toEqual([
      { pageIndex: 0, count: 1 },
      { pageIndex: 3, count: 2 },
    ]);
  });

  it('keeps the removed count of a real run', () => {
    expect(readSimilarResult({ dryRun: false, matches: [], removedObjects: 4 })).toEqual({
      dryRun: false,
      matches: [],
      removedObjects: 4,
    });
  });
});
