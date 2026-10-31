import { describe, expect, it } from 'vitest';
import { findMatches, fold, foldWithMap, includesFolded } from './diacritics';

describe('fold', () => {
  it('strips Vietnamese diacritics and lower-cases', () => {
    expect(fold('Nghị định')).toBe('nghi dinh');
    expect(fold('Ký số')).toBe('ky so');
    expect(fold('Tiếng Việt có dấu ưươơăâê')).toBe('tieng viet co dau uuooaae');
  });

  it('maps đ/Đ to d', () => {
    expect(fold('Đóng dấu')).toBe('dong dau');
    expect(fold('đường')).toBe('duong');
  });

  it('keeps case when asked', () => {
    expect(fold('Đà Nẵng', { caseSensitive: true })).toBe('Da Nang');
  });

  it('collapses whitespace', () => {
    expect(fold('a \n\t b')).toBe('a b');
  });

  it('handles precomposed and decomposed input identically', () => {
    const nfc = 'nghị'.normalize('NFC');
    const nfd = 'nghị'.normalize('NFD');
    expect(fold(nfc)).toBe(fold(nfd));
  });

  it('builds an index map back to the original', () => {
    const { folded, map } = foldWithMap('Đẹp');
    expect(folded).toBe('dep');
    expect(map).toEqual([0, 1, 2]);
  });
});

describe('findMatches', () => {
  it('finds unaccented queries in accented text', () => {
    const text = 'Theo nghị định số 30, NGHỊ ĐỊNH này';
    const m = findMatches(text, 'nghi dinh');
    expect(m).toHaveLength(2);
    expect(text.slice(m[0]!.index, m[0]!.index + m[0]!.length)).toBe('nghị định');
    expect(text.slice(m[1]!.index, m[1]!.index + m[1]!.length)).toBe('NGHỊ ĐỊNH');
  });

  it('matches accented query too', () => {
    expect(findMatches('ký số điện tử', 'Ký Số')).toHaveLength(1);
  });

  it('includes trailing combining marks in decomposed text', () => {
    const text = 'nghị định';
    const [m] = findMatches(text, 'nghi dinh');
    expect(m).toEqual({ index: 0, length: text.length });
  });

  it('respects entire word', () => {
    expect(findMatches('dinh định đinh', 'dinh', { entireWord: true })).toHaveLength(3);
    expect(findMatches('dinhdinh', 'dinh', { entireWord: true })).toHaveLength(0);
  });

  it('returns nothing for empty query', () => {
    expect(findMatches('abc', '  ')).toEqual([]);
  });
});

describe('includesFolded', () => {
  it('matches every token', () => {
    expect(includesFolded('Chuyển thành bản scan', 'ban scan')).toBe(true);
    expect(includesFolded('Chuyển thành bản scan', 'scan chuyen')).toBe(true);
    expect(includesFolded('Chuyển thành bản scan', 'nen')).toBe(false);
  });
});
