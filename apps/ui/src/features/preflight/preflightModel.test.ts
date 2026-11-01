import { describe, expect, it } from 'vitest';
import {
  attentionItems,
  countByStatus,
  fixActionOf,
  isRunnableFix,
  maxBytesOf,
  readChecklist,
  type CheckItem,
} from './preflightModel';

const item = (patch: Partial<CheckItem>): CheckItem => ({
  id: 'x',
  status: 'warn',
  titleVi: 'Tiêu đề',
  titleEn: 'Title',
  detail: {},
  fixOp: null,
  ...patch,
});

describe('readChecklist', () => {
  it('reads well-formed rows and drops malformed ones', () => {
    const rows = readChecklist([
      {
        id: 'fileSize',
        status: 'fail',
        titleVi: 'Dung lượng file',
        titleEn: 'File size',
        detail: { bytes: 12, limitBytes: 10 },
        fixOp: { op: 'compress.fitSize', params: { targetBytes: 10 } },
      },
      { id: 'bad', status: 'maybe' },
      'junk',
      { id: 'metadata.titleAuthor', status: 'warn' },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['fileSize', 'metadata.titleAuthor']);
    expect(rows[0]!.fixOp).toEqual({ op: 'compress.fitSize', params: { targetBytes: 10 } });
    expect(rows[1]!.titleVi).toBe('metadata.titleAuthor');
    expect(rows[1]!.fixOp).toBeNull();
  });

  it('returns nothing for non-arrays', () => {
    expect(readChecklist({ id: 'x' })).toEqual([]);
  });
});

describe('maxBytesOf', () => {
  it('converts MB and treats 0 as no limit', () => {
    expect(maxBytesOf(0)).toBeUndefined();
    expect(maxBytesOf(5)).toBe(5 * 1024 * 1024);
  });
});

describe('attentionItems and countByStatus', () => {
  it('puts failures first and counts each status', () => {
    const items = [
      item({ id: 'a', status: 'ok' }),
      item({ id: 'b', status: 'fail' }),
      item({ id: 'c' }),
    ];
    expect(attentionItems(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(countByStatus(items)).toEqual({ ok: 1, warn: 1, fail: 1 });
  });
});

describe('fixActionOf (fixOp dispatcher)', () => {
  it('no fixOp: nothing to do', () => {
    expect(fixActionOf(item({ fixOp: null }))).toEqual({ kind: 'none' });
  });

  it('runs inspect.removeHidden with the listed categories', () => {
    expect(
      fixActionOf(
        item({ fixOp: { op: 'inspect.removeHidden', params: { categories: ['javascript'] } } }),
      ),
    ).toEqual({
      kind: 'run',
      opId: 'inspect.removeHidden',
      params: { categories: ['javascript'] },
    });
  });

  it('without categories, inspect.removeHidden opens the inspect dialog instead', () => {
    expect(fixActionOf(item({ fixOp: { op: 'inspect.removeHidden', params: {} } }))).toEqual({
      kind: 'dialog',
      dialog: 'inspect',
    });
  });

  it('runs security.decrypt and page.delete directly', () => {
    expect(fixActionOf(item({ fixOp: { op: 'security.decrypt' } }))).toEqual({
      kind: 'run',
      opId: 'security.decrypt',
      params: {},
    });
    expect(
      fixActionOf(item({ fixOp: { op: 'page.delete', params: { pages: [3, 1, 3, -1, 1.5] } } })),
    ).toEqual({ kind: 'run', opId: 'page.delete', params: { pages: [3, 1] } });
  });

  it('page.delete with no valid pages falls back to the hint', () => {
    expect(fixActionOf(item({ fixOp: { op: 'page.delete', params: { pages: [] } } }))).toEqual({
      kind: 'hint',
    });
  });

  it('ops the checklist cannot run open their dialog', () => {
    expect(fixActionOf(item({ fixOp: { op: 'compress.fitSize' } }))).toEqual({
      kind: 'dialog',
      dialog: 'compress',
    });
    expect(fixActionOf(item({ fixOp: { op: 'security.encrypt' } }))).toEqual({
      kind: 'dialog',
      dialog: 'security',
    });
  });

  it('unknown ops show the hint', () => {
    expect(fixActionOf(item({ fixOp: { op: 'bookmarks.fromPages' } }))).toEqual({ kind: 'hint' });
  });

  it('isRunnableFix knows only the directly runnable ops', () => {
    expect(isRunnableFix('page.delete')).toBe(true);
    expect(isRunnableFix('compress.pdf')).toBe(false);
    expect(isRunnableFix('toString')).toBe(false);
  });
});
