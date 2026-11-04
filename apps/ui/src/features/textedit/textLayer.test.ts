import { describe, expect, it } from 'vitest';
import { textLayerLabel } from './textLayer';

describe('text layer label (B12)', () => {
  it('says text, scan or mixed, and nothing for a document without pages', () => {
    expect(textLayerLabel({ pages: 3, textPages: 3 })).toBe('Có chữ');
    expect(textLayerLabel({ pages: 3, textPages: 0 })).toBe('Bản scan, không có chữ');
    expect(textLayerLabel({ pages: 3, textPages: 1 })).toBe('Hỗn hợp: 1/3 trang có chữ');
    expect(textLayerLabel({ pages: 0, textPages: 0 })).toBeNull();
    expect(textLayerLabel(null)).toBeNull();
  });
});
