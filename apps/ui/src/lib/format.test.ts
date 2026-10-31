import { describe, expect, it } from 'vitest';
import { formatBytes, formatPageSize, parsePdfDate } from './format';

describe('format', () => {
  it('bytes', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(2.4 * 1024 * 1024, 'vi')).toBe('2,4 MB');
  });

  it('page size with paper name', () => {
    expect(formatPageSize(595.28, 841.89, 'en')).toBe('210 × 297 mm (A4)');
    expect(formatPageSize(841.89, 595.28, 'vi', 'ngang')).toBe('297 × 210 mm (A4, ngang)');
    expect(formatPageSize(100, 100, 'en')).toBe('35 × 35 mm');
  });

  it('pdf dates', () => {
    expect(parsePdfDate("D:20240305101500+07'00'")?.toISOString()).toBe('2024-03-05T03:15:00.000Z');
    expect(parsePdfDate('D:20240305')?.getFullYear()).toBe(2024);
    expect(parsePdfDate('2024-01-02T00:00:00Z')?.toISOString()).toBe('2024-01-02T00:00:00.000Z');
    expect(parsePdfDate('garbage')).toBeNull();
  });
});
