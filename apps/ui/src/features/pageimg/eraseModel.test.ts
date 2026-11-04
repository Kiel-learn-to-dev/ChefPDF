import { describe, expect, it } from 'vitest';
import {
  eraseParams,
  parseEraseSinglePage,
  rectFromDrag,
  stainParams,
  STAIN_PRESETS,
} from './eraseModel';

describe('erase model', () => {
  it('turns a drag into a clamped rectangle and drops tiny drags', () => {
    expect(rectFromDrag({ x: 0.6, y: 0.2 }, { x: 0.1, y: 0.4 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: expect.closeTo(0.2, 9),
    });
    expect(rectFromDrag({ x: -0.2, y: 0.1 }, { x: 1.4, y: 0.3 })).toMatchObject({ x: 0, w: 1 });
    expect(rectFromDrag({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.6 })).toBeNull();
  });

  it('parses one 1-based page and sends the rectangles with the fill', () => {
    expect(parseEraseSinglePage('2', 4)).toBe(1);
    expect(parseEraseSinglePage('2-3', 4)).toBeNull();
    expect(eraseParams(null, [{ x: 0, y: 0, w: 0.1, h: 0.1 }], 'paper')).toBeNull();
    expect(eraseParams(1, [], 'paper')).toBeNull();
    expect(eraseParams(1, [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }], '#ffffff')).toEqual({
      pageIndex: 1,
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
      fill: '#ffffff',
    });
  });

  it('sends a stain preset to every page when the field is empty, or to the given pages', () => {
    const blue = STAIN_PRESETS.find((p) => p.id === 'blue')!;
    expect(stainParams('', 5, blue)).toEqual({ hueMin: 200, hueMax: 250 });
    expect(stainParams('1, 3-4', 5, blue)).toEqual({
      pages: [0, 2, 3],
      hueMin: 200,
      hueMax: 250,
    });
    expect(stainParams('9', 5, blue)).toBeNull();
  });
});
