import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPRESS_FORM,
  applyPreset,
  compressParams,
  formFromParams,
  formIssues,
  percentSaved,
  readCompressReport,
  readFitResult,
  readUserPresets,
  targetBytesOf,
  validatePresetName,
} from './compressModel';

describe('applyPreset', () => {
  it('sets the image settings of the preset and keeps the flags', () => {
    const f = applyPreset({ ...DEFAULT_COMPRESS_FORM, grayscale: true }, 'screen');
    expect(f).toMatchObject({
      preset: 'screen',
      maxImageDpi: 96,
      jpegQuality: 55,
      grayscale: true,
    });
    expect(f.removeThumbnails).toBe(true);
  });

  it('archive-light has no resampling', () => {
    const f = applyPreset(DEFAULT_COMPRESS_FORM, 'archive-light');
    expect(f.maxImageDpi).toBeNull();
    expect(f.jpegQuality).toBeNull();
  });

  it('custom keeps the values the user set', () => {
    const f = applyPreset({ ...DEFAULT_COMPRESS_FORM, maxImageDpi: 120 }, 'custom');
    expect(f.preset).toBe('custom');
    expect(f.maxImageDpi).toBe(120);
  });
});

describe('formIssues', () => {
  it('flags dpi and quality outside the core limits', () => {
    expect(formIssues({ ...DEFAULT_COMPRESS_FORM, maxImageDpi: 20 })).toEqual(['dpi']);
    expect(formIssues({ ...DEFAULT_COMPRESS_FORM, jpegQuality: 101 })).toEqual(['quality']);
    expect(formIssues({ ...DEFAULT_COMPRESS_FORM, jpegQuality: 70.5 })).toEqual(['quality']);
    expect(formIssues(DEFAULT_COMPRESS_FORM)).toEqual([]);
  });
});

describe('compressParams', () => {
  it('sends the contract field names and leaves empty image settings out', () => {
    const p = compressParams(applyPreset(DEFAULT_COMPRESS_FORM, 'archive-light'));
    expect(p).toEqual({
      preset: 'archive-light',
      grayscale: false,
      removeUnused: true,
      removeMetadata: false,
      removeThumbnails: false,
      removeAttachments: false,
      subsetFonts: true,
      flattenTransparency: false,
    });
    expect('maxImageDpi' in p).toBe(false);
  });

  it('sends the explicit image settings', () => {
    const p = compressParams(applyPreset(DEFAULT_COMPRESS_FORM, 'print'));
    expect(p).toMatchObject({ maxImageDpi: 300, jpegQuality: 85 });
  });
});

describe('formFromParams', () => {
  it('reads a preset name and the explicit values', () => {
    const f = formFromParams({
      preset: 'screen',
      maxImageDpi: 72,
      jpegQuality: 40,
      grayscale: true,
    });
    expect(f).toMatchObject({
      preset: 'screen',
      maxImageDpi: 72,
      jpegQuality: 40,
      grayscale: true,
    });
  });

  it('unknown or missing values fall back to safe defaults', () => {
    const f = formFromParams({ preset: 'weird', maxImageDpi: 'x', jpegQuality: 500 });
    expect(f.preset).toBe('custom');
    expect(f.maxImageDpi).toBeNull();
    expect(f.jpegQuality).toBeNull();
    expect(f.subsetFonts).toBe(true);
  });

  it('accepts nothing', () => {
    expect(formFromParams(null).preset).toBe('custom');
  });
});

describe('validatePresetName', () => {
  it('rejects empty, long and duplicate names (case-insensitive)', () => {
    expect(validatePresetName('  ', [])).toBe('empty');
    expect(validatePresetName('x'.repeat(61), [])).toBe('tooLong');
    expect(validatePresetName('Gửi email', ['gửi EMAIL'])).toBe('duplicate');
    expect(validatePresetName('Gửi email', ['khác'])).toBeNull();
  });
});

describe('readUserPresets', () => {
  it('keeps valid, unique presets and drops the rest', () => {
    const list = readUserPresets([
      { name: ' Email ', params: { preset: 'screen' } },
      { name: 'email', params: {} },
      { name: '', params: {} },
      { name: 'Thiếu params' },
      'junk',
      { name: 'In', params: { preset: 'print' } },
    ]);
    expect(list.map((p) => p.name)).toEqual(['Email', 'In']);
  });

  it('returns nothing for non-arrays', () => {
    expect(readUserPresets({})).toEqual([]);
  });
});

describe('targetBytesOf', () => {
  it('converts MB to bytes and rejects non-positive sizes', () => {
    expect(targetBytesOf(2)).toBe(2 * 1024 * 1024);
    expect(targetBytesOf(0)).toBeNull();
    expect(targetBytesOf(Number.NaN)).toBeNull();
  });
});

describe('readCompressReport', () => {
  it('reads sizes, ratio, skipped reasons and warnings', () => {
    const r = readCompressReport({
      bytesBefore: 1000,
      bytesAfter: 250,
      ratio: 0.25,
      imagesProcessed: 3,
      imagesSkipped: 2,
      skippedReasons: { jpeg2000: 1, bilevel: 0, stencil: 1, bad: 'x' },
      warnings: ['ok', 3],
    });
    expect(r.bytesAfter).toBe(250);
    expect(r.skipped).toEqual([
      { reason: 'jpeg2000', count: 1 },
      { reason: 'stencil', count: 1 },
    ]);
    expect(r.warnings).toEqual(['ok']);
    expect(percentSaved(r.bytesBefore, r.bytesAfter)).toBe(75);
  });

  it('percentSaved is zero when the file did not shrink', () => {
    expect(percentSaved(100, 120)).toBe(0);
    expect(percentSaved(0, 0)).toBe(0);
  });
});

describe('readFitResult', () => {
  it('returns the params as a custom form and the reachability', () => {
    const r = readFitResult({
      params: { preset: 'ebook', maxImageDpi: 110, jpegQuality: 48 },
      estimatedBytes: 900,
      reachable: false,
    });
    expect(r?.form).toMatchObject({ preset: 'custom', maxImageDpi: 110, jpegQuality: 48 });
    expect(r?.reachable).toBe(false);
    expect(r?.estimatedBytes).toBe(900);
  });

  it('is null without params', () => {
    expect(readFitResult({ reachable: true })).toBeNull();
  });
});
