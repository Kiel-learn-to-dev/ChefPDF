import { describe, expect, it } from 'vitest';
import {
  MAX_COMPRESS_PRESETS,
  sanitizeCompressPresets,
  validateCompressPresets,
} from '../src/main/compressPresets';

describe('sanitizeCompressPresets (disk data)', () => {
  it('keeps valid presets, trims names and drops duplicates', () => {
    const list = sanitizeCompressPresets([
      { name: '  Email ', params: { preset: 'screen', grayscale: true } },
      { name: 'EMAIL', params: { preset: 'print' } },
      { name: 'In', params: { preset: 'print', maxImageDpi: 300, jpegQuality: 85 } },
    ]);
    expect(list).toEqual([
      { name: 'Email', params: { preset: 'screen', grayscale: true } },
      { name: 'In', params: { preset: 'print', maxImageDpi: 300, jpegQuality: 85 } },
    ]);
  });

  it('drops entries with bad types, unknown presets or out-of-range numbers', () => {
    const list = sanitizeCompressPresets([
      { name: 'a', params: { preset: 'huge' } },
      { name: 'b', params: { maxImageDpi: 5 } },
      { name: 'c', params: { jpegQuality: 1.5 } },
      { name: 'd', params: { grayscale: 'yes' } },
      { name: 'e', params: 'nope' },
      { name: '', params: {} },
      null,
    ]);
    expect(list).toEqual([]);
  });

  it('drops unknown keys (paths and page lists never survive)', () => {
    const list = sanitizeCompressPresets([
      { name: 'p', params: { preset: 'ebook', outputPath: '/x.pdf', pages: [1] } },
    ]);
    expect(list).toEqual([{ name: 'p', params: { preset: 'ebook' } }]);
  });

  it('keeps at most the maximum count and returns [] for non-arrays', () => {
    const many = Array.from({ length: MAX_COMPRESS_PRESETS + 5 }, (_, i) => ({
      name: `p${i}`,
      params: {},
    }));
    expect(sanitizeCompressPresets(many)).toHaveLength(MAX_COMPRESS_PRESETS);
    expect(sanitizeCompressPresets({})).toEqual([]);
  });

  it('refuses names that are too long', () => {
    expect(sanitizeCompressPresets([{ name: 'x'.repeat(61), params: {} }])).toEqual([]);
  });
});

describe('validateCompressPresets (renderer data)', () => {
  it('accepts a well-formed list', () => {
    expect(validateCompressPresets([{ name: 'Gửi', params: { preset: 'screen' } }])).toEqual([
      { name: 'Gửi', params: { preset: 'screen' } },
    ]);
    expect(validateCompressPresets([])).toEqual([]);
  });

  it('throws on the first bad entry and on duplicates', () => {
    expect(() => validateCompressPresets([{ name: 'a', params: { preset: 'x' } }])).toThrow(
      'Invalid compress preset',
    );
    expect(() =>
      validateCompressPresets([
        { name: 'a', params: {} },
        { name: 'A', params: {} },
      ]),
    ).toThrow('Duplicate compress preset name');
  });

  it('throws when the list is not an array or too long', () => {
    expect(() => validateCompressPresets({})).toThrow('at most');
    const many = Array.from({ length: MAX_COMPRESS_PRESETS + 1 }, (_, i) => ({
      name: `p${i}`,
      params: {},
    }));
    expect(() => validateCompressPresets(many)).toThrow('at most');
  });
});
