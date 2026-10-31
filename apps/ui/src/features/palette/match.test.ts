import { describe, expect, it } from 'vitest';
import { rankMatches, scoreMatch } from './match';

const items = [
  { id: 'sign', title: 'Ký số', keywords: ['chữ ký', 'signature'] },
  { id: 'stamp', title: 'Đóng dấu' },
  { id: 'merge', title: 'Ghép file', keywords: ['merge', 'gộp'] },
  { id: 'split', title: 'Tách file', keywords: ['split'] },
  { id: 'scan', title: 'Chuyển thành bản scan' },
  { id: 'rotate', title: 'Xoay trang' },
];

describe('command palette matching', () => {
  it('matches without diacritics', () => {
    expect(rankMatches('ky so', items)[0]?.id).toBe('sign');
    expect(rankMatches('dong dau', items)[0]?.id).toBe('stamp');
  });

  it('handles đ → d', () => {
    expect(scoreMatch('dong', { id: 'x', title: 'Đóng dấu' })).not.toBeNull();
  });

  it('matches word prefixes and keywords', () => {
    expect(rankMatches('ban sc', items)[0]?.id).toBe('scan');
    expect(rankMatches('merge', items)[0]?.id).toBe('merge');
    expect(rankMatches('gop', items)[0]?.id).toBe('merge');
  });

  it('ranks prefix above substring', () => {
    const ranked = rankMatches('file', [
      { id: 'a', title: 'Ghép file' },
      { id: 'b', title: 'File gần đây' },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('fuzzy subsequence', () => {
    expect(rankMatches('xtr', items)[0]?.id).toBe('rotate');
  });

  it('excludes non-matches and keeps all for empty query', () => {
    expect(rankMatches('zzz', items)).toEqual([]);
    expect(rankMatches('', items)).toHaveLength(items.length);
  });
});
