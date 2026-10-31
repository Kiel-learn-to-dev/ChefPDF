import { describe, expect, it } from 'vitest';
import { MAX_TSA_URLS, cleanTsaUrls, validTsaUrl } from './tsa';

describe('validTsaUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(validTsaUrl('http://tsa.example.vn/tsa')).toBe('http://tsa.example.vn/tsa');
    expect(validTsaUrl('  https://timestamp.example/ ')).toBe('https://timestamp.example/');
  });

  it('refuses other schemes, relative paths, spaces and garbage', () => {
    expect(validTsaUrl('ftp://tsa.example/')).toBeNull();
    expect(validTsaUrl('file:///etc/passwd')).toBeNull();
    expect(validTsaUrl('/tsa')).toBeNull();
    expect(validTsaUrl('https://tsa example.vn')).toBeNull();
    expect(validTsaUrl('not a url')).toBeNull();
    expect(validTsaUrl('')).toBeNull();
    expect(validTsaUrl('https://' + 'a'.repeat(3000))).toBeNull();
  });
});

describe('cleanTsaUrls', () => {
  it('keeps the order, drops duplicates and blanks, reports invalid entries', () => {
    expect(
      cleanTsaUrls(['https://a.vn/tsa', '', 'nope', 'https://a.vn/tsa', 'http://b.vn/ts']),
    ).toEqual({
      urls: ['https://a.vn/tsa', 'http://b.vn/ts'],
      invalid: ['nope'],
      tooMany: false,
    });
  });

  it('caps the list at five and says so', () => {
    const many = Array.from({ length: MAX_TSA_URLS + 2 }, (_, i) => `https://t${i}.vn/`);
    const r = cleanTsaUrls(many);
    expect(r.urls).toHaveLength(MAX_TSA_URLS);
    expect(r.urls[0]).toBe('https://t0.vn/');
    expect(r.tooMany).toBe(true);
  });
});
