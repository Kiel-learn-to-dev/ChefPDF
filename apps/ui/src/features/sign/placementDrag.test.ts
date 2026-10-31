import { describe, expect, it } from 'vitest';
import { MIN_BOX_PX, boxFromDrag, handlePoints, moveBox, resizeBox } from './placementDrag';

const PAGE = { width: 600, height: 800 };

describe('boxFromDrag', () => {
  it('normalises a drag in any direction', () => {
    expect(boxFromDrag({ x: 100, y: 100 }, { x: 40, y: 60 }, PAGE, null)).toEqual({
      left: 40,
      top: 60,
      width: 60,
      height: 40,
    });
  });

  it('snaps to the page edges when the pointer leaves the page', () => {
    expect(boxFromDrag({ x: 500, y: 700 }, { x: 900, y: 900 }, PAGE, null)).toEqual({
      left: 500,
      top: 700,
      width: 100,
      height: 100,
    });
  });

  it('keeps the aspect ratio when locked', () => {
    const b = boxFromDrag({ x: 0, y: 0 }, { x: 200, y: 50 }, PAGE, 2);
    expect(b.width / b.height).toBeCloseTo(2, 9);
    expect(b.width).toBe(200);
  });
});

describe('moveBox', () => {
  it('moves and stays on the page', () => {
    const b = { left: 10, top: 10, width: 50, height: 20 };
    expect(moveBox(b, -100, 5, PAGE)).toEqual({ left: 0, top: 15, width: 50, height: 20 });
    expect(moveBox(b, 1000, 1000, PAGE)).toEqual({ left: 550, top: 780, width: 50, height: 20 });
  });
});

describe('resizeBox', () => {
  const box = { left: 100, top: 100, width: 100, height: 50 };

  it('drags the south-east corner and keeps the top-left', () => {
    expect(resizeBox(box, 'se', 30, 10, PAGE)).toEqual({
      left: 100,
      top: 100,
      width: 130,
      height: 60,
    });
  });

  it('drags the west edge and keeps the right edge', () => {
    expect(resizeBox(box, 'w', -20, 0, PAGE)).toEqual({
      left: 80,
      top: 100,
      width: 120,
      height: 50,
    });
  });

  it('never gets smaller than the minimum', () => {
    const r = resizeBox(box, 'se', -500, -500, PAGE);
    expect(r.width).toBe(MIN_BOX_PX);
    expect(r.height).toBe(MIN_BOX_PX);
    expect(r.left).toBe(100);
  });

  it('keeps the aspect on a corner drag', () => {
    const r = resizeBox(box, 'se', 100, 0, PAGE, 2);
    expect(r.width / r.height).toBeCloseTo(2, 9);
  });

  it('does not leave the page', () => {
    const r = resizeBox(box, 'se', 1000, 1000, PAGE);
    expect(r.left + r.width).toBeLessThanOrEqual(PAGE.width);
    expect(r.top + r.height).toBeLessThanOrEqual(PAGE.height);
  });

  it('handle points cover the eight positions', () => {
    const pts = handlePoints(box);
    expect(pts).toHaveLength(8);
    expect(pts.find((p) => p.handle === 'se')).toEqual({ handle: 'se', x: 200, y: 150 });
  });
});
