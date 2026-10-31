import { describe, expect, it } from 'vitest';
import { LEAD, SHRINK_STEP, approxTextWidth, layoutBox } from './canvasLayout';
import { SAMPLE_VALUES, renderRows, valuesFromCert } from './sampleData';
import { defaultTemplate } from './templateModel';

const base = {
  padding: 4,
  fontSize: 9,
  minFontSize: 5,
  autoShrink: true,
  bold: false,
  align: 'left',
  valign: 'top',
} as const;

describe('approximate text width', () => {
  it('grows with the characters and the size, and bold is wider', () => {
    expect(approxTextWidth('abcd', 10, false)).toBeCloseTo(4 * 10 * 0.54);
    expect(approxTextWidth('abcd', 10, true)).toBeGreaterThan(approxTextWidth('abcd', 10, false));
    expect(approxTextWidth('Nguyễn', 10, false)).toBeCloseTo(6 * 10 * 0.54);
  });
});

describe('auto-shrink', () => {
  it('shrinks a long row until it fits the width, in steps of 0.25 pt', () => {
    const text = 'Nguyễn Văn An rất dài để thử co chữ';
    const layout = layoutBox({ width: 120, height: 200 }, base, [{ text, fontSize: 9 }]);
    const row = layout.rows[0]!;
    expect(layout.shrunk).toBe(true);
    expect(row.fontSize).toBeLessThan(9);
    expect(row.width).toBeLessThanOrEqual(layout.area.width + 0.01);
    expect((9 - row.fontSize) / SHRINK_STEP).toBeCloseTo(
      Math.round((9 - row.fontSize) / SHRINK_STEP),
    );
    expect(row.overflow).toBe(false);
  });

  it('never goes below the minimum size, and reports overflow then', () => {
    const text = 'x'.repeat(200);
    const layout = layoutBox({ width: 50, height: 200 }, base, [{ text, fontSize: 9 }]);
    expect(layout.rows[0]!.fontSize).toBe(5);
    expect(layout.rows[0]!.overflow).toBe(true);
    expect(layout.overflow).toBe(true);
  });

  it('shrinks the whole block when the rows are too tall for the box', () => {
    const rows = Array.from({ length: 6 }, () => ({ text: 'Dòng', fontSize: 9 }));
    const layout = layoutBox({ width: 300, height: 60 }, base, rows);
    expect(layout.shrunk).toBe(true);
    const total = layout.rows.reduce((sum, r) => sum + r.fontSize * LEAD, 0);
    expect(total).toBeLessThanOrEqual(layout.area.height + 0.01);
    expect(layout.overflow).toBe(false);
    expect(layout.rows.every((r) => r.fontSize >= 5)).toBe(true);
  });

  it('keeps the size when autoShrink is off, and reports the overflow instead', () => {
    const text = 'x'.repeat(200);
    const layout = layoutBox({ width: 50, height: 200 }, { ...base, autoShrink: false }, [
      { text, fontSize: 9 },
    ]);
    expect(layout.shrunk).toBe(false);
    expect(layout.rows[0]!.fontSize).toBe(9);
    expect(layout.overflow).toBe(true);
  });
});

describe('placement', () => {
  it('aligns rows to the right and centres the block vertically', () => {
    const rows = [{ text: 'abc', fontSize: 10 }];
    const right = layoutBox({ width: 200, height: 100 }, { ...base, align: 'right' }, rows)
      .rows[0]!;
    const left = layoutBox({ width: 200, height: 100 }, { ...base, align: 'left' }, rows).rows[0]!;
    expect(right.x).toBeGreaterThan(left.x);
    const middle = layoutBox({ width: 200, height: 100 }, { ...base, valign: 'middle' }, rows)
      .rows[0]!;
    const top = layoutBox({ width: 200, height: 100 }, { ...base, valign: 'top' }, rows).rows[0]!;
    expect(middle.y).toBeGreaterThan(top.y);
  });
});

describe('preview rows', () => {
  it('uses the sample values, the label and the date pattern', () => {
    const template = defaultTemplate();
    template.lines = [
      { source: 'signerName', label: 'Ký bởi:', enabled: true },
      { source: 'date', label: 'Ngày ký:', enabled: true },
      { source: 'reason', enabled: false },
    ];
    const rows = renderRows(template, SAMPLE_VALUES).map((r) => r.text);
    expect(rows).toEqual(['Ký số bởi', 'Ký bởi: Nguyễn Văn An', 'Ngày ký: 31/10/2026 08:02:03']);
  });

  it('lets a line text replace the value and skips empty rows', () => {
    const template = defaultTemplate();
    template.header = null;
    template.lines = [
      { source: 'organization', text: 'Công ty ABC', enabled: true },
      { source: 'contact', enabled: true },
      { source: 'reason', enabled: true },
      { source: 'custom', text: 'Dấu thời gian', enabled: true },
    ];
    const values = { ...SAMPLE_VALUES, reason: '' };
    expect(renderRows(template, values).map((r) => r.text)).toEqual([
      'Công ty ABC',
      'an.nguyen@example.vn',
      'Dấu thời gian',
    ]);
  });

  it('takes the identity of a certificate file for the values', () => {
    const cert = {
      subjectCommonName: 'Trần Thị B',
      identity: {
        personName: null,
        organization: 'Đơn vị X',
        taxCode: '0309999999',
        citizenId: null,
        budgetCode: null,
      },
    } as unknown as Parameters<typeof valuesFromCert>[0];
    const values = valuesFromCert(cert, new Date(2026, 0, 2, 3, 4, 5));
    expect(values.signerName).toBe('Trần Thị B');
    expect(values.organization).toBe('Đơn vị X');
    expect(values.taxCode).toBe('0309999999');
    expect(values.citizenId).toBe('');
  });
});
