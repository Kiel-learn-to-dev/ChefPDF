import { describe, expect, it } from 'vitest';
import {
  applyParams,
  DEFAULT_ADJUST,
  dpiValid,
  enhanceSettings,
  levelsValid,
  parseAdjustPage,
  previewParams,
} from './adjustModel';

describe('adjust model', () => {
  it('sends nothing for the default settings', () => {
    expect(enhanceSettings(DEFAULT_ADJUST)).toEqual({});
    expect(applyParams(DEFAULT_ADJUST, '', 5)).toEqual({});
  });

  it('sends levels, curve and clean-up only when they change', () => {
    const state = {
      ...DEFAULT_ADJUST,
      whiten: true,
      whitenStrength: 1,
      black: 10,
      white: 240,
      gamma: 1.2,
      curve: [0, 70, 128, 192, 250],
      invert: true,
    };
    expect(enhanceSettings(state)).toEqual({
      whiten: true,
      whitenStrength: 1,
      levels: { black: 10, white: 240, gamma: 1.2 },
      curve: [
        { input: 0, output: 0 },
        { input: 64, output: 70 },
        { input: 128, output: 128 },
        { input: 192, output: 192 },
        { input: 255, output: 250 },
      ],
      invert: true,
    });
  });

  it('refuses white at or below black, and a DPI outside 50-1200', () => {
    expect(levelsValid({ ...DEFAULT_ADJUST, black: 100, white: 100 })).toBe(false);
    expect(applyParams({ ...DEFAULT_ADJUST, black: 100, white: 50 }, '', 3)).toBeNull();
    expect(dpiValid({ ...DEFAULT_ADJUST, dpi: '30' })).toBe(false);
    expect(dpiValid({ ...DEFAULT_ADJUST, dpi: '300' })).toBe(true);
    expect(enhanceSettings({ ...DEFAULT_ADJUST, dpi: '300', resizePage: true })).toEqual({
      dpi: 300,
      resizePage: true,
    });
  });

  it('keeps the page range and drops the DPI from the preview', () => {
    expect(applyParams({ ...DEFAULT_ADJUST, grayscale: true }, '2-3', 5)).toEqual({
      pages: [1, 2],
      grayscale: true,
    });
    expect(applyParams(DEFAULT_ADJUST, '9', 5)).toBeNull();
    expect(previewParams({ ...DEFAULT_ADJUST, dpi: '150' }, 0)).toEqual({ pageIndex: 0 });
    expect(parseAdjustPage('3', 5)).toBe(2);
    expect(parseAdjustPage('6', 5)).toBeNull();
  });
});
