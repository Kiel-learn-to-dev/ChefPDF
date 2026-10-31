/**
 * Settings store: `<userData>/settings.json` (docs/CONTRACTS.md section 7).
 * Pure Node: no Electron imports.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  LanguageSetting,
  RecentFile,
  ScanUserPreset,
  Settings,
  ThemeSetting,
} from '@chef/contracts';
import { atomicWriteFile, isPlainObject, readJsonFile } from './fsutil';

export const MAX_RECENT_FILES = 20;
export const MAX_SCAN_PRESETS = 50;
export const MAX_SCAN_PRESET_NAME = 60;
const MAX_SCAN_PRESET_PARAMS_BYTES = 4096;
const MAX_PREFS_BYTES = 1024 * 1024;
const LANGUAGES: readonly LanguageSetting[] = ['vi', 'en'];
const THEMES: readonly ThemeSetting[] = ['system', 'light', 'dark'];

export function defaultSettings(): Settings {
  return {
    version: 1,
    language: 'vi',
    theme: 'system',
    defaultSaveDir: null,
    recentFiles: [],
    prefs: {},
    scanPresets: [],
  };
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function validRecent(v: unknown): v is RecentFile {
  return (
    isPlainObject(v) &&
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.openedAt === 'string'
  );
}

/** Trimmed name + JSON-serialisable params of a scan preset, or null when malformed. */
function normalizeScanPreset(v: unknown): ScanUserPreset | null {
  if (!isPlainObject(v) || typeof v.name !== 'string' || !isPlainObject(v.params)) return null;
  const name = v.name.trim();
  if (name.length === 0 || name.length > MAX_SCAN_PRESET_NAME) return null;
  let json: string;
  try {
    json = JSON.stringify(v.params);
  } catch {
    return null;
  }
  if (json.length > MAX_SCAN_PRESET_PARAMS_BYTES) return null;
  return { name, params: JSON.parse(json) as Record<string, unknown> };
}

/** Lower-cased name for the case-insensitive uniqueness check. */
const presetKey = (name: string) => name.toLowerCase();

/** Keeps valid, uniquely named presets from untrusted disk data (invalid entries are dropped). */
export function sanitizeScanPresets(raw: unknown): ScanUserPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanUserPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const preset = normalizeScanPreset(item);
    if (!preset || seen.has(presetKey(preset.name))) continue;
    seen.add(presetKey(preset.name));
    out.push(preset);
    if (out.length >= MAX_SCAN_PRESETS) break;
  }
  return out;
}

/** Validates a renderer-provided list of scan presets strictly (throws on the first bad entry). */
export function validateScanPresets(value: unknown): ScanUserPreset[] {
  if (!Array.isArray(value) || value.length > MAX_SCAN_PRESETS) {
    throw new SettingsValidationError(
      `scanPresets must be an array of at most ${MAX_SCAN_PRESETS}`,
    );
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const preset = normalizeScanPreset(item);
    if (!preset) throw new SettingsValidationError('Invalid scan preset');
    if (seen.has(presetKey(preset.name))) {
      throw new SettingsValidationError(`Duplicate scan preset name: ${preset.name}`);
    }
    seen.add(presetKey(preset.name));
    return preset;
  });
}

function dedupeRecent(list: RecentFile[], platform: NodeJS.Platform): RecentFile[] {
  const out: RecentFile[] = [];
  for (const r of list) {
    if (!out.some((o) => samePath(o.path, r.path, platform))) out.push(r);
    if (out.length >= MAX_RECENT_FILES) break;
  }
  return out;
}

/** Builds a valid Settings object from untrusted JSON, falling back to defaults per field. */
export function sanitizeSettings(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): Settings {
  const s = defaultSettings();
  if (!isPlainObject(raw)) return s;
  if (LANGUAGES.includes(raw.language as LanguageSetting))
    s.language = raw.language as LanguageSetting;
  if (THEMES.includes(raw.theme as ThemeSetting)) s.theme = raw.theme as ThemeSetting;
  if (typeof raw.defaultSaveDir === 'string' && path.isAbsolute(raw.defaultSaveDir)) {
    s.defaultSaveDir = raw.defaultSaveDir;
  }
  if (Array.isArray(raw.recentFiles)) {
    s.recentFiles = dedupeRecent(
      raw.recentFiles
        .filter(validRecent)
        .map((r) => ({ path: r.path, name: r.name, openedAt: r.openedAt })),
      platform,
    );
  }
  if (isPlainObject(raw.prefs)) s.prefs = raw.prefs;
  s.scanPresets = sanitizeScanPresets(raw.scanPresets);
  return s;
}

/** Validates a renderer patch strictly (unknown keys / bad values throw). */
export function validatePatch(
  patch: unknown,
  platform: NodeJS.Platform = process.platform,
): Partial<Settings> {
  if (!isPlainObject(patch)) throw new SettingsValidationError('Settings patch must be an object');
  const out: Partial<Settings> = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'version':
        if (value !== 1) throw new SettingsValidationError('Unsupported settings version');
        break;
      case 'language':
        if (!LANGUAGES.includes(value as LanguageSetting))
          throw new SettingsValidationError('Invalid language');
        out.language = value as LanguageSetting;
        break;
      case 'theme':
        if (!THEMES.includes(value as ThemeSetting))
          throw new SettingsValidationError('Invalid theme');
        out.theme = value as ThemeSetting;
        break;
      case 'defaultSaveDir':
        if (value !== null && !(typeof value === 'string' && path.isAbsolute(value))) {
          throw new SettingsValidationError('defaultSaveDir must be an absolute path or null');
        }
        out.defaultSaveDir = value as string | null;
        break;
      case 'recentFiles':
        if (!Array.isArray(value) || !value.every(validRecent)) {
          throw new SettingsValidationError('Invalid recentFiles');
        }
        out.recentFiles = dedupeRecent(
          value.map((r) => ({ path: r.path, name: r.name, openedAt: r.openedAt })),
          platform,
        );
        break;
      case 'scanPresets':
        out.scanPresets = validateScanPresets(value);
        break;
      case 'prefs': {
        if (!isPlainObject(value)) throw new SettingsValidationError('prefs must be an object');
        let json: string;
        try {
          json = JSON.stringify(value);
        } catch {
          throw new SettingsValidationError('prefs must be JSON-serialisable');
        }
        if (json.length > MAX_PREFS_BYTES) throw new SettingsValidationError('prefs too large');
        out.prefs = JSON.parse(json) as Record<string, unknown>;
        break;
      }
      default:
        throw new SettingsValidationError(`Unknown settings key: ${key}`);
    }
  }
  return out;
}

export class SettingsStore {
  readonly file: string;
  private current: Settings = defaultSettings();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: Settings) => void>();

  constructor(
    userDataDir: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(userDataDir, 'settings.json');
  }

  async load(): Promise<Settings> {
    const res = await readJsonFile(this.file);
    if (res.ok) {
      this.current = sanitizeSettings(res.value, this.platform);
    } else {
      this.current = defaultSettings();
      if (!res.missing) {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        const backup = `${this.file}.corrupt-${this.now().getTime()}`;
        await fs.rename(this.file, backup).catch(() => undefined);
      }
    }
    this.loaded = true;
    return this.get();
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shallow-merges a validated patch (top-level keys replace) and persists it. */
  async set(patch: unknown): Promise<Settings> {
    const valid = validatePatch(patch, this.platform);
    if (!this.loaded) await this.load();
    return this.commit({ ...this.current, ...valid, version: 1 });
  }

  /** Adds `filePath` to the front of recent files (de-duplicated, max 20). */
  async addRecent(filePath: string): Promise<Settings> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new SettingsValidationError('addRecent requires an absolute path');
    }
    if (!this.loaded) await this.load();
    const entry: RecentFile = {
      path: filePath,
      name: path.basename(filePath),
      openedAt: this.now().toISOString(),
    };
    const recent = dedupeRecent([entry, ...this.current.recentFiles], this.platform);
    return this.commit({ ...this.current, recentFiles: recent });
  }

  /** Resolves when every queued write has hit the disk. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private async commit(next: Settings): Promise<Settings> {
    this.current = next;
    const snapshot = JSON.stringify(next, null, 2) + '\n';
    const write = this.writeChain.then(() => atomicWriteFile(this.file, snapshot));
    this.writeChain = write.catch(() => undefined);
    await write;
    const copy = this.get();
    for (const l of this.listeners) l(copy);
    return copy;
  }
}
