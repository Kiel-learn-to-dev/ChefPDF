import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_KNOWN_PFX,
  MAX_RECENT_FILES,
  MAX_SCAN_PRESETS,
  SettingsStore,
  defaultSettings,
  sanitizeKnownPfx,
  MAX_SIGN_TEMPLATES,
  MAX_SIGN_TEMPLATE_BYTES,
  MAX_TSA_URLS,
  sanitizeScanPresets,
  sanitizeTsaUrls,
  validateTsaUrls,
  sanitizeSettings,
  sanitizeSignTemplates,
  validateKnownPfx,
  validatePatch,
  validateScanPresets,
  validateSignTemplates,
  SettingsValidationError,
  MAX_OVERLAY_PRESETS,
  sanitizeOverlayPresets,
  validateOverlayPresets,
  cleanUserName,
  validateUserName,
  MAX_USER_NAME,
} from '../src/main/settings';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chef-settings-'));
}

describe('SettingsStore', () => {
  it('returns defaults when no file exists (vi, system theme, version 1)', async () => {
    const store = new SettingsStore(tmpDir());
    expect(await store.load()).toEqual({
      version: 1,
      language: 'vi',
      theme: 'system',
      defaultSaveDir: null,
      recentFiles: [],
      prefs: {},
      scanPresets: [],
      knownPfxFiles: [],
      lastDriverPath: null,
      signTemplates: [],
      tsaUrls: [],
      overlayPresets: [],
      compressPresets: [],
      userName: '',
    });
  });

  it('persists patches and reloads them', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    await store.load();
    const s = await store.set({ language: 'en', theme: 'dark', prefs: { K: { dpi: 200 } } });
    expect(s).toMatchObject({ language: 'en', theme: 'dark', prefs: { K: { dpi: 200 } } });
    const again = await new SettingsStore(dir).load();
    expect(again).toEqual(s);
    // Atomic write leaves no temp files behind.
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('serialises concurrent writes; last write wins on disk', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    await store.load();
    await Promise.all([
      store.set({ theme: 'light' }),
      store.set({ theme: 'dark' }),
      store.set({ language: 'en' }),
    ]);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(disk).toMatchObject({ theme: 'dark', language: 'en' });
  });

  it('backs up a corrupt file and starts from defaults', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
    const store = new SettingsStore(dir, 'linux', () => new Date(1234));
    expect(await store.load()).toEqual(defaultSettings());
    expect(fs.existsSync(path.join(dir, 'settings.json.corrupt-1234'))).toBe(true);
  });

  it('sanitises unknown or invalid fields from disk', () => {
    const s = sanitizeSettings({
      version: 7,
      language: 'fr',
      theme: 'dark',
      defaultSaveDir: 'relative/dir',
      recentFiles: [{ path: '/a.pdf', name: 'a.pdf', openedAt: 'x' }, { bogus: true }],
      prefs: [],
      extra: 1,
    });
    expect(s).toEqual({
      ...defaultSettings(),
      theme: 'dark',
      recentFiles: [{ path: '/a.pdf', name: 'a.pdf', openedAt: 'x' }],
    });
  });

  it('rejects invalid patches', async () => {
    const store = new SettingsStore(tmpDir());
    await expect(store.set({ language: 'de' })).rejects.toThrow(/language/);
    await expect(store.set({ theme: 3 })).rejects.toThrow(/theme/);
    await expect(store.set({ nope: 1 })).rejects.toThrow(/Unknown/);
    await expect(store.set({ defaultSaveDir: 'rel' })).rejects.toThrow(/absolute/);
    await expect(store.set({ version: 2 })).rejects.toThrow(/version/);
    await expect(store.set(null)).rejects.toThrow(/object/);
    await expect(store.set({ prefs: { big: 'x'.repeat(2 * 1024 * 1024) } })).rejects.toThrow(
      /too large/,
    );
    expect(validatePatch({ defaultSaveDir: null })).toEqual({ defaultSaveDir: null });
  });

  it('addRecent: newest first, de-duplicated, capped at 20', async () => {
    let t = 0;
    const store = new SettingsStore(
      tmpDir(),
      'linux',
      () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)),
    );
    await store.load();
    for (let i = 0; i < 25; i++) await store.addRecent(`/docs/file-${i}.pdf`);
    let s = await store.addRecent('/docs/file-10.pdf');
    expect(s.recentFiles).toHaveLength(MAX_RECENT_FILES);
    expect(s.recentFiles[0]).toEqual({
      path: '/docs/file-10.pdf',
      name: 'file-10.pdf',
      openedAt: '2026-01-01T00:00:25.000Z',
    });
    expect(s.recentFiles.filter((r) => r.path === '/docs/file-10.pdf')).toHaveLength(1);
    expect(s.recentFiles[1]?.path).toBe('/docs/file-24.pdf');
    s = await store.addRecent('/docs/file-24.pdf');
    expect(s.recentFiles.slice(0, 2).map((r) => r.name)).toEqual(['file-24.pdf', 'file-10.pdf']);
    await expect(store.addRecent('relative.pdf')).rejects.toThrow(/absolute/);
  });

  it('de-duplicates recent files case-insensitively on Windows', async () => {
    const store = new SettingsStore(tmpDir(), 'win32');
    await store.load();
    await store.addRecent(path.resolve('/Docs/A.pdf'));
    const s = await store.addRecent(path.resolve('/docs/a.PDF'));
    expect(s.recentFiles).toHaveLength(1);
  });

  it('reads older settings files without scanPresets as an empty list', () => {
    const s = sanitizeSettings({ version: 1, language: 'en', theme: 'light' });
    expect(s.scanPresets).toEqual([]);
    expect(s.language).toBe('en');
  });

  it('keeps valid scan presets from disk and drops malformed or duplicate ones', () => {
    const s = sanitizeSettings({
      scanPresets: [
        { name: '  Hồ sơ  ', params: { dpi: 300, color: 'gray' } },
        { name: 'hồ sơ', params: { dpi: 200 } },
        { name: '', params: {} },
        { name: 'x', params: [] },
        { name: 'y'.repeat(61), params: {} },
        { name: 'big', params: { t: 'z'.repeat(5000) } },
        'nope',
      ],
    });
    expect(s.scanPresets).toEqual([{ name: 'Hồ sơ', params: { dpi: 300, color: 'gray' } }]);
    expect(sanitizeScanPresets('not a list')).toEqual([]);
    const many = Array.from({ length: MAX_SCAN_PRESETS + 5 }, (_, i) => ({
      name: `p${i}`,
      params: {},
    }));
    expect(sanitizeScanPresets(many)).toHaveLength(MAX_SCAN_PRESETS);
  });

  it('validates scan preset patches strictly', () => {
    expect(validatePatch({ scanPresets: [{ name: ' A ', params: { dpi: 150 } }] })).toEqual({
      scanPresets: [{ name: 'A', params: { dpi: 150 } }],
    });
    expect(validatePatch({ scanPresets: [] })).toEqual({ scanPresets: [] });
    expect(() => validateScanPresets([{ name: '', params: {} }])).toThrow(/Invalid scan preset/);
    expect(() =>
      validateScanPresets([
        { name: 'a', params: {} },
        { name: 'A', params: {} },
      ]),
    ).toThrow(/Duplicate/);
    expect(() => validateScanPresets('x')).toThrow(/array/);
    expect(() =>
      validateScanPresets(
        Array.from({ length: MAX_SCAN_PRESETS + 1 }, (_, i) => ({ name: `n${i}`, params: {} })),
      ),
    ).toThrow(/at most/);
    expect(() => validatePatch({ scanPresets: [{ name: 'a', params: 'x' }] })).toThrow(
      /Invalid scan preset/,
    );
  });

  it('persists scan presets and reloads them', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    await store.load();
    await store.set({ scanPresets: [{ name: 'Lưu', params: { dpi: 300, color: 'bw' } }] });
    const again = await new SettingsStore(dir).load();
    expect(again.scanPresets).toEqual([{ name: 'Lưu', params: { dpi: 300, color: 'bw' } }]);
  });

  it('notifies change listeners', async () => {
    const store = new SettingsStore(tmpDir());
    const seen: string[] = [];
    store.onChange((s) => seen.push(s.theme));
    await store.set({ theme: 'light' });
    expect(seen).toEqual(['light']);
  });
});

describe('certificate settings (knownPfxFiles, lastDriverPath)', () => {
  const dir = path.resolve('chef-test-certs');
  const pfx = (name: string) => path.join(dir, name);

  it('reads older files without the new fields as empty / null', () => {
    const s = sanitizeSettings({ language: 'en', version: 1 });
    expect(s.knownPfxFiles).toEqual([]);
    expect(s.lastDriverPath).toBeNull();
  });

  it('keeps valid entries from disk and drops malformed or duplicate ones', () => {
    const raw = [
      { path: pfx('a.pfx'), label: 'Ký A', remembered: true },
      { path: pfx('a.pfx'), label: 'trùng' },
      { path: 'relative.pfx', label: 'x' },
      { path: pfx('b.p12') },
      { label: 'no path' },
      'junk',
    ];
    const list = sanitizeKnownPfx(raw, 'linux');
    expect(list).toEqual([
      { path: pfx('a.pfx'), label: 'Ký A', remembered: true },
      { path: pfx('b.p12'), label: 'b.p12', remembered: false },
    ]);
    expect(sanitizeKnownPfx('nope')).toEqual([]);
  });

  it('caps the list and treats Windows paths case-insensitively', () => {
    const many = Array.from({ length: MAX_KNOWN_PFX + 5 }, (_, i) => ({ path: pfx(`f${i}.pfx`) }));
    expect(sanitizeKnownPfx(many, 'linux')).toHaveLength(MAX_KNOWN_PFX);
    const win = sanitizeKnownPfx(
      [{ path: 'C:\\Certs\\a.pfx' }, { path: 'c:\\certs\\A.pfx' }],
      'win32',
    );
    expect(win).toHaveLength(1);
  });

  it('validates knownPfxFiles patches strictly', () => {
    expect(
      validateKnownPfx([{ path: pfx('a.pfx'), label: 'A', remembered: false }], 'linux'),
    ).toEqual([{ path: pfx('a.pfx'), label: 'A', remembered: false }]);
    expect(() => validateKnownPfx([{ path: 'a.pfx' }], 'linux')).toThrow(/Invalid/);
    expect(() => validateKnownPfx([{ path: pfx('a.pfx'), remembered: 'yes' }], 'linux')).toThrow();
    expect(() =>
      validateKnownPfx([{ path: pfx('a.pfx') }, { path: pfx('a.pfx') }], 'linux'),
    ).toThrow(/Duplicate/);
    expect(() => validateKnownPfx('x', 'linux')).toThrow();
  });

  it('accepts lastDriverPath as an absolute path or null, and rejects others', () => {
    expect(validatePatch({ lastDriverPath: pfx('driver.dll') })).toEqual({
      lastDriverPath: pfx('driver.dll'),
    });
    expect(validatePatch({ lastDriverPath: null })).toEqual({ lastDriverPath: null });
    expect(() => validatePatch({ lastDriverPath: 'driver.dll' })).toThrow();
    expect(() => validatePatch({ lastDriverPath: 42 })).toThrow();
  });

  it('persists both fields and reloads them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-settings-cert-'));
    try {
      const store = new SettingsStore(root);
      await store.load();
      await store.set({
        knownPfxFiles: [{ path: pfx('a.pfx'), label: 'A', remembered: true }],
        lastDriverPath: pfx('driver.dll'),
      });
      const again = await new SettingsStore(root).load();
      expect(again.knownPfxFiles).toEqual([{ path: pfx('a.pfx'), label: 'A', remembered: true }]);
      expect(again.lastDriverPath).toBe(pfx('driver.dll'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('signature templates (I10)', () => {
  const FP_A = 'a'.repeat(64);
  const FP_B = 'b'.repeat(64);
  const LIB = 'c'.repeat(32);
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `Mẫu ${id}`,
    template: { name: id, layout: 'text-only', fontSize: 9 },
    ...extra,
  });

  it('reads older files without signTemplates as an empty list', () => {
    expect(sanitizeSettings({ language: 'en' }).signTemplates).toEqual([]);
  });

  it('keeps valid templates from disk and drops malformed or duplicate ones', () => {
    const out = sanitizeSignTemplates([
      entry('t1'),
      entry('t1'),
      entry('bad id!'),
      { ...entry('t2'), name: '   ' },
      { ...entry('t3'), template: [] },
      entry('t4', { certFingerprint: 'XYZ' }),
      entry('t5', { libraryRefs: { image: LIB } }),
      entry('t6', { libraryRefs: { image: '../escape' } }),
    ]);
    expect(out.map((e) => e.id)).toEqual(['t1', 't5']);
    expect(out[1]!.libraryRefs).toEqual({ image: LIB });
  });

  it('keeps one binding per certificate and lower-cases fingerprints', () => {
    const out = sanitizeSignTemplates([
      entry('t1', { certFingerprint: FP_A.toUpperCase() }),
      entry('t2', { certFingerprint: FP_A }),
      entry('t3', { certFingerprint: FP_B }),
    ]);
    expect(out[0]!.certFingerprint).toBe(FP_A);
    expect(out[1]!.certFingerprint).toBeUndefined();
    expect(out[2]!.certFingerprint).toBe(FP_B);
  });

  it('caps the list and the template size', () => {
    const many = Array.from({ length: MAX_SIGN_TEMPLATES + 5 }, (_, i) => entry(`t${i}`));
    expect(sanitizeSignTemplates(many)).toHaveLength(MAX_SIGN_TEMPLATES);
    const big = entry('huge', { template: { text: 'x'.repeat(MAX_SIGN_TEMPLATE_BYTES) } });
    expect(sanitizeSignTemplates([big])).toEqual([]);
  });

  it('validates patches strictly', () => {
    expect(validateSignTemplates([entry('t1')])).toHaveLength(1);
    expect(() => validateSignTemplates([entry('t1'), entry('t1')])).toThrow(/Duplicate/);
    expect(() => validateSignTemplates([{ ...entry('t1'), template: 'no' }])).toThrow(/Invalid/);
    expect(() =>
      validateSignTemplates([
        entry('t1', { certFingerprint: FP_A }),
        entry('t2', { certFingerprint: FP_A }),
      ]),
    ).toThrow(/only one bound/);
    expect(() => validateSignTemplates('nope')).toThrow(/array/);
    expect(validatePatch({ signTemplates: [entry('t9')] })).toEqual({
      signTemplates: [entry('t9')],
    });
  });

  it('persists templates and reloads them', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    await store.load();
    await store.set({ signTemplates: [entry('t1', { certFingerprint: FP_A })] });
    const again = new SettingsStore(dir);
    expect((await again.load()).signTemplates).toEqual([entry('t1', { certFingerprint: FP_A })]);
  });
});

describe('timestamp servers (I28, tsaUrls)', () => {
  it('reads older files without tsaUrls as an empty list', () => {
    expect(sanitizeSettings({ version: 1 }).tsaUrls).toEqual([]);
  });

  it('keeps valid http(s) URLs from disk in order and drops the rest', () => {
    expect(
      sanitizeTsaUrls([
        'https://tsa.example.vn/tsa',
        'ftp://bad.example/',
        42,
        '  http://other.example.vn/ts ',
        'https://tsa.example.vn/tsa',
        'not a url',
      ]),
    ).toEqual(['https://tsa.example.vn/tsa', 'http://other.example.vn/ts']);
  });

  it('caps the list at five', () => {
    const many = Array.from({ length: MAX_TSA_URLS + 3 }, (_, i) => `https://t${i}.example/`);
    expect(sanitizeTsaUrls(many)).toHaveLength(MAX_TSA_URLS);
  });

  it('validates patches strictly', () => {
    expect(validateTsaUrls(['https://tsa.example.vn/'])).toEqual(['https://tsa.example.vn/']);
    expect(() => validateTsaUrls(['javascript:alert(1)'])).toThrow(SettingsValidationError);
    expect(() => validateTsaUrls(['https://a.example/', 'https://a.example/'])).toThrow(
      SettingsValidationError,
    );
    expect(() => validateTsaUrls(Array(MAX_TSA_URLS + 1).fill('https://a.example/'))).toThrow(
      SettingsValidationError,
    );
    expect(() => validatePatch({ tsaUrls: 'https://a.example/' })).toThrow(SettingsValidationError);
    expect(validatePatch({ tsaUrls: [] })).toEqual({ tsaUrls: [] });
  });

  it('persists the list and reloads it', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    await store.load();
    await store.set({ tsaUrls: ['https://tsa.example.vn/tsa'] });
    const again = new SettingsStore(dir);
    expect((await again.load()).tsaUrls).toEqual(['https://tsa.example.vn/tsa']);
  });
});

describe('overlay (watermark) presets (F1, overlayPresets)', () => {
  const look = { fontSize: 60, bold: true, color: '#808080', opacity: 0.25, rotation: 45 };

  it('reads older files without overlayPresets as an empty list', () => {
    expect(sanitizeSettings({ version: 1 }).overlayPresets).toEqual([]);
  });

  it('drops malformed entries, paths and case-insensitive duplicates when reading', () => {
    const out = sanitizeOverlayPresets([
      { name: ' Nội bộ ', kind: 'watermark', params: look },
      { name: 'nội BỘ', kind: 'watermark', params: look },
      { name: 'Sai loại', kind: 'stamp', params: look },
      { name: '', kind: 'watermark', params: look },
      { name: 'Quá dài', kind: 'watermark', params: { text: 'x'.repeat(3000) } },
      'không phải đối tượng',
    ]);
    expect(out).toEqual([{ name: 'Nội bộ', kind: 'watermark', params: look }]);
  });

  it('caps the list when reading', () => {
    const many = Array.from({ length: MAX_OVERLAY_PRESETS + 5 }, (_, i) => ({
      name: `p${i}`,
      kind: 'watermark',
      params: look,
    }));
    expect(sanitizeOverlayPresets(many)).toHaveLength(MAX_OVERLAY_PRESETS);
  });

  it('validates a patch strictly: duplicates and bad kinds throw', () => {
    expect(() =>
      validatePatch({ overlayPresets: [{ name: 'A', kind: 'watermark', params: look }] }),
    ).not.toThrow();
    expect(() =>
      validatePatch({
        overlayPresets: [
          { name: 'A', kind: 'watermark', params: look },
          { name: 'a', kind: 'watermark', params: look },
        ],
      }),
    ).toThrow(SettingsValidationError);
    expect(() =>
      validatePatch({ overlayPresets: [{ name: 'A', kind: 'image', params: look }] }),
    ).toThrow(SettingsValidationError);
    expect(() => validateOverlayPresets('nope')).toThrow(SettingsValidationError);
  });

  it('persists presets across a reload', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    await store.load();
    await store.set({ overlayPresets: [{ name: 'Đã duyệt', kind: 'watermark', params: look }] });
    expect((await new SettingsStore(dir).load()).overlayPresets).toEqual([
      { name: 'Đã duyệt', kind: 'watermark', params: look },
    ]);
  });
});

describe('user name (F2, {user} stamp variable)', () => {
  it('defaults to an empty name and reads older files without it', () => {
    expect(defaultSettings().userName).toBe('');
    expect(sanitizeSettings({ language: 'en' }).userName).toBe('');
  });

  it('keeps a trimmed name from disk and drops invalid ones', () => {
    expect(sanitizeSettings({ userName: '  Nguyễn Văn A ' }).userName).toBe('Nguyễn Văn A');
    expect(sanitizeSettings({ userName: 'a\u0007b' }).userName).toBe('');
    expect(sanitizeSettings({ userName: 42 }).userName).toBe('');
    expect(sanitizeSettings({ userName: 'x'.repeat(MAX_USER_NAME + 1) }).userName).toBe('');
  });

  it('cleanUserName returns null for invalid values', () => {
    expect(cleanUserName('  ok  ')).toBe('ok');
    expect(cleanUserName('line\nbreak')).toBeNull();
    expect(cleanUserName(null)).toBeNull();
  });

  it('validates the patch strictly', () => {
    expect(validatePatch({ userName: 'Minh' })).toEqual({ userName: 'Minh' });
    expect(() => validatePatch({ userName: 'bad\u0000' })).toThrow(SettingsValidationError);
    expect(() => validateUserName('y'.repeat(MAX_USER_NAME + 1))).toThrow(SettingsValidationError);
  });
});
