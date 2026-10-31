/**
 * Settings store: `<userData>/settings.json` (docs/CONTRACTS.md section 7).
 * Pure Node: no Electron imports.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  KnownPfxFile,
  LanguageSetting,
  OverlayUserPreset,
  RecentFile,
  ScanUserPreset,
  Settings,
  SignTemplateEntry,
  ThemeSetting,
} from '@chef/contracts';
import { atomicWriteFile, isPlainObject, readJsonFile } from './fsutil';

export const MAX_RECENT_FILES = 20;
export const MAX_SCAN_PRESETS = 50;
export const MAX_SCAN_PRESET_NAME = 60;
export const MAX_KNOWN_PFX = 20;
export const MAX_PFX_LABEL = 200;
export const MAX_SIGN_TEMPLATES = 50;
export const MAX_SIGN_TEMPLATE_BYTES = 16 * 1024;
export const MAX_SIGN_TEMPLATE_NAME = 80;
export const MAX_TSA_URLS = 5;
export const MAX_OVERLAY_PRESETS = 50;
export const MAX_OVERLAY_PRESET_NAME = 60;
const MAX_OVERLAY_PRESET_PARAMS_BYTES = 2048;
const OVERLAY_PRESET_KINDS = ['watermark'] as const;
const MAX_TSA_URL_LENGTH = 2048;
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
    knownPfxFiles: [],
    lastDriverPath: null,
    signTemplates: [],
    tsaUrls: [],
    overlayPresets: [],
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

/** The URL trimmed, when it is an absolute http(s) URL with a host; otherwise null (I28). */
export function validTsaUrl(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_TSA_URL_LENGTH || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  return url.toString();
}

/** Keeps valid, unique TSA urls from untrusted disk data, in order (at most MAX_TSA_URLS). */
export function sanitizeTsaUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const url = validTsaUrl(item);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_TSA_URLS) break;
  }
  return out;
}

/** Validates a renderer-provided TSA list strictly (throws on the first bad entry). */
export function validateTsaUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TSA_URLS) {
    throw new SettingsValidationError(`tsaUrls must be an array of at most ${MAX_TSA_URLS}`);
  }
  const out: string[] = [];
  for (const item of value) {
    const url = typeof item === 'string' ? validTsaUrl(item) : null;
    if (!url) throw new SettingsValidationError('Invalid timestamp server URL');
    if (out.includes(url)) throw new SettingsValidationError(`Duplicate timestamp server: ${url}`);
    out.push(url);
  }
  return out;
}

function isAbsoluteDriverPath(v: string): boolean {
  return v.length > 0 && v.length <= 32_768 && !v.includes('\0') && path.isAbsolute(v);
}

const SIGN_TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FINGERPRINT_RE = /^[A-Fa-f0-9]{64}$/;
const LIBRARY_ID_RE = /^[a-f0-9]{32}$/;

/** A sign template entry with a valid shape, or null. The template object is size-limited only. */
function normalizeSignTemplate(v: unknown): SignTemplateEntry | null {
  if (!isPlainObject(v) || typeof v.id !== 'string' || !SIGN_TEMPLATE_ID_RE.test(v.id)) return null;
  if (typeof v.name !== 'string') return null;
  const name = v.name.trim();
  if (name.length === 0 || name.length > MAX_SIGN_TEMPLATE_NAME) return null;
  if (!isPlainObject(v.template)) return null;
  let json: string;
  try {
    json = JSON.stringify(v.template);
  } catch {
    return null;
  }
  if (json.length > MAX_SIGN_TEMPLATE_BYTES) return null;
  const entry: SignTemplateEntry = {
    id: v.id,
    name,
    template: JSON.parse(json) as Record<string, unknown>,
  };
  if (v.certFingerprint !== undefined) {
    if (typeof v.certFingerprint !== 'string' || !FINGERPRINT_RE.test(v.certFingerprint))
      return null;
    entry.certFingerprint = v.certFingerprint.toLowerCase();
  }
  if (v.libraryRefs !== undefined) {
    if (!isPlainObject(v.libraryRefs)) return null;
    const refs: { image?: string; logo?: string } = {};
    for (const slot of ['image', 'logo'] as const) {
      const id = v.libraryRefs[slot];
      if (id === undefined) continue;
      if (typeof id !== 'string' || !LIBRARY_ID_RE.test(id)) return null;
      refs[slot] = id;
    }
    entry.libraryRefs = refs;
  }
  return entry;
}

/** Keeps valid entries from disk: unique ids, at most one template bound to each certificate. */
export function sanitizeSignTemplates(raw: unknown): SignTemplateEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SignTemplateEntry[] = [];
  const ids = new Set<string>();
  const bound = new Set<string>();
  for (const item of raw) {
    const entry = normalizeSignTemplate(item);
    if (!entry || ids.has(entry.id)) continue;
    if (entry.certFingerprint && bound.has(entry.certFingerprint)) {
      delete entry.certFingerprint;
    }
    if (entry.certFingerprint) bound.add(entry.certFingerprint);
    ids.add(entry.id);
    out.push(entry);
    if (out.length >= MAX_SIGN_TEMPLATES) break;
  }
  return out;
}

/** Validates a renderer-provided list strictly (throws on the first bad entry). */
export function validateSignTemplates(value: unknown): SignTemplateEntry[] {
  if (!Array.isArray(value) || value.length > MAX_SIGN_TEMPLATES) {
    throw new SettingsValidationError(
      `signTemplates must be an array of at most ${MAX_SIGN_TEMPLATES}`,
    );
  }
  const ids = new Set<string>();
  const bound = new Set<string>();
  return value.map((item) => {
    const entry = normalizeSignTemplate(item);
    if (!entry) throw new SettingsValidationError('Invalid signature template');
    if (ids.has(entry.id)) throw new SettingsValidationError(`Duplicate template id: ${entry.id}`);
    if (entry.certFingerprint) {
      if (bound.has(entry.certFingerprint)) {
        throw new SettingsValidationError('A certificate can have only one bound template');
      }
      bound.add(entry.certFingerprint);
    }
    ids.add(entry.id);
    return entry;
  });
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

/** Trimmed name + plain look params of an overlay (watermark) preset, or null when malformed. */
function normalizeOverlayPreset(v: unknown): OverlayUserPreset | null {
  if (!isPlainObject(v) || typeof v.name !== 'string' || !isPlainObject(v.params)) return null;
  if (!(OVERLAY_PRESET_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const name = v.name.trim();
  if (name.length === 0 || name.length > MAX_OVERLAY_PRESET_NAME) return null;
  let json: string;
  try {
    json = JSON.stringify(v.params);
  } catch {
    return null;
  }
  if (json.length > MAX_OVERLAY_PRESET_PARAMS_BYTES) return null;
  return {
    name,
    kind: 'watermark',
    params: JSON.parse(json) as Record<string, unknown>,
  };
}

/** Keeps valid, uniquely named overlay presets from untrusted disk data (invalid ones dropped). */
export function sanitizeOverlayPresets(raw: unknown): OverlayUserPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: OverlayUserPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const preset = normalizeOverlayPreset(item);
    if (!preset || seen.has(presetKey(preset.name))) continue;
    seen.add(presetKey(preset.name));
    out.push(preset);
    if (out.length >= MAX_OVERLAY_PRESETS) break;
  }
  return out;
}

/** Validates a renderer-provided list of overlay presets strictly (throws on the first bad entry). */
export function validateOverlayPresets(value: unknown): OverlayUserPreset[] {
  if (!Array.isArray(value) || value.length > MAX_OVERLAY_PRESETS) {
    throw new SettingsValidationError(
      `overlayPresets must be an array of at most ${MAX_OVERLAY_PRESETS}`,
    );
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const preset = normalizeOverlayPreset(item);
    if (!preset) throw new SettingsValidationError('Invalid overlay preset');
    if (seen.has(presetKey(preset.name))) {
      throw new SettingsValidationError(`Duplicate overlay preset name: ${preset.name}`);
    }
    seen.add(presetKey(preset.name));
    return preset;
  });
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

/** Label of a certificate file: the trimmed label, or the file name when it is empty. */
function pfxLabel(label: string, filePath: string): string {
  const trimmed = label.trim();
  if (trimmed.length > 0) return trimmed.slice(0, MAX_PFX_LABEL);
  return path.basename(filePath).slice(0, MAX_PFX_LABEL) || filePath.slice(0, MAX_PFX_LABEL);
}

function normalizeKnownPfx(v: unknown): KnownPfxFile | null {
  if (!isPlainObject(v) || typeof v.path !== 'string' || !path.isAbsolute(v.path)) return null;
  if (v.path.length > 32_768 || v.path.includes('\0')) return null;
  if (v.label !== undefined && typeof v.label !== 'string') return null;
  if (v.remembered !== undefined && typeof v.remembered !== 'boolean') return null;
  const file = path.normalize(v.path);
  return {
    path: file,
    label: pfxLabel(typeof v.label === 'string' ? v.label : '', file),
    remembered: v.remembered === true,
  };
}

/** Keeps valid, unique certificate files from untrusted disk data (invalid entries are dropped). */
export function sanitizeKnownPfx(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): KnownPfxFile[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownPfxFile[] = [];
  for (const item of raw) {
    const entry = normalizeKnownPfx(item);
    if (!entry || out.some((o) => samePath(o.path, entry.path, platform))) continue;
    out.push(entry);
    if (out.length >= MAX_KNOWN_PFX) break;
  }
  return out;
}

/** Validates a renderer-provided list strictly (throws on the first bad entry). */
export function validateKnownPfx(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): KnownPfxFile[] {
  if (!Array.isArray(value) || value.length > MAX_KNOWN_PFX) {
    throw new SettingsValidationError(`knownPfxFiles must be an array of at most ${MAX_KNOWN_PFX}`);
  }
  const out: KnownPfxFile[] = [];
  for (const item of value) {
    const entry = normalizeKnownPfx(item);
    if (!entry) throw new SettingsValidationError('Invalid certificate file entry');
    if (out.some((o) => samePath(o.path, entry.path, platform))) {
      throw new SettingsValidationError(`Duplicate certificate file: ${entry.path}`);
    }
    out.push(entry);
  }
  return out;
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
  s.knownPfxFiles = sanitizeKnownPfx(raw.knownPfxFiles, platform);
  s.signTemplates = sanitizeSignTemplates(raw.signTemplates);
  s.tsaUrls = sanitizeTsaUrls(raw.tsaUrls);
  s.overlayPresets = sanitizeOverlayPresets(raw.overlayPresets);
  if (typeof raw.lastDriverPath === 'string' && isAbsoluteDriverPath(raw.lastDriverPath)) {
    s.lastDriverPath = raw.lastDriverPath;
  }
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
      case 'knownPfxFiles':
        out.knownPfxFiles = validateKnownPfx(value, platform);
        break;
      case 'signTemplates':
        out.signTemplates = validateSignTemplates(value);
        break;
      case 'tsaUrls':
        out.tsaUrls = validateTsaUrls(value);
        break;
      case 'overlayPresets':
        out.overlayPresets = validateOverlayPresets(value);
        break;
      case 'lastDriverPath':
        if (value !== null && !(typeof value === 'string' && isAbsoluteDriverPath(value))) {
          throw new SettingsValidationError('lastDriverPath must be an absolute path or null');
        }
        out.lastDriverPath = value as string | null;
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
