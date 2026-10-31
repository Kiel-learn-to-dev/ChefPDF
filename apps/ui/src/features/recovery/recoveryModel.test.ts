import { describe, expect, it } from 'vitest';
import { readRecoverable, recoveryName, sortRecoverable } from './recoveryModel';

const base = {
  sourcePath: 'D:\\Hồ sơ\\hop-dong.pdf',
  openedAt: '2026-10-30T08:00:00Z',
  lastModified: '2026-10-30T09:00:00Z',
  revision: 3,
  dirty: true,
  pages: 12,
  hasUnsavedChanges: true,
};

describe('readRecoverable', () => {
  it('keeps well-formed sessions and drops the rest', () => {
    const list = readRecoverable([
      { ...base, sessionId: 'a' },
      { ...base, sessionId: '' },
      { ...base, sessionId: 'b', revision: 'x' },
      'nope',
      null,
    ]);
    expect(list.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('returns an empty list when the core sends something else', () => {
    expect(readRecoverable(undefined)).toEqual([]);
    expect(readRecoverable({ sessions: [] })).toEqual([]);
  });

  it('keeps a null source path (untitled document)', () => {
    const [s] = readRecoverable([{ ...base, sessionId: 'u', sourcePath: null }]);
    expect(s?.sourcePath).toBeNull();
  });
});

describe('sortRecoverable', () => {
  it('lists the newest change first and drops duplicate session ids', () => {
    const list = sortRecoverable(
      readRecoverable([
        { ...base, sessionId: 'old', lastModified: '2026-10-29T10:00:00Z' },
        { ...base, sessionId: 'new', lastModified: '2026-10-31T10:00:00Z' },
        { ...base, sessionId: 'new', lastModified: '2026-10-31T11:00:00Z' },
      ]),
    );
    expect(list.map((s) => s.sessionId)).toEqual(['new', 'old']);
    expect(list[0]?.lastModified).toBe('2026-10-31T11:00:00Z');
  });
});

describe('recoveryName', () => {
  it('uses the file name of the source path, or null when untitled', () => {
    expect(recoveryName({ ...base, sessionId: 'a' })).toBe('hop-dong.pdf');
    expect(recoveryName({ ...base, sessionId: 'a', sourcePath: null })).toBeNull();
  });
});
