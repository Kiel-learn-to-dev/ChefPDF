import { describe, expect, it } from 'vitest';
import {
  brushRadiusPx,
  emptyMask,
  erasedPixels,
  maskFromRgba,
  maskToGrayRgba,
  overlayRgba,
  parseFingerPage,
  stampDisc,
  strokeLine,
} from './fingerModel';

describe('finger mask model', () => {
  it('parses a 1-based page number inside the document', () => {
    expect(parseFingerPage('3', 5)).toBe(2);
    expect(parseFingerPage(' 1 ', 5)).toBe(0);
    expect(parseFingerPage('0', 5)).toBeNull();
    expect(parseFingerPage('6', 5)).toBeNull();
    expect(parseFingerPage('2-3', 5)).toBeNull();
    expect(parseFingerPage('', 5)).toBeNull();
  });

  it('paints and clears a disc, and counts the erased pixels', () => {
    const mask = emptyMask(20, 20);
    stampDisc(mask, 10, 10, 3, 255);
    const painted = erasedPixels(mask);
    expect(painted).toBeGreaterThan(20);
    expect(mask.data[10 * 20 + 10]).toBe(255);
    stampDisc(mask, 10, 10, 3, 0);
    expect(erasedPixels(mask)).toBe(0);
  });

  it('ignores brush pixels outside the mask', () => {
    const mask = emptyMask(10, 10);
    stampDisc(mask, -5, -5, 2, 255);
    expect(erasedPixels(mask)).toBe(0);
    stampDisc(mask, 9, 9, 4, 255);
    expect(erasedPixels(mask)).toBeGreaterThan(0);
  });

  it('a stroke covers the line between its end points', () => {
    const mask = emptyMask(40, 10);
    strokeLine(mask, { x: 2, y: 5 }, { x: 37, y: 5 }, 1.5, 255);
    for (const x of [5, 20, 35]) expect(mask.data[5 * 40 + x]).toBe(255);
  });

  it('reads a mask image as erase where bright, and exports it back as grey', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const mask = maskFromRgba(2, 1, rgba);
    expect(Array.from(mask.data)).toEqual([255, 0]);
    const grey = maskToGrayRgba(mask);
    expect(Array.from(grey.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(grey.slice(4, 8))).toEqual([0, 0, 0, 255]);
  });

  it('overlays erase areas in translucent red and keeps the rest transparent', () => {
    const mask = emptyMask(2, 1);
    mask.data[0] = 255;
    const overlay = overlayRgba(mask);
    expect(overlay[3]).toBeGreaterThan(0);
    expect(overlay[7]).toBe(0);
  });

  it('keeps the brush size on screen proportional to the page', () => {
    const big = emptyMask(2000, 10);
    const small = emptyMask(1000, 10);
    expect(brushRadiusPx(24, big)).toBeGreaterThan(brushRadiusPx(24, small));
    expect(brushRadiusPx(1, small)).toBe(brushRadiusPx(4, small));
  });
});
