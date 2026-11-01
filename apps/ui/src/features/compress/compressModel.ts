/**
 * Pure model of "Nén PDF" (M1; T5.04): the form, presets (built-in and user), the params sent to
 * compress.pdf / estimate / fitSize, and the report of the result.
 */
import type { CompressPdfParams } from '@chef/contracts';

export type BuiltinPreset = 'screen' | 'ebook' | 'print' | 'archive-light';
export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  'screen',
  'ebook',
  'print',
  'archive-light',
];
export type PresetChoice = BuiltinPreset | 'custom';

/**
 * Image settings of each built-in preset, mirrored from PRESETS in core/chef_core/ops/compress.py.
 * `null` means the core keeps the images as they are (no resampling).
 */
export const PRESET_VALUES: Record<
  BuiltinPreset,
  { maxImageDpi: number | null; jpegQuality: number | null; removeThumbnails: boolean }
> = {
  screen: { maxImageDpi: 96, jpegQuality: 55, removeThumbnails: true },
  ebook: { maxImageDpi: 150, jpegQuality: 70, removeThumbnails: true },
  print: { maxImageDpi: 300, jpegQuality: 85, removeThumbnails: false },
  'archive-light': { maxImageDpi: null, jpegQuality: null, removeThumbnails: false },
};

export const DPI_MIN = 36;
export const DPI_MAX = 1200;
export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;
export const MAX_PRESET_NAME = 60;
export const MAX_USER_PRESETS = 50;
export const MAX_PRESET_PARAMS_BYTES = 4096;

export interface CompressForm {
  preset: PresetChoice;
  maxImageDpi: number | null;
  jpegQuality: number | null;
  grayscale: boolean;
  removeUnused: boolean;
  removeMetadata: boolean;
  removeThumbnails: boolean;
  removeAttachments: boolean;
  subsetFonts: boolean;
  flattenTransparency: boolean;
}

export const DEFAULT_COMPRESS_FORM: CompressForm = {
  preset: 'ebook',
  ...presetFieldsOf('ebook'),
  grayscale: false,
  removeUnused: true,
  removeMetadata: false,
  removeAttachments: false,
  subsetFonts: true,
  flattenTransparency: false,
};

function presetFieldsOf(p: BuiltinPreset) {
  const v = PRESET_VALUES[p];
  return {
    maxImageDpi: v.maxImageDpi,
    jpegQuality: v.jpegQuality,
    removeThumbnails: v.removeThumbnails,
  };
}

/** The form after choosing a preset: image settings from the preset, flags kept. */
export function applyPreset(form: CompressForm, preset: PresetChoice): CompressForm {
  if (preset === 'custom') return { ...form, preset };
  return { ...form, preset, ...presetFieldsOf(preset) };
}

export type FormIssue = 'dpi' | 'quality';

export function formIssues(form: CompressForm): FormIssue[] {
  const out: FormIssue[] = [];
  if (form.maxImageDpi !== null && !isIntIn(form.maxImageDpi, DPI_MIN, DPI_MAX)) out.push('dpi');
  if (form.jpegQuality !== null && !isIntIn(form.jpegQuality, QUALITY_MIN, QUALITY_MAX)) {
    out.push('quality');
  }
  return out;
}

function isIntIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/** Params of compress.pdf / compress.estimate. Empty image settings are left out (preset). */
export function compressParams(form: CompressForm): CompressPdfParams {
  const out: CompressPdfParams = {
    preset: form.preset,
    grayscale: form.grayscale,
    removeUnused: form.removeUnused,
    removeMetadata: form.removeMetadata,
    removeThumbnails: form.removeThumbnails,
    removeAttachments: form.removeAttachments,
    subsetFonts: form.subsetFonts,
    flattenTransparency: form.flattenTransparency,
  };
  if (form.maxImageDpi !== null) out.maxImageDpi = form.maxImageDpi;
  if (form.jpegQuality !== null) out.jpegQuality = form.jpegQuality;
  return out;
}

/** Reads a form from params (a user preset, or the params returned by compress.fitSize). */
export function formFromParams(raw: unknown): CompressForm {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const preset: PresetChoice = BUILTIN_PRESETS.includes(r.preset as BuiltinPreset)
    ? (r.preset as BuiltinPreset)
    : 'custom';
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const num = (v: unknown, min: number, max: number): number | null =>
    typeof v === 'number' && isIntIn(v, min, max) ? v : null;
  const base =
    preset === 'custom' ? DEFAULT_COMPRESS_FORM : applyPreset(DEFAULT_COMPRESS_FORM, preset);
  return {
    preset,
    maxImageDpi:
      num(r.maxImageDpi, DPI_MIN, DPI_MAX) ?? (preset === 'custom' ? null : base.maxImageDpi),
    jpegQuality:
      num(r.jpegQuality, QUALITY_MIN, QUALITY_MAX) ??
      (preset === 'custom' ? null : base.jpegQuality),
    grayscale: bool(r.grayscale, false),
    removeUnused: bool(r.removeUnused, true),
    removeMetadata: bool(r.removeMetadata, false),
    removeThumbnails: bool(r.removeThumbnails, base.removeThumbnails),
    removeAttachments: bool(r.removeAttachments, false),
    subsetFonts: bool(r.subsetFonts, true),
    flattenTransparency: bool(r.flattenTransparency, false),
  };
}

export type NameIssue = 'empty' | 'tooLong' | 'duplicate';

export function validatePresetName(name: string, taken: readonly string[]): NameIssue | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > MAX_PRESET_NAME) return 'tooLong';
  if (taken.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return 'duplicate';
  return null;
}

export interface CompressUserPreset {
  name: string;
  params: Record<string, unknown>;
}

/** Keeps the well-formed user presets (from settings or an import). Invalid ones are dropped. */
export function readUserPresets(raw: unknown): CompressUserPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: CompressUserPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.params || typeof r.params !== 'object') continue;
    const name = r.name.trim();
    if (!name || name.length > MAX_PRESET_NAME || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, params: r.params as Record<string, unknown> });
    if (out.length >= MAX_USER_PRESETS) break;
  }
  return out;
}

/** Target size in bytes for compress.fitSize (the user types MB); null when not a valid size. */
export function targetBytesOf(mb: number): number | null {
  if (!Number.isFinite(mb) || mb <= 0 || mb > 10_000) return null;
  return Math.round(mb * 1024 * 1024);
}

export interface CompressReport {
  bytesBefore: number;
  bytesAfter: number;
  /** Share of the original size kept (0..1+). */
  ratio: number;
  imagesProcessed: number;
  imagesSkipped: number;
  skipped: { reason: string; count: number }[];
  warnings: string[];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function readCompressReport(data: unknown): CompressReport {
  const d = (data ?? {}) as Record<string, unknown>;
  const reasons =
    d.skippedReasons && typeof d.skippedReasons === 'object'
      ? Object.entries(d.skippedReasons as Record<string, unknown>)
          .filter(([, n]) => typeof n === 'number' && n > 0)
          .map(([reason, count]) => ({ reason, count: count as number }))
      : [];
  return {
    bytesBefore: num(d.bytesBefore),
    bytesAfter: num(d.bytesAfter),
    ratio: num(d.ratio) || 1,
    imagesProcessed: num(d.imagesProcessed),
    imagesSkipped: num(d.imagesSkipped),
    skipped: reasons,
    warnings: Array.isArray(d.warnings)
      ? d.warnings.filter((w): w is string => typeof w === 'string')
      : [],
  };
}

/** Percent saved (0 when the result is not smaller). */
export function percentSaved(before: number, after: number): number {
  if (before <= 0 || after >= before) return 0;
  return Math.round((1 - after / before) * 100);
}

export interface FitResult {
  form: CompressForm;
  estimatedBytes: number;
  reachable: boolean;
}

/** Reads the result of compress.fitSize: the params to apply and whether the target is reachable. */
export function readFitResult(data: unknown): FitResult | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (!d.params || typeof d.params !== 'object') return null;
  return {
    form: { ...formFromParams(d.params), preset: 'custom' },
    estimatedBytes: num(d.estimatedBytes),
    reachable: d.reachable === true,
  };
}
