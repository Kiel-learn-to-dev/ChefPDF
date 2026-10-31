import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_STAMP_FORM,
  DEFAULT_TEXT_STAMP_FORM,
  checkImageStamp,
  checkTextStamp,
  imageStampParams,
  presetForm,
  readStampPresets,
  resolveStampText,
  textStampParams,
} from './stampModel';

const ALL = { choice: 'all' as const, range: '' };
const CURRENT = { choice: 'current' as const, range: '' };

describe('readStampPresets', () => {
  it('keeps well-formed presets and fills missing style fields', () => {
    const list = readStampPresets({
      presets: [
        {
          id: 'a',
          title: 'Đã duyệt',
          text: 'ĐÃ DUYỆT',
          color: '#C00000',
          borderWidth: 2,
          bold: true,
          fontSize: 26,
        },
        { id: 'b', title: 'Bản sao', text: 'BẢN SAO' },
        { id: 'c', title: 3, text: 'x' },
        null,
      ],
    });
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
    expect(list[1]).toMatchObject({ color: '#C00000', borderWidth: 2, bold: false, fontSize: 24 });
  });

  it('returns an empty list for anything else', () => {
    expect(readStampPresets(undefined)).toEqual([]);
    expect(readStampPresets({ presets: 'x' })).toEqual([]);
  });
});

describe('resolveStampText', () => {
  const now = new Date(2026, 10, 1, 9, 5);
  it('fills date, time, datetime and user', () => {
    expect(resolveStampText('{date} {time}', now, 'Minh')).toBe('01/11/2026 09:05');
    expect(resolveStampText('{datetime}', now, 'Minh')).toBe('01/11/2026 09:05');
    expect(resolveStampText('Bởi {user}', now, 'Minh')).toBe('Bởi Minh');
  });

  it('leaves unknown placeholders alone', () => {
    expect(resolveStampText('{foo}', now, 'Minh')).toBe('{foo}');
  });
});

describe('text stamp form', () => {
  it('accepts the defaults on the current page', () => {
    expect(checkTextStamp(DEFAULT_TEXT_STAMP_FORM, 4, 0)).toEqual({ ok: true });
  });

  it('rejects empty text, bad colour and bad opacity with the field name', () => {
    expect(checkTextStamp({ ...DEFAULT_TEXT_STAMP_FORM, text: '  ' }, 4, 0)).toEqual({
      ok: false,
      field: 'text',
    });
    expect(checkTextStamp({ ...DEFAULT_TEXT_STAMP_FORM, color: 'red' }, 4, 0)).toEqual({
      ok: false,
      field: 'color',
    });
    expect(checkTextStamp({ ...DEFAULT_TEXT_STAMP_FORM, opacity: 1.5 }, 4, 0)).toEqual({
      ok: false,
      field: 'opacity',
    });
  });

  it('builds the core params with placeholders kept and the user name sent', () => {
    const p = textStampParams(
      { ...DEFAULT_TEXT_STAMP_FORM, text: '{date}', pages: ALL },
      0,
      4,
      'Minh',
    );
    expect(p.text).toBe('{date}');
    expect(p.user).toBe('Minh');
    expect(p.pages).toBeUndefined();
    expect(p.pageRange).toBeUndefined();
  });

  it('sends the page selection of the form', () => {
    expect(textStampParams({ ...DEFAULT_TEXT_STAMP_FORM, pages: CURRENT }, 2, 4, '').pages).toEqual(
      [2],
    );
    expect(
      textStampParams({ ...DEFAULT_TEXT_STAMP_FORM, pages: { choice: 'odd', range: '' } }, 0, 4, '')
        .pageRange,
    ).toBe('odd');
  });

  it('applies a preset look without touching the position or pages', () => {
    const preset = readStampPresets({
      presets: [
        {
          id: 'x',
          title: 'Bản sao',
          text: 'BẢN SAO',
          color: '#1F4E9A',
          borderWidth: 2,
          bold: true,
          fontSize: 26,
        },
      ],
    })[0]!;
    const next = presetForm(DEFAULT_TEXT_STAMP_FORM, preset);
    expect(next.text).toBe('BẢN SAO');
    expect(next.color).toBe('#1F4E9A');
    expect(next.fontSize).toBe(26);
    expect(next.x).toBe(DEFAULT_TEXT_STAMP_FORM.x);
    expect(next.pages).toEqual(DEFAULT_TEXT_STAMP_FORM.pages);
  });
});

describe('image stamp form', () => {
  it('needs a file and turns multiply on by default', () => {
    expect(DEFAULT_IMAGE_STAMP_FORM.blendMultiply).toBe(true);
    expect(checkImageStamp(DEFAULT_IMAGE_STAMP_FORM, 4, 0)).toEqual({ ok: false, field: 'path' });
    const ok = { ...DEFAULT_IMAGE_STAMP_FORM, path: 'C:/seal.png' };
    expect(checkImageStamp(ok, 4, 0)).toEqual({ ok: true });
    expect(imageStampParams(ok, 0, 4)).toMatchObject({ path: 'C:/seal.png', blendMultiply: true });
  });
});
