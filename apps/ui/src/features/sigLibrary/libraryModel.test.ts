import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_TYPED,
  cleanupParams,
  fromStrokesParams,
  itemName,
  normalizeBackground,
  normalizeCleanup,
  pressureFor,
  removeBackgroundParams,
  strokesToParams,
  textSignatureParams,
  type RawPoint,
} from './libraryModel';

const pt = (x: number, y: number, t: number, pointerType = 'mouse', pressure = 0): RawPoint => ({
  x,
  y,
  t,
  pressure,
  pointerType,
});

describe('option clamping (ranges of the core parameters)', () => {
  it('keeps background options inside their ranges', () => {
    expect(
      normalizeBackground({ tolerance: 900, sensitivity: -4, feather: 40, mode: 'nope' as never }),
    ).toEqual({
      mode: 'auto',
      tolerance: 200,
      sensitivity: 0,
      feather: 5,
    });
    expect(normalizeBackground({})).toEqual(DEFAULT_BACKGROUND);
  });

  it('keeps cleanup options inside their ranges and allows only the size steps', () => {
    expect(normalizeCleanup({ minBlobPx: 999, thicken: -20, contrast: 0, maxSide: 123 })).toEqual({
      minBlobPx: 200,
      straighten: false,
      thicken: -5,
      contrast: 0.2,
      maxSide: 0,
    });
    expect(normalizeCleanup({ maxSide: 800 }).maxSide).toBe(800);
  });
});

describe('parameter builders', () => {
  it('builds removeBackground and cleanup parameters', () => {
    expect(
      removeBackgroundParams({ ...DEFAULT_BACKGROUND, mode: 'ink-color' }, '/in.jpg', '/out.png'),
    ).toEqual({
      inputPath: '/in.jpg',
      outputPath: '/out.png',
      mode: 'ink-color',
      tolerance: 60,
      sensitivity: 50,
      feather: 1,
    });
    const c = cleanupParams(
      { minBlobPx: 4, straighten: true, thicken: 1, contrast: 1.2, maxSide: 400 },
      '/a.png',
      '/b.png',
    );
    expect(c).toMatchObject({
      minBlobPx: 4,
      straighten: true,
      thicken: 1,
      contrast: 1.2,
      maxWidth: 400,
      maxHeight: 400,
    });
    expect(
      cleanupParams(
        { minBlobPx: 0, straighten: false, thicken: 0, contrast: 1, maxSide: 0 },
        '/a',
        '/b',
      ),
    ).not.toHaveProperty('maxWidth');
  });

  it('builds the typed signature with the bundled or a chosen font', () => {
    const bundled = textSignatureParams({ ...DEFAULT_TYPED, text: '  Nguyễn Văn An  ' }, '/o.png');
    expect(bundled).toMatchObject({
      text: 'Nguyễn Văn An',
      fontName: 'BeVietnamPro',
      colorHex: '#1F3A93',
      outputPath: '/o.png',
    });
    expect(bundled).not.toHaveProperty('fontPath');
    const custom = textSignatureParams(
      {
        ...DEFAULT_TYPED,
        text: 'A',
        font: { kind: 'file', path: '/fonts/hand.ttf' },
        colorHex: 'red',
        sizePx: 9999,
        slantDeg: 90,
      },
      '/o.png',
    );
    expect(custom).toMatchObject({
      fontName: null,
      fontPath: '/fonts/hand.ttf',
      colorHex: '#1F3A93',
      sizePx: 400,
      slantDeg: 45,
    });
  });
});

describe('pressure', () => {
  it('uses the pen pressure when the pen reports one', () => {
    expect(pressureFor(pt(0, 0, 0, 'pen', 0.7), null)).toBeCloseTo(0.7);
    expect(pressureFor(pt(0, 0, 0, 'pen', 2), null)).toBe(1);
  });

  it('makes a fast mouse stroke thinner than a slow one, within 0.5 to 1', () => {
    const prev = pt(0, 0, 0);
    const slow = pressureFor(pt(1, 0, 100), prev); // 0.01 px/ms
    const fast = pressureFor(pt(200, 0, 10), prev); // 20 px/ms
    expect(slow).toBeGreaterThan(fast);
    expect(slow).toBeLessThanOrEqual(1);
    expect(fast).toBeGreaterThanOrEqual(0.5);
    expect(fast).toBe(0.5);
  });

  it('gives the first point of a mouse stroke a middle weight', () => {
    expect(pressureFor(pt(5, 5, 0), null)).toBe(0.8);
  });
});

describe('strokes to the core format', () => {
  it('keeps the points in order, rounds them and drops empty strokes', () => {
    const params = strokesToParams([
      [pt(1.23456, 2, 0), pt(3, 4, 16)],
      [],
      [pt(9, 9, 0, 'pen', 0.5)],
    ]);
    expect(params).toHaveLength(2);
    expect(params[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [1.23, 2],
      [3, 4],
    ]);
    expect(params[0]!.points[1]!.t).toBe(16);
    expect(params[1]!.points[0]!.pressure).toBe(0.5);
  });

  it('builds the image.fromStrokes params with the canvas size', () => {
    const p = fromStrokesParams([[pt(0, 0, 0)]], { width: 600, height: 220 }, '/s.png');
    expect(p).toMatchObject({
      canvasWidth: 600,
      canvasHeight: 220,
      outputPath: '/s.png',
      colorHex: '#1F3A93',
    });
  });
});

describe('item names', () => {
  it('trims and falls back to the default', () => {
    expect(itemName('  Con dấu  ', 'x')).toBe('Con dấu');
    expect(itemName('   ', 'Chữ ký 1')).toBe('Chữ ký 1');
    expect(itemName('a'.repeat(120), 'x')).toHaveLength(80);
  });
});
