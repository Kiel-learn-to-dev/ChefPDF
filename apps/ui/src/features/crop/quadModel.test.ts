import { expect, it } from 'vitest';
import { pointAt, validQuad, resizeRectangle, snapRectangleTarget } from './quadModel';

it('clamps dragged points and rejects degenerate or crossed corners', () => {
  expect(pointAt(150, -10, { left: 0, top: 0, width: 100, height: 100 })).toEqual({ x: 1, y: 0 });
  expect(
    validQuad([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]),
  ).toBe(true);
  expect(
    validQuad([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]),
  ).toBe(false);
});

it('moves rectangle edges without changing unrelated edges', () => {
  const rect = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];
  expect(resizeRectangle(rect, 'right', { x: 0.6, y: 0.1 })).toEqual([
    { x: 0.2, y: 0.2 },
    { x: 0.6, y: 0.2 },
    { x: 0.6, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ]);
  expect(validQuad(resizeRectangle(rect, 'left', { x: 1, y: 0.5 }))).toBe(true);
});

it('snaps only dragged sides near detected edges', () => {
  const detected = [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.18 },
    { x: 0.88, y: 0.85 },
    { x: 0.12, y: 0.83 },
  ];
  expect(snapRectangleTarget('left', { x: 0.108, y: 0.5 }, detected, 0.01, 0.01)).toEqual({
    x: 0.1,
    y: 0.5,
  });
  expect(snapRectangleTarget('topRight', { x: 0.895, y: 0.182 }, detected, 0.01, 0.01)).toEqual({
    x: 0.9,
    y: 0.18,
  });
  expect(snapRectangleTarget('right', { x: 0.85, y: 0.5 }, detected, 0.01, 0.01)).toEqual({
    x: 0.85,
    y: 0.5,
  });
});

it('keeps a locked ratio while moving corners or sides inside the image', () => {
  const rect = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];
  for (const handle of ['topLeft', 'right', 'bottom'] as const) {
    const result = resizeRectangle(rect, handle, { x: 0.95, y: 0.1 }, 1);
    expect(validQuad(result)).toBe(true);
    expect((result[1]!.x - result[0]!.x) / (result[3]!.y - result[0]!.y)).toBeCloseTo(1);
    expect(result.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
  }
});
