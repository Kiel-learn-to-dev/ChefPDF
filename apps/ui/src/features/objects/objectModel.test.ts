import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADJUST,
  DEFAULT_ERASE,
  addIds,
  adjustImageParams,
  bboxContains,
  bboxToPageBox,
  colorParams,
  duplicateParams,
  eraseChangedNothing,
  eraseRegionParams,
  hitObjects,
  isIdentityAdjust,
  isMeaningfulMove,
  nudgeFor,
  objectsInRect,
  opacityParams,
  pageBoxToBbox,
  pagesOfIds,
  pickHit,
  pruneSelection,
  pxDeltaToPt,
  rangeIds,
  remapSelection,
  replaceImageParams,
  toggleId,
  normRectPt,
  type PageObject,
} from './objectModel';

function obj(
  id: string,
  bbox: [number, number, number, number],
  extra: Partial<PageObject> = {},
): PageObject {
  return {
    id,
    pageIndex: 0,
    kind: 'path',
    ordinal: 0,
    parentId: null,
    editable: true,
    bbox,
    layer: null,
    clipped: false,
    opacity: [1, 1],
    ...extra,
  };
}

// A 600 x 800 pt page shown at 1.5 px per point (a 900 x 1200 px image).
const PAGE = {
  index: 0,
  left: 10,
  top: 20,
  width: 900,
  height: 1200,
  scale: 1.5,
  dispW: 600,
  dispH: 800,
};

describe('bbox <-> page pixels', () => {
  it('maps a top-left bbox to px with the scale (y downwards kept)', () => {
    const box = bboxToPageBox([100, 50, 200, 80], PAGE);
    expect(box.left).toBeCloseTo(150, 6);
    expect(box.top).toBeCloseTo(75, 6);
    expect(box.width).toBeCloseTo(150, 6);
    expect(box.height).toBeCloseTo(45, 6);
  });

  it('round-trips a box through px back to points', () => {
    const bbox: [number, number, number, number] = [120.5, 33.25, 260, 401.75];
    const px = bboxToPageBox(bbox, PAGE);
    expect(pageBoxToBbox(px, PAGE)).toEqual([120.5, 33.25, 260, 401.75]);
  });

  it('turns a pixel delta into a point delta', () => {
    expect(pxDeltaToPt(30, -15, 1.5)).toEqual({ dx: 20, dy: -10 });
  });
});

describe('hit testing', () => {
  it('finds the objects under a point, topmost (highest ordinal) first', () => {
    const back = obj('a', [0, 0, 100, 100], { ordinal: 1 });
    const front = obj('b', [50, 50, 150, 150], { ordinal: 5 });
    const far = obj('c', [300, 300, 310, 310], { ordinal: 9 });
    const hits = hitObjects([back, front, far], 60, 60);
    expect(hits.map((o) => o.id)).toEqual(['b', 'a']);
    expect(pickHit(hits, null, false)?.id).toBe('b');
  });

  it('cycles through overlapped objects with Alt', () => {
    const hits = [obj('top', [0, 0, 1, 1]), obj('mid', [0, 0, 1, 1]), obj('low', [0, 0, 1, 1])];
    expect(pickHit(hits, 'top', true)?.id).toBe('mid');
    expect(pickHit(hits, 'mid', true)?.id).toBe('low');
    expect(pickHit(hits, 'low', true)?.id).toBe('top');
    expect(pickHit(hits, 'unknown', true)?.id).toBe('top');
    expect(pickHit([], null, false)).toBeNull();
  });

  it('treats the bbox edges as inside', () => {
    expect(bboxContains([0, 0, 10, 10], 10, 10)).toBe(true);
    expect(bboxContains([0, 0, 10, 10], 10.5, 5)).toBe(false);
  });

  it('selects the objects lying completely inside a rubber band', () => {
    const list = [obj('in', [10, 10, 20, 20]), obj('cut', [15, 15, 40, 40])];
    expect(objectsInRect(list, [0, 0, 30, 30]).map((o) => o.id)).toEqual(['in']);
  });
});

describe('selection', () => {
  it('toggles and adds ids without duplicates', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(addIds(['a'], ['a', 'c'])).toEqual(['a', 'c']);
  });

  it('selects a range in paint order, ends included', () => {
    const page = [
      obj('p0:x:0', [0, 0, 1, 1], { ordinal: 0 }),
      obj('p0:x:1', [0, 0, 1, 1], { ordinal: 1 }),
      obj('p0:x:2', [0, 0, 1, 1], { ordinal: 2 }),
      obj('p0:x:3', [0, 0, 1, 1], { ordinal: 3 }),
    ];
    expect(rangeIds(page, 'p0:x:3', 'p0:x:1')).toEqual(['p0:x:1', 'p0:x:2', 'p0:x:3']);
    expect(rangeIds(page, null, 'p0:x:2')).toEqual(['p0:x:2']);
    expect(rangeIds(page, 'missing', 'p0:x:0')).toEqual(['p0:x:0']);
  });

  it('drops selected ids that no longer exist', () => {
    expect(pruneSelection(['a', 'b'], [obj('b', [0, 0, 1, 1])])).toEqual(['b']);
  });

  it('finds the moved objects again after an edit (ids change with the revision)', () => {
    const before = [
      obj('p0:old:1', [100, 100, 200, 150], { kind: 'path', ordinal: 1 }),
      obj('p0:old:2', [300, 300, 400, 320], { kind: 'text', string: 'Xin chào', ordinal: 2 }),
    ];
    const after = [
      obj('p0:new:1', [150, 130, 250, 180], { kind: 'path', ordinal: 1 }),
      obj('p0:new:2', [300, 300, 400, 320], { kind: 'text', string: 'Xin chào', ordinal: 2 }),
    ];
    expect(remapSelection([before[0]!], after, { dx: 50, dy: 30 })).toEqual(['p0:new:1']);
    // Without the delta the moved object is not found.
    expect(remapSelection([before[0]!], after, { dx: 0, dy: 0 })).toEqual([]);
    expect(remapSelection([before[1]!], after, { dx: 0, dy: 0 })).toEqual(['p0:new:2']);
  });

  it('gives the pages of a list of ids', () => {
    expect(pagesOfIds(['p3:ab:1', 'p0:cd:2', 'p3:ab:9'])).toEqual([0, 3]);
  });
});

describe('keyboard and drag deltas', () => {
  it('nudges 1 pt, or 10 pt with Shift, in the four directions', () => {
    expect(nudgeFor('ArrowLeft', false)).toEqual({ dx: -1, dy: 0 });
    expect(nudgeFor('ArrowDown', true)).toEqual({ dx: 0, dy: 10 });
    expect(nudgeFor('a', false)).toBeNull();
  });

  it('ignores moves below 0.01 pt', () => {
    expect(isMeaningfulMove(0, 0)).toBe(false);
    expect(isMeaningfulMove(0.004, 0)).toBe(false);
    expect(isMeaningfulMove(0, -2)).toBe(true);
  });
});

describe('operation parameters', () => {
  it('builds duplicate parameters with the default 10 pt offset', () => {
    expect(duplicateParams(['p0:a:1'])).toEqual({ ids: ['p0:a:1'], dx: 10, dy: 10 });
  });

  it('builds colour parameters only with the channels given', () => {
    expect(colorParams(['p0:a:1'], { fill: '#ff0000' })).toEqual({
      ids: ['p0:a:1'],
      fill: '#ff0000',
    });
    expect(colorParams(['p0:a:1'], {})).toBeNull();
  });

  it('clamps opacity to 0..1', () => {
    expect(opacityParams(['p0:a:1'], 1.7).opacity).toBe(1);
    expect(opacityParams(['p0:a:1'], -0.2).opacity).toBe(0);
    expect(opacityParams(['p0:a:1'], 0.456).opacity).toBe(0.46);
  });

  it('keeps aspect unless stretched when replacing an image', () => {
    expect(replaceImageParams(0, 'p0:a:3', '/x.png', 'stretch').keepAspectBox).toBe(false);
    expect(replaceImageParams(0, 'p0:a:3', '/x.png', 'contain').keepAspectBox).toBe(true);
  });

  it('knows an identity adjustment, and clamps the adjust values', () => {
    expect(isIdentityAdjust(DEFAULT_ADJUST)).toBe(true);
    const p = adjustImageParams(2, 'p2:a:4', {
      ...DEFAULT_ADJUST,
      brightness: 250,
      gamma: 9,
      rotate: 90,
    });
    expect(p).toMatchObject({ pageIndex: 2, brightness: 100, gamma: 5, rotate: 90 });
    expect(isIdentityAdjust({ ...DEFAULT_ADJUST, grayscale: true })).toBe(false);
  });

  it('builds erase parameters; the colour only in cover mode', () => {
    const cut = eraseRegionParams(1, [10, 20, 30, 40], DEFAULT_ERASE);
    expect(cut).not.toHaveProperty('color');
    expect(cut).toMatchObject({ pageIndex: 1, rect: [10, 20, 30, 40], mode: 'cut' });
    const cover = eraseRegionParams(1, [10, 20, 30, 40], {
      ...DEFAULT_ERASE,
      mode: 'cover',
      color: '#ffffff',
    });
    expect(cover.color).toBe('#ffffff');
  });

  it('normalises a dragged rectangle', () => {
    expect(normRectPt({ x: 50, y: 40 }, { x: 10, y: 80 })).toEqual([10, 40, 50, 80]);
  });

  it('reports an erase that changed nothing', () => {
    const none = {
      removedObjects: 0,
      splitObjects: 0,
      modifiedImages: 0,
      clippedObjects: 0,
      covered: 0,
      skipped: [],
    };
    expect(eraseChangedNothing(none)).toBe(true);
    expect(eraseChangedNothing({ ...none, splitObjects: 1 })).toBe(false);
  });
});
