import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACT_FORM,
  applyParams,
  defaultMatchSelection,
  formPatterns,
  groupMatches,
  manualFromBox,
  readMatches,
  readVerification,
  setGroupChecked,
  toggleMatch,
  unselectedCount,
  type RedactForm,
} from './redactModel';

const form = (over: Partial<RedactForm> = {}): RedactForm => ({
  ...DEFAULT_REDACT_FORM,
  ...over,
  builtins: { ...DEFAULT_REDACT_FORM.builtins, ...(over.builtins ?? {}) },
});

describe('formPatterns', () => {
  it('turns the checked builtins into kind-only patterns', () => {
    const r = formPatterns(form());
    expect(r).toEqual({
      ok: true,
      patterns: [{ kind: 'cccd' }, { kind: 'phone' }, { kind: 'email' }],
    });
  });

  it('adds custom literal and regex rows with their diacritics setting', () => {
    const r = formPatterns(
      form({
        builtins: {
          cccd: false,
          phone: false,
          email: false,
          bankAccount: false,
          taxCode: false,
          date: false,
        },
        custom: [
          { id: 'a', kind: 'literal', value: '  Nguyễn Văn A ', ignoreDiacritics: true },
          { id: 'b', kind: 'regex', value: 'AB\\d+', ignoreDiacritics: false },
          { id: 'c', kind: 'literal', value: '   ', ignoreDiacritics: true },
        ],
      }),
    );
    expect(r).toEqual({
      ok: true,
      patterns: [
        { kind: 'literal', value: 'Nguyễn Văn A', ignoreDiacritics: true },
        { kind: 'regex', value: 'AB\\d+', ignoreDiacritics: false },
      ],
    });
  });

  it('reports an empty form and an invalid regex row', () => {
    const none = form({
      builtins: {
        cccd: false,
        phone: false,
        email: false,
        bankAccount: false,
        taxCode: false,
        date: false,
      },
    });
    expect(formPatterns(none)).toEqual({ ok: false, problem: { kind: 'empty' } });
    const bad = formPatterns(
      form({ custom: [{ id: 'r1', kind: 'regex', value: '([', ignoreDiacritics: true }] }),
    );
    expect(bad).toEqual({ ok: false, problem: { kind: 'regex', rowId: 'r1' } });
  });
});

describe('matches', () => {
  const data = {
    count: 3,
    matches: [
      { id: 'm1', pageIndex: 0, pattern: 'cccd', text: '012345678901', rects: [[1, 2, 3, 4]] },
      { id: 'm2', pageIndex: 2, pattern: 'email', text: 'a@b.vn', rects: [[5, 6, 7, 8]] },
      { id: 'm3', pageIndex: 0, pattern: 'cccd', text: '012345678901', rects: [[9, 9, 9, 9]] },
      { nope: 1 },
    ],
  };

  it('reads matches and skips malformed entries', () => {
    const list = readMatches(data);
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(list[1]!.rects).toEqual([[5, 6, 7, 8]]);
    expect(readMatches(null)).toEqual([]);
  });

  it('groups by pattern with counts and pages, in order of appearance', () => {
    const groups = groupMatches(readMatches(data));
    expect(groups.map((g) => [g.pattern, g.count, g.pages])).toEqual([
      ['cccd', 2, [0]],
      ['email', 1, [2]],
    ]);
  });

  it('checks every match by default and tracks toggles and unselected counts', () => {
    const list = readMatches(data);
    const all = defaultMatchSelection(list);
    expect(all).toEqual(['m1', 'm2', 'm3']);
    const less = toggleMatch(all, 'm2');
    expect(less).toEqual(['m1', 'm3']);
    expect(toggleMatch(less, 'm2')).toEqual(['m1', 'm3', 'm2']);
    expect(unselectedCount(list, less)).toBe(1);
    expect(unselectedCount(list, all)).toBe(0);
  });

  it('checks or unchecks a whole group', () => {
    const list = readMatches(data);
    const group = groupMatches(list)[0]!;
    expect(setGroupChecked(['m2'], group, true).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(setGroupChecked(['m1', 'm2', 'm3'], group, false)).toEqual(['m2']);
  });
});

describe('manual areas', () => {
  it('turns a placement box into a display-frame rect', () => {
    expect(manualFromBox('a', { pageIndex: 1, x: 10.25, y: 20, width: 30, height: 5 })).toEqual({
      id: 'a',
      pageIndex: 1,
      rect: [10.25, 20, 40.25, 25],
    });
  });

  it('drops an empty box', () => {
    expect(manualFromBox('a', { pageIndex: 0, x: 1, y: 1, width: 0, height: 0 })).toBeNull();
  });
});

describe('applyParams', () => {
  const base = {
    patterns: [{ kind: 'cccd' as const }],
    matchIds: ['m1'],
    areas: [],
    fill: '#000000',
    alsoMetadata: true,
    removeFromAnnotations: true,
  };

  it('sends the patterns with the match ids, not with manual areas alone', () => {
    expect(applyParams(base)).toEqual({
      patterns: [{ kind: 'cccd' }],
      matchIds: ['m1'],
      rects: [],
      fill: '#000000',
      alsoMetadata: true,
      removeFromAnnotations: true,
    });
    const manual = applyParams({
      ...base,
      matchIds: [],
      areas: [{ id: 'a', pageIndex: 0, rect: [1, 2, 3, 4] }],
      fill: 'red',
    });
    expect(manual).toEqual({
      rects: [{ pageIndex: 0, rect: [1, 2, 3, 4] }],
      fill: '#000000',
      alsoMetadata: true,
      removeFromAnnotations: true,
    });
  });

  it('returns null when nothing is chosen', () => {
    expect(applyParams({ ...base, matchIds: [], areas: [] })).toBeNull();
  });
});

describe('readVerification', () => {
  it('reads a passing check and a list of leaks', () => {
    expect(readVerification({ verification: { ok: true, leaks: [] } })).toEqual({
      ok: true,
      leaks: [],
    });
    expect(
      readVerification({
        verification: { ok: false, leaks: [{ where: 'page 2 text', pattern: 'cccd' }] },
      }),
    ).toEqual({ ok: false, leaks: [{ where: 'page 2 text', pattern: 'cccd' }] });
    expect(readVerification(undefined).ok).toBe(true);
  });
});
