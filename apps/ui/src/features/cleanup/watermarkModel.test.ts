import { describe, expect, it } from 'vitest';
import {
  candidateBoxes,
  confidenceLevel,
  defaultChecked,
  rankCandidates,
  readCandidates,
  readRemoveResult,
  removedTotal,
  samplePage,
  watermarkRemoveParams,
  type WatermarkCandidate,
} from './watermarkModel';

const raw = (over: Record<string, unknown>) => ({
  id: 'c1',
  kind: 'Tagged watermark',
  tier: 1,
  confidence: 1,
  pages: [0, 2],
  count: 2,
  sample: { pageIndex: 2, bbox: [10, 20, 30, 40] },
  description: { vi: 'Watermark gắn nhãn', en: 'Tagged' },
  evidence: ['artifact'],
  preview: [{ pageIndex: 2, bboxes: [[10, 20, 30, 40]] }],
  ...over,
});

const cand = (over: Partial<WatermarkCandidate>): WatermarkCandidate => ({
  id: 'x',
  kind: 'k',
  tier: 4,
  confidence: 0.5,
  pages: [0],
  count: 1,
  sample: null,
  description: { vi: '', en: '' },
  evidence: [],
  preview: [],
  ...over,
});

describe('readCandidates', () => {
  it('reads valid candidates and skips malformed entries', () => {
    const list = readCandidates({ candidates: [raw({}), { nope: true }, raw({ id: 'c2' })] });
    expect(list.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(list[0]!.sample).toEqual({ pageIndex: 2, bbox: [10, 20, 30, 40] });
    expect(list[0]!.preview[0]!.bboxes[0]).toEqual([10, 20, 30, 40]);
  });

  it('returns an empty list for a missing or wrong result', () => {
    expect(readCandidates(undefined)).toEqual([]);
    expect(readCandidates({})).toEqual([]);
    expect(readCandidates({ candidates: 'x' })).toEqual([]);
  });
});

describe('ranking and defaults', () => {
  it('ranks by confidence, then tier', () => {
    const ranked = rankCandidates([
      cand({ id: 'a', confidence: 0.4, tier: 4 }),
      cand({ id: 'b', confidence: 0.9, tier: 2 }),
      cand({ id: 'c', confidence: 0.9, tier: 1 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('checks only candidates at or above 0.8 by default', () => {
    const list = [
      cand({ id: 'low', confidence: 0.79 }),
      cand({ id: 'edge', confidence: 0.8 }),
      cand({ id: 'top', confidence: 1 }),
    ];
    expect(defaultChecked(list)).toEqual(['edge', 'top']);
  });

  it('maps confidence to a level', () => {
    expect(confidenceLevel(0.95)).toBe('high');
    expect(confidenceLevel(0.6)).toBe('medium');
    expect(confidenceLevel(0.2)).toBe('low');
  });
});

describe('preview helpers', () => {
  it('returns the boxes of one page and the sample page to jump to', () => {
    const c = cand({
      pages: [0, 3],
      sample: { pageIndex: 3, bbox: [] },
      preview: [
        { pageIndex: 0, bboxes: [[1, 2, 3, 4]] },
        { pageIndex: 3, bboxes: [[5, 6, 7, 8]] },
      ],
    });
    expect(candidateBoxes(c, 3)).toEqual([[5, 6, 7, 8]]);
    expect(candidateBoxes(c, 1)).toEqual([]);
    expect(samplePage(c)).toBe(3);
    expect(samplePage(cand({ pages: [4] }))).toBe(4);
    expect(samplePage(cand({ pages: [] }))).toBeNull();
  });
});

describe('watermarkRemoveParams', () => {
  it('lists the checked candidate ids and omits pages for all pages', () => {
    expect(watermarkRemoveParams(['a', 'a', 'b'], { kind: 'all' }, 5)).toEqual({
      candidateIds: ['a', 'b'],
    });
  });

  it('adds the page list for the current page or a typed range', () => {
    expect(watermarkRemoveParams(['a'], { kind: 'current', page: 2 }, 5)).toEqual({
      candidateIds: ['a'],
      pages: [2],
    });
    expect(watermarkRemoveParams(['a'], { kind: 'range', text: '1-2' }, 5)).toEqual({
      candidateIds: ['a'],
      pages: [0, 1],
    });
  });

  it('returns null with nothing checked or an invalid range', () => {
    expect(watermarkRemoveParams([], { kind: 'all' }, 5)).toBeNull();
    expect(watermarkRemoveParams(['a'], { kind: 'range', text: '9' }, 5)).toBeNull();
    expect(watermarkRemoveParams(['a'], { kind: 'current', page: 7 }, 5)).toBeNull();
  });
});

describe('readRemoveResult', () => {
  it('sums the counts and tolerates a missing result', () => {
    const r = readRemoveResult({ removedObjects: 2, removedAnnotations: 1, removedLayers: 3 });
    expect(r).toEqual({
      removedObjects: 2,
      removedAnnotations: 1,
      removedOverlays: 0,
      removedLayers: 3,
    });
    expect(removedTotal(r)).toBe(6);
    expect(removedTotal(readRemoveResult(null))).toBe(0);
  });
});
