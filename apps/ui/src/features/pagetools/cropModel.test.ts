import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CROP_FORM,
  DEFAULT_RESIZE_FORM,
  cropIssues,
  cropParams,
  resizeIssues,
  resizeParams,
  type CropForm,
  type ResizeForm,
} from './cropModel';

const crop = (patch: Partial<CropForm> = {}): CropForm => ({ ...DEFAULT_CROP_FORM, ...patch });
const resize = (patch: Partial<ResizeForm> = {}): ResizeForm => ({
  ...DEFAULT_RESIZE_FORM,
  ...patch,
});

describe('crop', () => {
  it('builds margins params in mm with exactly one method', () => {
    const p = cropParams(
      crop({ method: 'margins', margins: { top: 5, right: 0, bottom: 10, left: 2 } }),
      5,
    );
    expect(p).toEqual({ scope: 'all', margins: { top: 5, right: 0, bottom: 10, left: 2 } });
    expect(p.box).toBeUndefined();
    expect(p.autoTrim).toBeUndefined();
  });

  it('builds the box params in points', () => {
    expect(cropParams(crop({ method: 'box', box: [10, 20, 300, 400] }), 5)).toEqual({
      scope: 'all',
      box: [10, 20, 300, 400],
    });
  });

  it('builds the auto-trim params with padding', () => {
    expect(cropParams(crop({ method: 'autoTrim', paddingMm: 4 }), 5)).toEqual({
      scope: 'all',
      autoTrim: true,
      trimPaddingMm: 4,
    });
  });

  it('flags negative margins, a bad box and a missing page list', () => {
    expect(
      cropIssues(
        crop({ method: 'margins', margins: { top: -1, right: 0, bottom: 0, left: 0 } }),
        5,
      ),
    ).toEqual(['margins']);
    expect(cropIssues(crop({ method: 'box', box: [10, 10, 5, 50] }), 5)).toEqual(['box']);
    expect(cropIssues(crop({ scope: 'pages', pagesText: '' }), 5)).toEqual(['pages']);
    expect(cropIssues(crop({ method: 'autoTrim' }), 5)).toEqual([]);
  });

  it('sends the page list for scope pages (0-based)', () => {
    expect(
      cropParams(crop({ method: 'autoTrim', scope: 'pages', pagesText: '2' }), 5),
    ).toMatchObject({ scope: 'pages', pages: [1] });
  });
});

describe('resize', () => {
  it('sends the preset size and fit', () => {
    expect(resizeParams(resize({ size: 'A3', fit: 'center' }), 5)).toEqual({
      scope: 'all',
      size: 'A3',
      fit: 'center',
    });
  });

  it('needs a positive custom size only for custom', () => {
    expect(
      resizeIssues(resize({ size: 'custom', customWidthMm: 0, customHeightMm: 100 }), 5),
    ).toEqual(['customSize']);
    expect(resizeIssues(resize({ size: 'A4', customWidthMm: 0 }), 5)).toEqual([]);
    expect(
      resizeParams(resize({ size: 'custom', customWidthMm: 100, customHeightMm: 150 }), 5),
    ).toMatchObject({ size: 'custom', customWidthMm: 100, customHeightMm: 150 });
  });
});
