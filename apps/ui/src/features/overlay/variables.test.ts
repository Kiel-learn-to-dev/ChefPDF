/**
 * Preview-only port of core/chef_core/overlay/variables.py. Cases mirror core/tests/
 * test_overlay_variables.py so both sides agree on the same templates.
 */
import { describe, expect, it } from 'vitest';
import {
  VARIABLE_NAMES,
  formatDate,
  formatNumber,
  parseTemplate,
  renderTemplate,
  toAlpha,
  toRoman,
  type PreviewDoc,
} from './variables';

const NOW = new Date(2026, 10, 1, 14, 5, 9); // 1 Nov 2026 14:05:09 (local)

function docVars(over: Partial<PreviewDoc> = {}): PreviewDoc {
  return {
    filename: 'HS-2026',
    title: 'Hồ sơ dự án',
    author: 'Nguyễn Văn A',
    pageCount: 10,
    startNumber: 1,
    dateFormat: 'dd/MM/yyyy',
    now: NOW,
    sections: [],
    batesPrefix: '',
    batesSuffix: '',
    batesDigits: 6,
    ...over,
  };
}

function text(
  template: string,
  index: number,
  doc = docVars(),
  fmt: Parameters<typeof renderTemplate>[3] = 'arabic',
) {
  const r = renderTemplate(template, index, doc, fmt);
  if (!r.ok) throw new Error(`unexpected ${r.issue}`);
  return r.text;
}

describe('numbering', () => {
  it('roman numerals up to 3999', () => {
    const cases: Record<number, string> = {
      1: 'I',
      4: 'IV',
      9: 'IX',
      14: 'XIV',
      40: 'XL',
      90: 'XC',
      400: 'CD',
      1994: 'MCMXCIV',
      3999: 'MMMCMXCIX',
    };
    for (const [n, s] of Object.entries(cases)) expect(toRoman(Number(n))).toBe(s);
    expect(toRoman(0)).toBeNull();
    expect(toRoman(4000)).toBeNull();
  });

  it('alpha is bijective base 26', () => {
    expect(toAlpha(1)).toBe('A');
    expect(toAlpha(26)).toBe('Z');
    expect(toAlpha(27)).toBe('AA');
    expect(toAlpha(28)).toBe('AB');
    expect(toAlpha(52)).toBe('AZ');
    expect(toAlpha(53)).toBe('BA');
    expect(toAlpha(702)).toBe('ZZ');
    expect(toAlpha(703)).toBe('AAA');
    expect(toAlpha(0)).toBeNull();
  });

  it('formatNumber applies the case rules', () => {
    expect(formatNumber(4, 'arabic')).toBe('4');
    expect(formatNumber(4, 'roman')).toBe('iv');
    expect(formatNumber(4, 'ROMAN')).toBe('IV');
    expect(formatNumber(4, 'alpha')).toBe('d');
    expect(formatNumber(4, 'ALPHA')).toBe('D');
    expect(formatNumber(28, 'ALPHA')).toBe('AB');
    expect(formatNumber(4000, 'roman')).toBeNull();
    expect(formatNumber(0, 'alpha')).toBeNull();
  });
});

describe('templates', () => {
  it('plain text is kept', () => {
    expect(text('Tài liệu nội bộ', 0)).toBe('Tài liệu nội bộ');
  });

  it('doubled braces are literal braces', () => {
    expect(text('{{page}} = {page}', 2)).toBe('{page} = 3');
    expect(text('a }} b', 0)).toBe('a } b');
  });

  it('page and pages use the start number', () => {
    const doc = docVars({ startNumber: 5 });
    expect(text('{page}/{pages}', 0, doc)).toBe('5/14');
    expect(text('{page}/{pages}', 2, doc)).toBe('7/14');
  });

  it('the number format applies to page and pages only', () => {
    const doc = docVars({ startNumber: 5 });
    expect(text('{page}/{pages}', 0, doc, 'roman')).toBe('v/xiv');
    expect(text('{page_roman}', 0, doc, 'alpha')).toBe('V');
    expect(text('{page_alpha}', 2, doc, 'roman')).toBe('G');
  });

  it('roman and alpha variables', () => {
    expect(text('{page_roman}', 2)).toBe('III');
    expect(text('{page_alpha}', 26)).toBe('AA');
  });

  it('document variables', () => {
    expect(text('{filename}', 0)).toBe('HS-2026');
    expect(text('{title}', 0)).toBe('Hồ sơ dự án');
    expect(text('{author}', 0)).toBe('Nguyễn Văn A');
  });

  it('date and time', () => {
    expect(text('{date}', 0)).toBe('01/11/2026');
    expect(text('{time}', 0)).toBe('14:05');
  });

  it('date format is a token pattern with quoted literals', () => {
    expect(formatDate(NOW, "dd 'tháng' MM 'năm' yyyy")).toBe('01 tháng 11 năm 2026');
    expect(formatDate(NOW, "d/M/yy H:m:s 'it''s'")).toBe("1/11/26 14:5:9 it's");
  });

  it('bates is zero padded with prefix and suffix', () => {
    const doc = docVars({ batesPrefix: 'HS-', batesSuffix: '/A', batesDigits: 6 });
    expect(text('{bates}', 2, doc)).toBe('HS-000003/A');
  });

  it('section is the last section that started', () => {
    const doc = docVars({
      sections: [
        [0, 'Phần I'],
        [4, 'Phần II'],
      ],
    });
    expect(text('{section}', 2, doc)).toBe('Phần I');
    expect(text('{section}', 4, doc)).toBe('Phần II');
    expect(text('[{section}]', 0)).toBe('[]');
  });

  it('an unknown variable is reported by name', () => {
    const r = renderTemplate('Trang {nam}', 0, docVars(), 'arabic');
    expect(r).toEqual({ ok: false, issue: 'unknown', variable: 'nam' });
  });

  it('broken templates are reported', () => {
    expect(parseTemplate('{page')).toMatchObject({ ok: false, issue: 'unclosed' });
    expect(parseTemplate('page}')).toMatchObject({ ok: false, issue: 'stray' });
    expect(parseTemplate('{}')).toMatchObject({ ok: false, issue: 'unknown' });
    expect(parseTemplate('x } y')).toMatchObject({ ok: false, issue: 'stray' });
  });

  it('roman overflow only fails when the variable is used', () => {
    const doc = docVars({ startNumber: 4000 });
    expect(text('plain', 0, doc, 'roman')).toBe('plain');
    expect(renderTemplate('{page}', 0, doc, 'roman')).toEqual({
      ok: false,
      issue: 'range',
      variable: 'page',
    });
  });

  it('lists every variable the core knows', () => {
    expect(VARIABLE_NAMES).toEqual([
      'page',
      'pages',
      'page_roman',
      'page_alpha',
      'date',
      'time',
      'filename',
      'title',
      'author',
      'bates',
      'section',
    ]);
  });
});
