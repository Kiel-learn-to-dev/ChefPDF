/**
 * Pure helpers of the "Chuyển thành bản scan" dialog (K1-K10): form state <-> scan.rasterize
 * params, presets, name checks and warning mapping. No React, no RPC.
 */
import type { ScanRasterizeParams, ScanUserPreset } from '@chef/contracts';
import { formatPageRanges, parsePageRanges } from '../../lib/pageRange';

export type ScanColor = 'color' | 'gray' | 'bw';
export type ScanEffectsPreset = 'none' | 'light' | 'photocopy' | 'old-paper';

/** Form state of the dialog. `pagesText` is 1-based ("1-3,5"); '' means all pages. */
export interface ScanForm {
  dpi: number;
  color: ScanColor;
  jpegQuality: number;
  threshold: number;
  dithering: boolean;
  pagesText: string;
  stripMetadata: boolean;
  effectsPreset: ScanEffectsPreset;
  seed: number;
}

export const DEFAULT_SCAN_FORM: ScanForm = {
  dpi: 200,
  color: 'gray',
  jpegQuality: 75,
  threshold: 128,
  dithering: false,
  pagesText: '',
  stripMetadata: true,
  effectsPreset: 'none',
  seed: 0,
};

export const DPI_CHOICES = [150, 200, 300, 600] as const;
export const DPI_MIN = 72;
export const DPI_MAX = 1200;
export const MAX_PRESET_NAME = 60;

const COLORS: readonly ScanColor[] = ['color', 'gray', 'bw'];
const EFFECTS: readonly ScanEffectsPreset[] = ['none', 'light', 'photocopy', 'old-paper'];

export type FormField = 'dpi' | 'jpegQuality' | 'threshold' | 'seed' | 'pages';

const isInt = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** Fields whose value cannot be sent to the core. */
export function formIssues(form: ScanForm, pageCount: number): FormField[] {
  const issues: FormField[] = [];
  if (!isInt(form.dpi, DPI_MIN, DPI_MAX)) issues.push('dpi');
  if (!isInt(form.jpegQuality, 1, 100)) issues.push('jpegQuality');
  if (!isInt(form.threshold, 0, 255)) issues.push('threshold');
  if (!Number.isInteger(form.seed) || form.seed < 0) issues.push('seed');
  if (form.pagesText.trim() !== '' && !parsePageRanges(form.pagesText, pageCount).ok) {
    issues.push('pages');
  }
  return issues;
}

/** Wire params for scan.rasterize (and scan.preview / scan.fitSize), or null when the form is invalid. */
export function buildParams(form: ScanForm, pageCount: number): ScanRasterizeParams | null {
  if (formIssues(form, pageCount).length > 0) return null;
  const params: ScanRasterizeParams = {
    dpi: form.dpi,
    color: form.color,
    jpegQuality: form.jpegQuality,
    threshold: form.threshold,
    dithering: form.dithering,
    stripMetadata: form.stripMetadata,
    effectsPreset: form.effectsPreset,
    seed: form.seed,
  };
  if (form.pagesText.trim() !== '') {
    const parsed = parsePageRanges(form.pagesText, pageCount);
    if (parsed.ok) params.pages = [...parsed.pages].sort((a, b) => a - b);
  }
  return params;
}

/**
 * Applies wire params on top of `base`. Keys that are absent keep the base value;
 * `pages: null` means all pages (the core's own encoding of "all").
 */
export function applyParams(
  base: ScanForm,
  params: Partial<Record<keyof ScanRasterizeParams, unknown>> | null | undefined,
): ScanForm {
  const next: ScanForm = { ...base };
  if (!params) return next;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const dpi = num(params.dpi);
  if (dpi !== undefined) next.dpi = dpi;
  if (COLORS.includes(params.color as ScanColor)) next.color = params.color as ScanColor;
  const jpeg = num(params.jpegQuality);
  if (jpeg !== undefined) next.jpegQuality = jpeg;
  const threshold = num(params.threshold);
  if (threshold !== undefined) next.threshold = threshold;
  if (typeof params.dithering === 'boolean') next.dithering = params.dithering;
  if (typeof params.stripMetadata === 'boolean') next.stripMetadata = params.stripMetadata;
  if ('effectsPreset' in params) {
    next.effectsPreset =
      params.effectsPreset === null
        ? 'none'
        : EFFECTS.includes(params.effectsPreset as ScanEffectsPreset)
          ? (params.effectsPreset as ScanEffectsPreset)
          : base.effectsPreset;
  }
  const seed = num(params.seed);
  if (seed !== undefined) next.seed = seed;
  if ('pages' in params) {
    next.pagesText = Array.isArray(params.pages)
      ? formatPageRanges(params.pages.filter((p): p is number => typeof p === 'number'))
      : '';
  }
  return next;
}

/** The options a user preset stores: the wire params without the page choice (pages belong to the document). */
export function presetParamsOf(form: ScanForm, pageCount: number): Record<string, unknown> | null {
  const params = buildParams({ ...form, pagesText: '' }, pageCount);
  if (!params) return null;
  delete params.pages;
  return { ...params };
}

/** Built-in preset as returned by the scan.presets RPC. */
export interface BuiltinPreset {
  name: string;
  labelVi: string;
  labelEn: string;
  params: Record<string, unknown>;
}

export interface PresetOption {
  /** `builtin:<name>` or `user:<name>`; the Select value. */
  key: string;
  label: string;
  source: 'builtin' | 'user';
  name: string;
  params: Record<string, unknown>;
}

/** Built-in presets first, then user presets. Labels follow the UI language. */
export function mergePresetOptions(
  builtins: BuiltinPreset[],
  user: ScanUserPreset[],
  language: string,
): PresetOption[] {
  const fromBuiltins = builtins.map<PresetOption>((p) => ({
    key: `builtin:${p.name}`,
    label: language === 'en' ? p.labelEn : p.labelVi,
    source: 'builtin',
    name: p.name,
    params: p.params,
  }));
  const fromUser = user.map<PresetOption>((p) => ({
    key: `user:${p.name}`,
    label: p.name,
    source: 'user',
    name: p.name,
    params: p.params,
  }));
  return [...fromBuiltins, ...fromUser];
}

export type PresetNameIssue = 'empty' | 'tooLong' | 'duplicate';

/**
 * Trimmed, non-empty, at most MAX_PRESET_NAME characters and unique (case-insensitive)
 * among `taken` (built-in labels and names plus existing user presets).
 */
export function validatePresetName(
  raw: string,
  taken: string[],
): { ok: true; name: string } | { ok: false; issue: PresetNameIssue } {
  const name = raw.trim();
  if (name === '') return { ok: false, issue: 'empty' };
  if (name.length > MAX_PRESET_NAME) return { ok: false, issue: 'tooLong' };
  const lower = name.toLowerCase();
  if (taken.some((t) => t.trim().toLowerCase() === lower)) {
    return { ok: false, issue: 'duplicate' };
  }
  return { ok: true, name };
}

/** Maps the core's dpi limit error to the largest allowed dpi, or null when the error is something else. */
export function dpiLimitFromError(kind: string, detail: unknown): number | null {
  if (kind !== 'INVALID_PARAMS' || typeof detail !== 'object' || detail === null) return null;
  const d = detail as { field?: unknown; maxDpi?: unknown };
  if (d.field !== 'dpi' || typeof d.maxDpi !== 'number') return null;
  return d.maxDpi >= DPI_MIN ? Math.floor(d.maxDpi) : null;
}

/** Translation key for a loss warning written by the core (English text), or null. */
const WARNING_KEYS: Record<string, string> = {
  'Text will be lost: converted pages become images without text.': 'scan.warn.text',
  'Links will be lost.': 'scan.warn.links',
  'Bookmarks will be lost.': 'scan.warn.bookmarks',
  'Form fields will be lost.': 'scan.warn.forms',
  'Digital signatures will be lost.': 'scan.warn.signatures',
};

export function localizeWarning(message: string): string | null {
  return WARNING_KEYS[message] ?? null;
}

/** Seconds below a minute, minutes otherwise (for "~ 42 giây" / "~ 3 phút"). */
export function durationParts(seconds: number): { unit: 'seconds' | 'minutes'; value: number } {
  if (seconds < 60) return { unit: 'seconds', value: Math.max(1, Math.round(seconds)) };
  return { unit: 'minutes', value: Math.round(seconds / 60) };
}

/** A target size typed in MB, as bytes; null when it is not a positive number. */
export function parseMegabytes(text: string): number | null {
  const mb = Number(text.replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(mb) || mb <= 0) return null;
  return Math.round(mb * 1024 * 1024);
}

/** Result shapes of the session ops used for preview and fit (contracts: ScanPreviewParams / ScanFitSizeParams). */
export interface ScanSample {
  pageIndex: number;
  originalPath: string;
  resultPath: string;
  widthPx: number;
  heightPx: number;
  encodedBytes: number;
}

export interface ScanPreviewData {
  samples: ScanSample[];
  estimate: { estimatedBytes: number; estimatedSeconds: number; lossWarnings: string[] };
}

export interface ScanFitData {
  params: ScanRasterizeParams;
  estimatedBytes: number;
  reachable: boolean;
  steps: number;
}
