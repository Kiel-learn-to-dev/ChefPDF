import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_FORM,
  applyParams,
  buildParams,
  dpiLimitFromError,
  durationParts,
  formIssues,
  localizeWarning,
  mergePresetOptions,
  parseMegabytes,
  presetParamsOf,
  validatePresetName,
  type ScanForm,
} from './scanModel';

const form = (patch: Partial<ScanForm> = {}): ScanForm => ({ ...DEFAULT_SCAN_FORM, ...patch });

describe('buildParams / applyParams (form <-> rasterize params)', () => {
  it('omits pages when every page is selected', () => {
    const params = buildParams(form(), 10);
    expect(params).not.toBeNull();
    expect(params).not.toHaveProperty('pages');
    expect(params).toMatchObject({
      dpi: 200,
      color: 'gray',
      jpegQuality: 75,
      threshold: 128,
      dithering: false,
      stripMetadata: true,
      effectsPreset: 'none',
      seed: 0,
    });
  });

  it('turns 1-based page ranges into 0-based sorted indices', () => {
    expect(buildParams(form({ pagesText: '3, 1-2' }), 10)).toMatchObject({ pages: [0, 1, 2] });
  });

  it('round trip form -> params -> form keeps every field', () => {
    const f = form({
      dpi: 300,
      color: 'bw',
      jpegQuality: 40,
      threshold: 140,
      dithering: true,
      pagesText: '1-3,5',
      stripMetadata: false,
      effectsPreset: 'old-paper',
      seed: 7,
    });
    const params = buildParams(f, 10);
    expect(params).not.toBeNull();
    expect(applyParams(DEFAULT_SCAN_FORM, params)).toEqual(f);
  });

  it('round trip keeps the all-pages choice', () => {
    const f = form({ color: 'color', jpegQuality: 90 });
    expect(applyParams(DEFAULT_SCAN_FORM, buildParams(f, 3))).toEqual(f);
  });

  it('a null pages value means all pages; absent pages keep the current choice', () => {
    expect(applyParams(form({ pagesText: '2-4' }), { pages: null }).pagesText).toBe('');
    expect(applyParams(form({ pagesText: '2-4' }), { dpi: 150 }).pagesText).toBe('2-4');
  });

  it('applies a partial preset and keeps the other fields', () => {
    const next = applyParams(form({ pagesText: '1' }), { dpi: 150, color: 'bw', dithering: true });
    expect(next).toEqual({ ...form({ pagesText: '1' }), dpi: 150, color: 'bw', dithering: true });
  });

  it('ignores unknown or invalid values from the core', () => {
    const next = applyParams(form(), { color: 'purple', dpi: 'x', effectsPreset: null } as never);
    expect(next.color).toBe('gray');
    expect(next.dpi).toBe(200);
    expect(next.effectsPreset).toBe('none');
  });

  it('reports invalid fields and refuses to build params', () => {
    expect(formIssues(form({ dpi: 50 }), 3)).toEqual(['dpi']);
    expect(formIssues(form({ jpegQuality: 0 }), 3)).toEqual(['jpegQuality']);
    expect(formIssues(form({ threshold: 300 }), 3)).toEqual(['threshold']);
    expect(formIssues(form({ seed: -1 }), 3)).toEqual(['seed']);
    expect(formIssues(form({ pagesText: '9' }), 3)).toEqual(['pages']);
    expect(formIssues(form({ dpi: 2.5 }), 3)).toEqual(['dpi']);
    expect(formIssues(form(), 3)).toEqual([]);
    expect(buildParams(form({ dpi: 50 }), 3)).toBeNull();
    expect(buildParams(form({ pagesText: 'abc' }), 3)).toBeNull();
  });
});

describe('presetParamsOf', () => {
  it('saves the options without the page choice', () => {
    const params = presetParamsOf(form({ pagesText: '1-2', dpi: 300 }), 5);
    expect(params).not.toHaveProperty('pages');
    expect(params).toMatchObject({ dpi: 300 });
    expect(presetParamsOf(form({ dpi: 0 }), 5)).toBeNull();
  });
});

describe('mergePresetOptions', () => {
  const builtins = [
    {
      name: 'email-light',
      labelVi: 'Nhẹ để gửi email',
      labelEn: 'Light for email',
      params: { dpi: 150 },
    },
  ];
  const user = [{ name: 'Hồ sơ', params: { dpi: 300 } }];

  it('lists built-in presets first, then the user presets, with localized labels', () => {
    expect(mergePresetOptions(builtins, user, 'vi')).toEqual([
      {
        key: 'builtin:email-light',
        label: 'Nhẹ để gửi email',
        source: 'builtin',
        name: 'email-light',
        params: { dpi: 150 },
      },
      { key: 'user:Hồ sơ', label: 'Hồ sơ', source: 'user', name: 'Hồ sơ', params: { dpi: 300 } },
    ]);
    expect(mergePresetOptions(builtins, [], 'en')[0]?.label).toBe('Light for email');
  });
});

describe('validatePresetName', () => {
  const taken = ['Light for email', 'email-light', 'Hồ sơ'];

  it('trims the name', () => {
    expect(validatePresetName('  Kho lưu  ', taken)).toEqual({ ok: true, name: 'Kho lưu' });
  });

  it('rejects empty, too long and duplicate names (case-insensitive)', () => {
    expect(validatePresetName('   ', taken)).toEqual({ ok: false, issue: 'empty' });
    expect(validatePresetName('x'.repeat(61), taken)).toEqual({ ok: false, issue: 'tooLong' });
    expect(validatePresetName(' hồ SƠ ', taken)).toEqual({ ok: false, issue: 'duplicate' });
    expect(validatePresetName('EMAIL-LIGHT', taken)).toEqual({ ok: false, issue: 'duplicate' });
  });
});

describe('dpiLimitFromError', () => {
  it('reads the largest allowed dpi from an INVALID_PARAMS error', () => {
    expect(dpiLimitFromError('INVALID_PARAMS', { field: 'dpi', maxDpi: 300 })).toBe(300);
    expect(dpiLimitFromError('INVALID_PARAMS', { field: 'pages' })).toBeNull();
    expect(dpiLimitFromError('INTERNAL', { field: 'dpi', maxDpi: 300 })).toBeNull();
    expect(dpiLimitFromError('INVALID_PARAMS', { field: 'dpi', maxDpi: 10 })).toBeNull();
    expect(dpiLimitFromError('INVALID_PARAMS', undefined)).toBeNull();
  });
});

describe('localizeWarning', () => {
  it('maps the core loss warnings to translation keys', () => {
    expect(localizeWarning('Text will be lost: converted pages become images without text.')).toBe(
      'scan.warn.text',
    );
    expect(localizeWarning('Links will be lost.')).toBe('scan.warn.links');
    expect(localizeWarning('Bookmarks will be lost.')).toBe('scan.warn.bookmarks');
    expect(localizeWarning('Form fields will be lost.')).toBe('scan.warn.forms');
    expect(localizeWarning('Digital signatures will be lost.')).toBe('scan.warn.signatures');
    expect(localizeWarning('Something else.')).toBeNull();
  });
});

describe('durationParts', () => {
  it('shows seconds below a minute and minutes above', () => {
    expect(durationParts(0.2)).toEqual({ unit: 'seconds', value: 1 });
    expect(durationParts(42.4)).toEqual({ unit: 'seconds', value: 42 });
    expect(durationParts(119)).toEqual({ unit: 'minutes', value: 2 });
  });
});

describe('parseMegabytes', () => {
  it('converts a positive MB value to bytes', () => {
    expect(parseMegabytes('5')).toBe(5 * 1024 * 1024);
    expect(parseMegabytes('0.5')).toBe(512 * 1024);
    expect(parseMegabytes('0')).toBeNull();
    expect(parseMegabytes('abc')).toBeNull();
    expect(parseMegabytes('')).toBeNull();
  });
});
