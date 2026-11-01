import { describe, expect, it } from 'vitest';
import {
  itemText,
  presentFindings,
  readFindings,
  readRemoveSummary,
  removableOf,
  removeParams,
} from './inspectModel';

const tr = (key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts ?? {})}`;

const data = {
  findings: [
    {
      category: 'metadata',
      severity: 'warn',
      count: 2,
      fixAvailable: true,
      items: [
        { where: 'Info', key: 'Author', value: 'Nguyễn A' },
        { where: 'XMP', key: 'Metadata' },
      ],
    },
    {
      category: 'javascript',
      severity: 'risk',
      count: 1,
      fixAvailable: true,
      items: [{ where: 'document /OpenAction' }],
    },
    {
      category: 'hiddenText',
      severity: 'risk',
      count: 3,
      fixAvailable: false,
      items: [{ page: 2, kind: 'x', chars: 3 }],
    },
    { category: 'images', severity: 'info', count: 0, fixAvailable: false, items: [] },
    { category: 'notACategory', severity: 'risk', count: 9, fixAvailable: true, items: [] },
    {
      category: 'comments',
      severity: 'bogus',
      count: 1,
      fixAvailable: true,
      items: [{ page: 1, subtype: 'Text' }, 'junk'],
    },
  ],
};

describe('readFindings', () => {
  it('keeps known categories and normalizes severity', () => {
    const f = readFindings(data);
    expect(f.map((x) => x.category)).toEqual([
      'metadata',
      'javascript',
      'hiddenText',
      'images',
      'comments',
    ]);
    expect(f.find((x) => x.category === 'comments')?.severity).toBe('info');
  });

  it('drops non-object items', () => {
    const c = readFindings(data).find((x) => x.category === 'comments');
    expect(c?.items).toEqual([{ page: 1, subtype: 'Text' }]);
  });

  it('returns nothing for malformed data', () => {
    expect(readFindings(null)).toEqual([]);
    expect(readFindings({ findings: 'x' })).toEqual([]);
  });
});

describe('presentFindings', () => {
  it('hides empty categories and sorts most severe first', () => {
    const list = presentFindings(readFindings(data)).map((x) => x.category);
    expect(list).toEqual(['javascript', 'hiddenText', 'metadata', 'comments']);
  });
});

describe('removableOf and removeParams', () => {
  it('offers only present categories that have a fix', () => {
    expect(removableOf(readFindings(data))).toEqual(['metadata', 'javascript', 'comments']);
  });

  it('never sends hidden text or unknown categories', () => {
    expect(removeParams(['hiddenText', 'metadata', 'metadata', 'fontsNotEmbedded'])).toEqual({
      categories: ['metadata'],
    });
  });
});

describe('readRemoveSummary', () => {
  it('sums the before and after counts', () => {
    const s = readRemoveSummary({
      removed: { metadata: 2 },
      before: { metadata: 2, javascript: 1 },
      after: { metadata: 0, javascript: 0 },
    });
    expect(s.removed).toEqual({ metadata: 2 });
    expect(s.totalBefore).toBe(3);
    expect(s.totalAfter).toBe(0);
  });

  it('handles missing data', () => {
    expect(readRemoveSummary(undefined).totalBefore).toBe(0);
  });
});

describe('itemText', () => {
  it('joins the known fields in a fixed order', () => {
    expect(itemText({ where: 'Info', key: 'Author', value: 'A' }, tr)).toBe('Info · Author · = A');
    expect(itemText({ page: 3, subtype: 'Text' }, tr)).toBe('inspect.item.page:{"page":3} · Text');
    expect(itemText({}, tr)).toBe('—');
  });
});
