import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_FORM, DEFAULT_IMAGE_FORM, type TextForm } from './overlayModel';
import { PREF_KEY, readPrefs, sanitizeLike, stripPaths, writePrefs } from './overlayPrefs';

const ALIGNS = ['left', 'center', 'right'] as const;
const CHOICES = ['current', 'all', 'range', 'odd', 'even'] as const;

describe('overlay preferences', () => {
  it('no stored value gives the defaults', () => {
    expect(readPrefs({}, 'text', DEFAULT_TEXT_FORM)).toEqual(DEFAULT_TEXT_FORM);
  });

  it('stored choices come back; the text of the content is kept', () => {
    const prefs = writePrefs({}, 'text', { ...DEFAULT_TEXT_FORM, fontSize: 18, text: 'Bản sao' });
    const back = readPrefs<TextForm>(prefs, 'text', DEFAULT_TEXT_FORM, { align: ALIGNS });
    expect(back.fontSize).toBe(18);
    expect(back.text).toBe('Bản sao');
  });

  it('a wrong type or a non-finite number falls back to the default', () => {
    const raw = { overlay: { text: { fontSize: 'big', bold: 'yes', opacity: Number.NaN } } };
    const back = readPrefs<TextForm>(raw, 'text', DEFAULT_TEXT_FORM);
    expect(back.fontSize).toBe(DEFAULT_TEXT_FORM.fontSize);
    expect(back.bold).toBe(DEFAULT_TEXT_FORM.bold);
    expect(back.opacity).toBe(DEFAULT_TEXT_FORM.opacity);
  });

  it('enums are checked when given', () => {
    const raw = { overlay: { text: { align: 'justify', pages: { choice: 'odd', range: '' } } } };
    const back = readPrefs<TextForm>(raw, 'text', DEFAULT_TEXT_FORM, {
      align: ALIGNS,
      choice: CHOICES,
    });
    expect(back.align).toBe('left');
    expect(back.pages).toEqual({ choice: 'odd', range: '' });
  });

  it('unknown keys are dropped and nested objects keep their shape', () => {
    const out = sanitizeLike(
      { margins: { top: 3, extra: 9 }, evil: true },
      {
        margins: { top: 10, bottom: 10, left: 20, right: 20 },
      },
    );
    expect(out).toEqual({ margins: { top: 3, bottom: 10, left: 20, right: 20 } });
    expect(out).not.toHaveProperty('evil');
  });

  it('file paths, folders and file lists are never stored or read back', () => {
    const prefs = writePrefs({}, 'image', { ...DEFAULT_IMAGE_FORM, path: 'C:\\secret\\logo.png' });
    const stored = JSON.stringify(prefs);
    expect(stored).not.toContain('secret');
    expect(stripPaths({ path: 'x', files: ['a'], folder: 'b', sourcePath: 'c', keep: 1 })).toEqual({
      keep: 1,
    });
    const raw = { overlay: { image: { path: '/x/a.png', width: 50 } } };
    expect(readPrefs<typeof DEFAULT_IMAGE_FORM>(raw, 'image', DEFAULT_IMAGE_FORM).path).toBe('');
    expect(readPrefs<typeof DEFAULT_IMAGE_FORM>(raw, 'image', DEFAULT_IMAGE_FORM).width).toBe(50);
  });

  it('writing one dialog keeps the others and the other features', () => {
    const start = { sign: { level: 'B-T' }, overlay: { qr: { size: 30 } } };
    const next = writePrefs(start, 'text', DEFAULT_TEXT_FORM);
    expect(next.sign).toEqual({ level: 'B-T' });
    expect((next[PREF_KEY] as Record<string, unknown>).qr).toEqual({ size: 30 });
    expect((next[PREF_KEY] as Record<string, unknown>).text).toBeDefined();
  });

  it('a damaged overlay entry (not an object) reads as defaults', () => {
    expect(readPrefs({ overlay: 'oops' }, 'text', DEFAULT_TEXT_FORM)).toEqual(DEFAULT_TEXT_FORM);
    expect(readPrefs({ overlay: { text: [1, 2] } }, 'text', DEFAULT_TEXT_FORM)).toEqual(
      DEFAULT_TEXT_FORM,
    );
  });
});
