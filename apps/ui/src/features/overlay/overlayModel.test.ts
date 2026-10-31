import { describe, expect, it } from 'vitest';
import {
  BUILTIN_WATERMARKS,
  DEFAULT_BARCODE_FORM,
  DEFAULT_BATES_FORM,
  DEFAULT_LETTERHEAD_FORM,
  DEFAULT_PAGE_NUMBERS_FORM,
  DEFAULT_TEXT_FORM,
  DEFAULT_WATERMARK_FORM,
  addImageParams,
  addTextParams,
  anchorShift,
  barcodeParams,
  barcodeProblem,
  batesCode,
  batesParams,
  boxToTopLeft,
  checkBates,
  checkPageNumbers,
  checkText,
  checkWatermark,
  ean13CheckDigit,
  ean13Complete,
  effectiveNumberTemplate,
  estimateTextBox,
  fromPt,
  groupOverlays,
  headerFooterParams,
  letterheadParams,
  letterheadProblem,
  pageNumbersParams,
  pageSelection,
  presetLook,
  previewBox,
  qrContentProblem,
  readBatesRows,
  readOverlays,
  selectedPages,
  toPt,
  validatePresetName,
  watermarkParams,
  zonesProblem,
  DEFAULT_HEADER_FOOTER_FORM,
  DEFAULT_IMAGE_FORM,
  lookOf,
  DEFAULT_QR_FORM,
  qrParams,
  DEFAULT_WATERMARK_FORM as WM,
} from './overlayModel';

const cur = { choice: 'current' as const, range: '' };

describe('page selection', () => {
  it('current page is the 0-based index', () => {
    expect(pageSelection(cur, 2, 5)).toEqual({ ok: true, params: { pages: [2] } });
  });

  it('all sends no page params (the core default is every page)', () => {
    expect(pageSelection({ choice: 'all', range: '' }, 0, 5)).toEqual({ ok: true, params: {} });
  });

  it('odd and even use the core keywords', () => {
    expect(pageSelection({ choice: 'odd', range: '' }, 0, 5)).toEqual({
      ok: true,
      params: { pageRange: 'odd' },
    });
    expect(selectedPages({ choice: 'even', range: '' }, 0, 5)).toEqual([1, 3]);
    expect(selectedPages({ choice: 'odd', range: '' }, 0, 5)).toEqual([0, 2, 4]);
  });

  it('a range is parsed to 0-based pages in order written', () => {
    expect(pageSelection({ choice: 'range', range: '3,1' }, 0, 5)).toEqual({
      ok: true,
      params: { pages: [2, 0] },
    });
    expect(selectedPages({ choice: 'range', range: '2-' }, 0, 3)).toEqual([1, 2]);
  });

  it('an out of range text is an error the dialog can show', () => {
    expect(pageSelection({ choice: 'range', range: '1-9' }, 0, 3)).toEqual({
      ok: false,
      error: 'range',
    });
    expect(pageSelection({ choice: 'range', range: '' }, 0, 3)).toEqual({
      ok: false,
      error: 'range',
    });
  });
});

describe('units and placement', () => {
  it('mm and pt convert both ways', () => {
    expect(toPt(25.4, 'mm')).toBeCloseTo(72, 6);
    expect(toPt(10, 'pt')).toBe(10);
    expect(fromPt(72, 'mm')).toBe(25.4);
    expect(fromPt(12.34, 'pt')).toBe(12.3);
  });

  it('a viewer box becomes top-left points of the displayed page', () => {
    // Page 595 x 842 pt shown at 1 px per point: box at (10, 20), 100 x 50 from the top.
    const r = boxToTopLeft({ left: 10, top: 20, width: 100, height: 50 }, 595, 842, 1);
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('scale is px per point: a 2x image maps back to points', () => {
    const r = boxToTopLeft({ left: 20, top: 40, width: 200, height: 100 }, 595, 842, 2);
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
});

describe('text and image params', () => {
  it('an empty text is refused, a good one passes', () => {
    expect(checkText({ ...DEFAULT_TEXT_FORM, text: '  ' }, 3, 0)).toEqual({
      ok: false,
      field: 'text',
    });
    expect(checkText({ ...DEFAULT_TEXT_FORM, text: 'Bản sao', color: 'red' }, 3, 0)).toEqual({
      ok: false,
      field: 'color',
    });
    expect(checkText({ ...DEFAULT_TEXT_FORM, text: 'Bản sao có kiểm soát' }, 3, 0)).toEqual({
      ok: true,
    });
  });

  it('text params carry the page, font and optional width', () => {
    const p = addTextParams({ ...DEFAULT_TEXT_FORM, text: 'A', x: 5, y: 6 }, 1, 4);
    expect(p).toMatchObject({ x: 5, y: 6, unit: 'mm', pages: [1], fontName: 'BeVietnamPro' });
    expect(p).not.toHaveProperty('width');
    expect(addTextParams({ ...DEFAULT_TEXT_FORM, text: 'A', width: 80 }, 0, 1)).toHaveProperty(
      'width',
      80,
    );
  });

  it('image params: size only when given, file as path', () => {
    const p = addImageParams({ ...DEFAULT_IMAGE_FORM, path: '/x/logo.png', height: 0 }, 0, 2);
    expect(p).toMatchObject({ path: '/x/logo.png', width: 40 });
    expect(p).not.toHaveProperty('height');
    expect(checkText({ ...DEFAULT_TEXT_FORM, text: 'a', opacity: 2 }, 1, 0)).toEqual({
      ok: false,
      field: 'opacity',
    });
    expect(
      addImageParams(
        { ...DEFAULT_IMAGE_FORM, path: '/x/a.pdf', pages: { choice: 'all', range: '' } },
        0,
        1,
      ).path,
    ).toBe('/x/a.pdf');
  });
});

describe('watermark', () => {
  it('text watermark params hold the text and no path', () => {
    const p = watermarkParams({ ...WM, text: 'MẬT' }, 0, 3);
    expect(p).toMatchObject({ text: 'MẬT', mode: 'center', rotation: 45, opacity: 0.25 });
    expect(p).not.toHaveProperty('path');
  });

  it('image watermark params hold the path and only given sizes', () => {
    const p = watermarkParams({ ...WM, kind: 'image', path: '/x/con-dau.png', width: 120 }, 0, 3);
    expect(p).toMatchObject({ path: '/x/con-dau.png', width: 120 });
    expect(p).not.toHaveProperty('height');
    expect(p).not.toHaveProperty('text');
  });

  it('a tiled watermark keeps its spacing', () => {
    expect(watermarkParams({ ...WM, mode: 'tiled', spacing: 90 }, 0, 1)).toMatchObject({
      mode: 'tiled',
      spacing: 90,
    });
  });

  it('checks the text, colour and image extension', () => {
    expect(checkWatermark({ ...WM, text: '' }, 1, 0)).toEqual({ ok: false, field: 'text' });
    expect(checkWatermark({ ...WM, color: '#GGGGGG' }, 1, 0)).toEqual({
      ok: false,
      field: 'color',
    });
    expect(checkWatermark({ ...WM, kind: 'image', path: '/x/a.gif' }, 1, 0)).toEqual({
      ok: false,
      field: 'path',
    });
    expect(checkWatermark(WM, 1, 0)).toEqual({ ok: true });
  });

  it('built-in presets cover the four texts and keep a preset look without paths', () => {
    expect(BUILTIN_WATERMARKS.map((p) => p.key)).toEqual(['copy', 'secret', 'draft', 'approved']);
    const look = lookOf({
      ...WM,
      path: '/x/a.png',
      text: 'X',
      pages: { choice: 'odd', range: '' },
    });
    expect(Object.keys(look).sort()).toEqual(['bold', 'color', 'fontSize', 'opacity', 'rotation']);
  });

  it('a stored preset look falls back for bad values', () => {
    const look = presetLook(
      { fontSize: 'big', color: 'red', opacity: 0.5 },
      DEFAULT_WATERMARK_FORM,
    );
    expect(look.fontSize).toBe(60);
    expect(look.color).toBe('#808080');
    expect(look.opacity).toBe(0.5);
  });
});

describe('header, footer and page numbers', () => {
  it('a broken template in a zone is named by the zone', () => {
    const zones = { ...DEFAULT_HEADER_FOOTER_FORM.footer, right: 'Trang {page' };
    expect(zonesProblem(zones)).toEqual({ field: 'right', issue: 'unclosed' });
    expect(zonesProblem(DEFAULT_HEADER_FOOTER_FORM.footer)).toBeNull();
  });

  it('header params hold the zones and margins in mm', () => {
    const p = headerFooterParams(DEFAULT_HEADER_FOOTER_FORM, 0, 3);
    expect(p.footer).toEqual({ left: '{filename}', center: '', right: 'Trang {page}/{pages}' });
    expect(p.margins).toEqual({ top: 10, bottom: 10, left: 20, right: 20 });
  });

  it('nd30 replaces the template, format and position in the request', () => {
    const form = { ...DEFAULT_PAGE_NUMBERS_FORM, preset: 'nd30' as const };
    expect(effectiveNumberTemplate(form)).toBe('{page}');
    const p = pageNumbersParams(form, 0, 3);
    expect(p.preset).toBe('nd30');
    expect(p.pages).toEqual([0]);
    expect(
      pageNumbersParams({ ...DEFAULT_PAGE_NUMBERS_FORM, preset: 'custom' }, 0, 3),
    ).not.toHaveProperty('preset');
  });

  it('custom templates are checked, nd30 always passes', () => {
    expect(
      checkPageNumbers({ ...DEFAULT_PAGE_NUMBERS_FORM, template: 'Trang {pag}' }, 3, 0),
    ).toEqual({ ok: false, field: 'template' });
    expect(
      checkPageNumbers({ ...DEFAULT_PAGE_NUMBERS_FORM, preset: 'nd30', template: '{pag}' }, 3, 0),
    ).toEqual({ ok: true });
  });
});

describe('QR and barcode', () => {
  it('a QR content with a broken template is reported', () => {
    expect(qrContentProblem('{filename} {page')).toBe('unclosed');
    expect(qrContentProblem('   ')).toBe('empty');
    expect(qrContentProblem(DEFAULT_QR_FORM.content)).toBeNull();
  });

  it('QR params use mm and the variables are sent as they are', () => {
    const p = qrParams({ ...DEFAULT_QR_FORM, label: 'Hồ sơ' }, 0, 2);
    expect(p).toMatchObject({
      unit: 'mm',
      size: 25,
      content: DEFAULT_QR_FORM.content,
      label: 'Hồ sơ',
    });
  });

  it('EAN-13 check digit matches the standard example', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13Complete('400638133393')).toBe('4006381333931');
    expect(barcodeProblem('ean13', '4006381333931')).toBeNull();
  });

  it('EAN-13 rejects letters, wrong lengths and a wrong check digit', () => {
    expect(barcodeProblem('ean13', '4006381333X1')).toBe('ean13Digits');
    expect(barcodeProblem('ean13', '12345')).toBe('ean13Length');
    expect(barcodeProblem('ean13', '4006381333932')).toBe('ean13Check');
  });

  it('Code 39 takes its charset only', () => {
    expect(barcodeProblem('code39', 'HS-001 $/+%.')).toBeNull();
    expect(barcodeProblem('code39', 'hs-001')).toBe('code39');
    expect(barcodeProblem('code39', 'A*B')).toBe('code39');
  });

  it('Code 128 takes printable ASCII', () => {
    expect(barcodeProblem('code128', 'HS-000001')).toBeNull();
    expect(barcodeProblem('code128', 'Hồ sơ')).toBe('code128');
    expect(barcodeProblem('code128', '')).toBe('empty');
  });

  it('barcode params complete the EAN-13 check digit', () => {
    const p = barcodeParams(
      { ...DEFAULT_BARCODE_FORM, kind: 'ean13', content: '400638133393' },
      0,
      1,
    );
    expect(p.content).toBe('4006381333931');
    expect(p.kind).toBe('ean13');
  });
});

describe('overlay list', () => {
  it('groups by kind and operation group, merging pages', () => {
    const items = readOverlays({
      overlays: [
        { id: 'a', kind: 'watermark', group: 'wm-1', pages: [2], label: 'BẢN SAO' },
        { id: 'b', kind: 'watermark', group: 'wm-1', pages: [0], label: 'BẢN SAO' },
        { id: 'c', kind: 'text', group: 'txt-1', pages: [0], label: 'Chữ' },
      ],
    });
    const groups = groupOverlays(items);
    expect(groups.map((g) => g.kind)).toEqual(['text', 'watermark']);
    expect(groups[1]).toMatchObject({ group: 'wm-1', count: 2, pages: [0, 2] });
  });

  it('readOverlays skips malformed rows', () => {
    expect(readOverlays({ overlays: [{ id: 1 }, { id: 'x', kind: 'alien', group: 'g' }] })).toEqual(
      [],
    );
    expect(readOverlays(null)).toEqual([]);
  });
});

describe('Bates', () => {
  it('codes are prefix, padded number and suffix', () => {
    expect(batesCode({ ...DEFAULT_BATES_FORM, prefix: 'HS-', suffix: '/A' }, 1)).toBe(
      'HS-000001/A',
    );
  });

  it('output modes map to the core output', () => {
    expect(batesParams({ ...DEFAULT_BATES_FORM, files: ['/a.pdf'] }).output).toEqual({
      mode: 'suffix',
      suffix: '_bates',
    });
    expect(batesParams({ ...DEFAULT_BATES_FORM, outputMode: 'overwrite' }).output).toEqual({
      mode: 'overwrite',
    });
    expect(
      batesParams({ ...DEFAULT_BATES_FORM, outputMode: 'folder', folder: '/out' }).output,
    ).toEqual({ mode: 'folder', folder: '/out' });
  });

  it('a folder output needs a folder, files are required', () => {
    expect(checkBates(DEFAULT_BATES_FORM)).toEqual({ ok: false, field: 'files' });
    expect(checkBates({ ...DEFAULT_BATES_FORM, files: ['/a.pdf'], outputMode: 'folder' })).toEqual({
      ok: false,
      field: 'folder',
    });
    expect(checkBates({ ...DEFAULT_BATES_FORM, files: ['/a.pdf'] })).toEqual({ ok: true });
  });

  it('result rows read the status and the first and last numbers', () => {
    const rows = readBatesRows({
      files: [
        {
          path: '/a.pdf',
          status: 'done',
          outputPath: '/a_bates.pdf',
          pages: 3,
          firstLabel: 'HS-000001',
          lastLabel: 'HS-000003',
        },
        { path: '/b.pdf', status: 'failed', errorKind: 'PASSWORD_REQUIRED', message: 'pw' },
        { path: '/c.pdf', status: 'skipped' },
      ],
    });
    expect(rows.map((r) => r.status)).toEqual(['done', 'failed', 'skipped']);
    expect(rows[0]).toMatchObject({ firstNumber: 'HS-000001', lastNumber: 'HS-000003', pages: 3 });
    expect(rows[1]!.errorKind).toBe('PASSWORD_REQUIRED');
  });
});

describe('letterhead', () => {
  it('roles map to the core fields; unused roles are left out', () => {
    const p = letterheadParams(
      {
        ...DEFAULT_LETTERHEAD_FORM,
        sourcePath: '/lh.pdf',
        roles: { first: 0, odd: null, even: 2, rest: 1 },
      },
      0,
      4,
    );
    expect(p).toMatchObject({ sourcePath: '/lh.pdf', sourcePage: 0, first: 0, even: 2, rest: 1 });
    expect(p).not.toHaveProperty('odd');
  });

  it('a letterhead must be a PDF with at least one role', () => {
    expect(letterheadProblem({ ...DEFAULT_LETTERHEAD_FORM, sourcePath: '/lh.png' })).toBe('source');
    expect(
      letterheadProblem({
        ...DEFAULT_LETTERHEAD_FORM,
        sourcePath: '/lh.pdf',
        roles: { first: null, odd: null, even: null, rest: null },
      }),
    ).toBe('roles');
    expect(letterheadProblem({ ...DEFAULT_LETTERHEAD_FORM, sourcePath: '/lh.pdf' })).toBeNull();
  });
});

describe('preview geometry', () => {
  it('anchor shifts move the box so the anchor point lands on x, y', () => {
    expect(anchorShift('top-left', 100, 20)).toEqual({ dx: 0, dy: 0 });
    expect(anchorShift('center', 100, 20)).toEqual({ dx: 50, dy: 10 });
    expect(anchorShift('bottom-right', 100, 20)).toEqual({ dx: 100, dy: 20 });
  });

  it('a preview box is in percent of the page', () => {
    const b = previewBox(100, 200, 100, 20, 'center', { width: 500, height: 1000 });
    expect(b.left).toBeCloseTo(((100 - 50) / 500) * 100, 6);
    expect(b.top).toBeCloseTo(((200 - 10) / 1000) * 100, 6);
    expect(b.width).toBeCloseTo(20, 6);
  });

  it('text size is an estimate that wraps at the box width', () => {
    const one = estimateTextBox('abcd', 10, 0);
    expect(one.lines).toBe(1);
    const wrapped = estimateTextBox('abcdefghij', 10, 20);
    expect(wrapped.lines).toBeGreaterThan(1);
  });
});

describe('preset names', () => {
  it('trimmed, not empty, not longer than 60, unique ignoring case', () => {
    expect(validatePresetName('  ', [])).toEqual({ ok: false, issue: 'empty' });
    expect(validatePresetName('x'.repeat(61), [])).toEqual({ ok: false, issue: 'tooLong' });
    expect(validatePresetName(' Mật ', ['mật'])).toEqual({ ok: false, issue: 'duplicate' });
    expect(validatePresetName(' Nội bộ ', [])).toEqual({ ok: true, name: 'Nội bộ' });
  });
});

describe('ops from the forms match the contract', () => {
  it('a default page number form is valid for the core', () => {
    expect(checkPageNumbers(DEFAULT_PAGE_NUMBERS_FORM, 3, 0)).toEqual({ ok: true });
    expect(pageNumbersParams(DEFAULT_PAGE_NUMBERS_FORM, 0, 3).position).toBe('bottom-center');
  });

  it('unused helpers still accept the default forms', () => {
    expect(checkWatermark(DEFAULT_WATERMARK_FORM, 1, 0).ok).toBe(true);
    expect(checkBates({ ...DEFAULT_BATES_FORM, files: ['/a.pdf'] }).ok).toBe(true);
  });
});
