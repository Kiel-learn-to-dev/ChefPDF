import { describe, expect, it } from 'vitest';
import type { KnownPfxFile } from '@chef/contracts';
import {
  MAX_KNOWN_PFX,
  fileNameOf,
  findKnownPfx,
  removeKnownPfx,
  setRemembered,
  upsertKnownPfx,
} from './pfxList';

const posix = { caseInsensitive: false };
const windows = { caseInsensitive: true };

describe('fileNameOf', () => {
  it('handles both separators', () => {
    expect(fileNameOf('/home/a/chu-ky.pfx')).toBe('chu-ky.pfx');
    expect(fileNameOf('C:\\Certs\\chu-ky.p12')).toBe('chu-ky.p12');
    expect(fileNameOf('plain.pfx')).toBe('plain.pfx');
  });
});

describe('known PFX list', () => {
  it('adds a new file at the front with its file name as label', () => {
    const list = upsertKnownPfx([], '/c/a.pfx', posix);
    expect(list).toEqual([{ path: '/c/a.pfx', label: 'a.pfx', remembered: false }]);
  });

  it('moves an existing file to the front and keeps its label and remembered flag', () => {
    const start: KnownPfxFile[] = [
      { path: '/c/b.pfx', label: 'Bạn B', remembered: false },
      { path: '/c/a.pfx', label: 'Ký A', remembered: true },
    ];
    const list = upsertKnownPfx(start, '/c/a.pfx', posix);
    expect(list.map((e) => e.path)).toEqual(['/c/a.pfx', '/c/b.pfx']);
    expect(list[0]).toEqual({ path: '/c/a.pfx', label: 'Ký A', remembered: true });
  });

  it('applies a patch to the label or the remembered flag', () => {
    const list = upsertKnownPfx([], '/c/a.pfx', posix, { label: 'Giám đốc', remembered: true });
    expect(list[0]).toEqual({ path: '/c/a.pfx', label: 'Giám đốc', remembered: true });
  });

  it('compares Windows paths case-insensitively', () => {
    const start = upsertKnownPfx([], 'C:\\Certs\\A.pfx', windows);
    const list = upsertKnownPfx(start, 'c:\\certs\\a.pfx', windows);
    expect(list).toHaveLength(1);
    expect(findKnownPfx(list, 'C:\\CERTS\\a.PFX', windows)).toBeDefined();
    expect(findKnownPfx(list, 'C:\\Certs\\a.pfx', posix)).toBeUndefined();
  });

  it('caps the list at MAX_KNOWN_PFX, dropping the oldest', () => {
    let list: KnownPfxFile[] = [];
    for (let i = 0; i < MAX_KNOWN_PFX + 3; i++) list = upsertKnownPfx(list, `/c/f${i}.pfx`, posix);
    expect(list).toHaveLength(MAX_KNOWN_PFX);
    expect(list[0]?.path).toBe(`/c/f${MAX_KNOWN_PFX + 2}.pfx`);
    expect(list.some((e) => e.path === '/c/f0.pfx')).toBe(false);
  });

  it('removes one file and leaves the rest in order', () => {
    const list = [
      { path: '/c/a.pfx', label: 'a', remembered: false },
      { path: '/c/b.pfx', label: 'b', remembered: true },
    ];
    expect(removeKnownPfx(list, '/c/a.pfx', posix)).toEqual([list[1]]);
    expect(removeKnownPfx(list, '/c/none.pfx', posix)).toEqual(list);
  });

  it('sets the remembered flag of one file only', () => {
    const list = [
      { path: '/c/a.pfx', label: 'a', remembered: false },
      { path: '/c/b.pfx', label: 'b', remembered: false },
    ];
    const next = setRemembered(list, '/c/b.pfx', true, posix);
    expect(next.map((e) => e.remembered)).toEqual([false, true]);
    // The input is not mutated.
    expect(list[1]?.remembered).toBe(false);
  });
});
