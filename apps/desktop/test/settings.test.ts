import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_FILES,
  MAX_SCAN_PRESETS,
  SettingsStore,
  defaultSettings,
  sanitizeScanPresets,
  sanitizeSettings,
  validatePatch,
  validateScanPresets,
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
