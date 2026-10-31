import { describe, expect, it } from 'vitest';
import type { SignatureTemplate } from '@chef/contracts';
import {
  DEFAULT_TEMPLATE,
  LIMITS,
  MAX_TEMPLATE_LINES,
  defaultTemplate,
  formatDatePattern,
  fromWire,
  moveLine,
  newLine,
  normalizeTemplate,
  parseTemplateFile,
  templateFileText,
  toWire,
} from './templateModel';

describe('defaults', () => {
  it('match the core defaults (appearance.py SignatureTemplate)', () => {
    expect(DEFAULT_TEMPLATE).toMatchObject({
      name: 'Mặc định',
      layout: 'text-only',
      header: 'Ký số bởi',
      dateFormat: 'dd/MM/yyyy HH:mm:ss',
      showTimezone: false,
      fontName: 'BeVietnamPro',
      fontSize: 9,
      minFontSize: 5,
      autoShrink: true,
      bold: false,
      textColor: '#000000',
      align: 'left',
      valign: 'middle',
      padding: 4,
      border: { color: '#1F3A93', width: 0.8 },
      background: { color: '#FFFFFF', opacity: 0 },
      checkmark: false,
      checkColor: '#1E8E3E',
      imageRatio: 0.35,
    });
    expect(DEFAULT_TEMPLATE.lines).toEqual([
      { source: 'signerName', enabled: true },
      { source: 'date', enabled: true },
    ]);
  });

  it('returns a copy that can be changed freely', () => {
    const a = defaultTemplate('Mẫu A');
    a.lines!.push({ source: 'reason', enabled: true });
    expect(defaultTemplate().lines).toHaveLength(2);
    expect(a.name).toBe('Mẫu A');
  });
});

describe('normalizeTemplate (clamping mirrors the core limits)', () => {
  it('clamps sizes, opacity, padding and image share to the core ranges', () => {
    const { template, warnings } = normalizeTemplate({
      fontSize: 500,
      minFontSize: 0,
      padding: 999,
      imageRatio: 2,
      background: { color: '#FFFFFF', opacity: 7 },
      border: { color: '#000000', width: 0 },
    });
    expect(template.fontSize).toBe(LIMITS.fontSize[1]);
    expect(template.minFontSize).toBe(LIMITS.minFontSize[0]);
    expect(template.padding).toBe(60);
    expect(template.imageRatio).toBe(0.9);
    expect(template.background!.opacity).toBe(1);
    expect(template.border!.width).toBe(0.1);
    expect(warnings.length).toBeGreaterThan(3);
  });

  it('keeps the minimum size at or below the font size', () => {
    const { template, warnings } = normalizeTemplate({ fontSize: 8, minFontSize: 12 });
    expect(template.minFontSize).toBe(8);
    expect(warnings.join(' ')).toMatch(/minimum font size/);
  });

  it('accepts hex colours only and upper-cases them', () => {
    expect(normalizeTemplate({ textColor: '#1e8e3e' }).template.textColor).toBe('#1E8E3E');
    const bad = normalizeTemplate({ textColor: 'red', checkColor: '#12' });
    expect(bad.template.textColor).toBe('#000000');
    expect(bad.template.checkColor).toBe('#1E8E3E');
    expect(bad.warnings).toHaveLength(2);
  });

  it('drops unknown enums and falls back to defaults', () => {
    const { template } = normalizeTemplate({ layout: 'wrap', align: 'justify', valign: 'x' });
    expect(template.layout).toBe('text-only');
    expect(template.align).toBe('left');
    expect(template.valign).toBe('middle');
  });

  it('turns a custom line without text off and drops unknown sources', () => {
    const { template, warnings } = normalizeTemplate({
      lines: [
        { source: 'custom' },
        { source: 'custom', text: 'Thông tin' },
        { source: 'bogus' },
        { source: 'taxCode', fontSize: 500 },
      ],
    });
    expect(template.lines).toEqual([
      { source: 'custom', enabled: false },
      { source: 'custom', enabled: true, text: 'Thông tin' },
      { source: 'taxCode', enabled: true, fontSize: 72 },
    ]);
    expect(warnings.some((w) => /custom line/.test(w))).toBe(true);
  });

  it('caps the number of lines', () => {
    const many = Array.from({ length: MAX_TEMPLATE_LINES + 4 }, () => ({ source: 'date' }));
    expect(normalizeTemplate({ lines: many }).template.lines).toHaveLength(MAX_TEMPLATE_LINES);
  });

  it('keeps a border or background of null, and drops an image without a file', () => {
    const { template, warnings } = normalizeTemplate({
      border: null,
      header: null,
      image: { fit: 'cover' },
      logo: { path: '/x/logo.png', fit: 'cover', opacity: 0.5 },
    });
    expect(template.border).toBeNull();
    expect(template.header).toBeNull();
    expect(template.image).toBeUndefined();
    expect(template.logo).toEqual({ path: '/x/logo.png', fit: 'cover', opacity: 0.5 });
    expect(warnings.join(' ')).toMatch(/image: needs a file/);
  });

  it('returns the defaults for something that is not an object', () => {
    expect(normalizeTemplate('nope').template).toEqual(defaultTemplate());
  });
});

describe('wire <-> form round trip', () => {
  const full: SignatureTemplate = {
    ...defaultTemplate('Đầy đủ'),
    layout: 'image-left',
    header: null,
    lines: [
      { source: 'signerName', label: 'Ký bởi:', enabled: true },
      { source: 'organization', enabled: false, fontSize: 7 },
      { source: 'custom', text: 'Ghi chú', enabled: true },
    ],
    dateFormat: "'Ngày' d 'tháng' M 'năm' yyyy",
    showTimezone: true,
    bold: true,
    textColor: '#1F3A93',
    align: 'center',
    valign: 'top',
    border: null,
    background: { color: '#EEEEEE', opacity: 0.3 },
    checkmark: true,
    imageRatio: 0.5,
  };

  it('keeps every field through toWire and fromWire', () => {
    expect(fromWire(toWire(full))).toEqual(full);
  });

  it('removes the image and logo paths from the wire object', () => {
    const withImage: SignatureTemplate = {
      ...full,
      image: { path: '/tmp/a.png', fit: 'contain', opacity: 1 },
    };
    expect(toWire(withImage)).not.toHaveProperty('image');
  });

  it('writes and reads the template file (wrapper and bare object)', () => {
    const text = templateFileText(full);
    expect(JSON.parse(text)).toMatchObject({ format: 'chef-sign-template', version: 1 });
    expect(parseTemplateFile(text).template).toEqual(fromWire(toWire(full)));
    expect(parseTemplateFile(JSON.stringify(toWire(full))).template.name).toBe('Đầy đủ');
    expect(() => parseTemplateFile('[]')).toThrow(/not a template/);
    expect(() =>
      parseTemplateFile('{"format":"chef-sign-template","version":2,"template":{}}'),
    ).toThrow(/version/);
    expect(() => parseTemplateFile('not json')).toThrow();
  });
});

describe('line reordering', () => {
  const lines = [
    { source: 'signerName' as const, enabled: true },
    { source: 'organization' as const, enabled: true },
    { source: 'date' as const, enabled: true },
  ];

  it('moves a line up or down and keeps the others in order', () => {
    expect(moveLine(lines, 2, 0).map((l) => l.source)).toEqual([
      'date',
      'signerName',
      'organization',
    ]);
    expect(moveLine(lines, 0, 1).map((l) => l.source)).toEqual([
      'organization',
      'signerName',
      'date',
    ]);
  });

  it('does nothing for an out-of-range or same index', () => {
    expect(moveLine(lines, 1, 1)).toEqual(lines);
    expect(moveLine(lines, -1, 0)).toEqual(lines);
    expect(moveLine(lines, 0, 9)).toEqual(lines);
    expect(lines).toHaveLength(3);
  });

  it('gives custom lines a placeholder text', () => {
    expect(newLine('custom').text).toBeTruthy();
    expect(newLine('reason')).toEqual({ source: 'reason', enabled: true });
  });
});

describe('date pattern (same tokens as the core)', () => {
  const at = new Date(2026, 9, 31, 8, 2, 3);

  it('formats the default pattern', () => {
    expect(formatDatePattern(at, 'dd/MM/yyyy HH:mm:ss')).toBe('31/10/2026 08:02:03');
  });

  it('keeps quoted text literal and reads doubled quotes as one', () => {
    expect(formatDatePattern(at, "'Ngày' d 'tháng' M 'năm' yyyy")).toBe(
      'Ngày 31 tháng 10 năm 2026',
    );
    expect(formatDatePattern(at, "'O''Brien' d")).toBe("O'Brien 31");
    expect(formatDatePattern(new Date(2026, 0, 5, 9, 7, 0), 'd/M/yy H:m:s')).toBe('5/1/26 9:7:0');
  });

  it('appends the UTC offset when asked', () => {
    expect(formatDatePattern(at, 'dd/MM', true)).toMatch(/^31\/10 \(UTC[+-]\d{2}:\d{2}\)$/);
  });
});
