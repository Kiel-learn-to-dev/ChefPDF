import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INITIALS_FORM,
  INITIALS_POSITIONS,
  checkInitials,
  initialsParams,
  positionFraction,
  type InitialsForm,
} from './initialsModel';

const ALL = { choice: 'all' as const, range: '' };

describe('checkInitials', () => {
  it('accepts the defaults', () => {
    expect(checkInitials(DEFAULT_INITIALS_FORM, 3, 0)).toEqual({ ok: true });
  });

  it('rejects empty or long text and a bad colour', () => {
    expect(checkInitials({ ...DEFAULT_INITIALS_FORM, text: ' ' }, 3, 0)).toEqual({
      ok: false,
      field: 'text',
    });
    expect(checkInitials({ ...DEFAULT_INITIALS_FORM, text: 'x'.repeat(41) }, 3, 0)).toEqual({
      ok: false,
      field: 'text',
    });
    expect(checkInitials({ ...DEFAULT_INITIALS_FORM, color: 'blue' }, 3, 0)).toEqual({
      ok: false,
      field: 'color',
    });
  });

  it('needs an image path for the image kind', () => {
    const img: InitialsForm = { ...DEFAULT_INITIALS_FORM, kind: 'image', path: '' };
    expect(checkInitials(img, 3, 0)).toEqual({ ok: false, field: 'path' });
    expect(checkInitials({ ...img, path: '/tmp/k.png' }, 3, 0)).toEqual({ ok: true });
  });

  it('checks the margin range', () => {
    expect(checkInitials({ ...DEFAULT_INITIALS_FORM, marginMm: -1 }, 3, 0)).toEqual({
      ok: false,
      field: 'marginMm',
    });
  });
});

describe('initialsParams', () => {
  it('sends only the text fields for the text kind', () => {
    const p = initialsParams(DEFAULT_INITIALS_FORM, 0, 3);
    expect(p).toMatchObject({ text: 'KN', fontSize: 14, position: 'bottom-right', marginMm: 10 });
    expect(p).not.toHaveProperty('path');
    expect(p).not.toHaveProperty('widthMm');
  });

  it('sends only the image fields for the image kind', () => {
    const p = initialsParams(
      { ...DEFAULT_INITIALS_FORM, kind: 'image', path: '/tmp/k.png', widthMm: 30 },
      0,
      3,
    );
    expect(p).toMatchObject({ path: '/tmp/k.png', widthMm: 30 });
    expect(p).not.toHaveProperty('text');
  });

  it('sends the chosen pages (all, current as a list)', () => {
    expect(initialsParams({ ...DEFAULT_INITIALS_FORM, pages: ALL }, 1, 3).pages).toBeUndefined();
    expect(
      initialsParams({ ...DEFAULT_INITIALS_FORM, pages: { choice: 'current', range: '' } }, 1, 3)
        .pages,
    ).toEqual([1]);
  });

  it('has the nine anchor positions', () => {
    expect(new Set(INITIALS_POSITIONS).size).toBe(9);
  });
});

describe('positionFraction', () => {
  it('puts the corners and the centre at the expected fractions', () => {
    expect(positionFraction('top-left')).toEqual({ x: 0.1, y: 0.1 });
    expect(positionFraction('bottom-right')).toEqual({ x: 0.9, y: 0.9 });
    expect(positionFraction('center')).toEqual({ x: 0.5, y: 0.5 });
    expect(positionFraction('center-left')).toEqual({ x: 0.1, y: 0.5 });
  });
});
