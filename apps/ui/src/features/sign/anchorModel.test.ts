import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANCHOR_FORM,
  DEFAULT_FIXED_FORM,
  MAX_RECENT_ANCHORS,
  anchorPlacementParams,
  fixedPlacementParams,
  placeFromAnchorParams,
  rememberAnchor,
  validateAnchorForm,
  validateFixedForm,
} from './anchorModel';

describe('rememberAnchor', () => {
  it('puts the newest text first and does not repeat a text', () => {
    let list: string[] = [];
    list = rememberAnchor(list, 'GIÁM ĐỐC');
    list = rememberAnchor(list, 'Người ký');
    list = rememberAnchor(list, 'giam doc');
    expect(list).toEqual(['giam doc', 'Người ký']);
  });

  it('trims and collapses spaces, ignores empty text', () => {
    expect(rememberAnchor([], '   NGƯỜI   KÝ  ')).toEqual(['NGƯỜI KÝ']);
    expect(rememberAnchor(['a'], '   ')).toEqual(['a']);
  });

  it('keeps at most the recent limit', () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_RECENT_ANCHORS + 3; i++) list = rememberAnchor(list, `chữ ${i}`);
    expect(list).toHaveLength(MAX_RECENT_ANCHORS);
    expect(list[0]).toBe(`chữ ${MAX_RECENT_ANCHORS + 2}`);
  });
});

describe('validateAnchorForm', () => {
  it('accepts the defaults with a text', () => {
    expect(validateAnchorForm({ ...DEFAULT_ANCHOR_FORM, text: 'GIÁM ĐỐC' })).toBeNull();
  });

  it('asks for a text and in-range sizes', () => {
    expect(validateAnchorForm(DEFAULT_ANCHOR_FORM)).toEqual({ field: 'text' });
    expect(validateAnchorForm({ ...DEFAULT_ANCHOR_FORM, text: 'x', widthMm: 0 })).toEqual({
      field: 'widthMm',
    });
    expect(validateAnchorForm({ ...DEFAULT_ANCHOR_FORM, text: 'x', offsetYPt: 9999 })).toEqual({
      field: 'offsetYPt',
    });
  });
});

describe('op params', () => {
  it('sends the box size in points, with the anchor options', () => {
    const p = anchorPlacementParams({
      ...DEFAULT_ANCHOR_FORM,
      text: '  GIÁM ĐỐC ',
      widthMm: 25.4,
      heightMm: 12.7,
      position: 'above',
      whichMatch: 'last',
      onMissing: 'fail',
    });
    expect(p).toEqual({
      kind: 'anchor',
      text: 'GIÁM ĐỐC',
      position: 'above',
      width: 72,
      height: 36,
      offsetX: 0,
      offsetY: 0,
      align: 'center',
      ignoreDiacritics: true,
      whichMatch: 'last',
      onMissing: 'fail',
    });
  });

  it('places boxes for the found matches', () => {
    const p = placeFromAnchorParams(
      { ...DEFAULT_ANCHOR_FORM, text: 'x', widthMm: 25.4, heightMm: 25.4 },
      [{ pageIndex: 1, rect: [100, 200, 150, 210] }],
    );
    expect(p.anchors).toEqual([{ pageIndex: 1, rect: [100, 200, 150, 210] }]);
    expect(p.width).toBe(72);
    expect(p.position).toBe('below');
  });

  it('fixed positions: corner, margin and page', () => {
    expect(validateFixedForm(DEFAULT_FIXED_FORM)).toBeNull();
    expect(
      fixedPlacementParams({ ...DEFAULT_FIXED_FORM, corner: 'top-left', page: 0, marginPt: 20 }),
    ).toEqual({
      kind: 'fixed',
      corner: 'top-left',
      width: 141.732,
      height: 56.693,
      margin: 20,
      page: 0,
    });
  });
});
