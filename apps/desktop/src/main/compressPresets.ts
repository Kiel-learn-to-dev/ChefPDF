/**
 * User presets of "Nén PDF" (M1). Stored in settings.compressPresets. A preset is a name and the
 * plain option values of the compression form (no paths, no page lists). Validation is strict
 * when the renderer saves, lenient when the file is read from disk (bad entries are dropped).
 */
import type { CompressUserPreset } from '@chef/contracts';
import { isPlainObject } from './fsutil';

export const MAX_COMPRESS_PRESETS = 50;
export const MAX_COMPRESS_PRESET_NAME = 60;
export const MAX_COMPRESS_PRESET_PARAMS_BYTES = 4096;

const PRESET_NAMES = ['screen', 'ebook', 'print', 'archive-light', 'custom'] as const;
const BOOLEAN_KEYS = [
  'grayscale',
  'removeUnused',
  'removeMetadata',
  'removeThumbnails',
  'removeAttachments',
  'subsetFonts',
  'flattenTransparency',
] as const;

/** Normalized preset, or null when malformed. Unknown keys are dropped; values are type-checked. */
function normalize(v: unknown): CompressUserPreset | null {
  if (!isPlainObject(v) || typeof v.name !== 'string' || !isPlainObject(v.params)) return null;
  const name = v.name.trim();
  if (name.length === 0 || name.length > MAX_COMPRESS_PRESET_NAME) return null;
  const src = v.params;
  const params: Record<string, unknown> = {};
  if (src.preset !== undefined) {
    if (!(PRESET_NAMES as readonly unknown[]).includes(src.preset)) return null;
    params.preset = src.preset;
  }
  for (const key of ['maxImageDpi', 'jpegQuality'] as const) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    const [min, max] = key === 'maxImageDpi' ? [36, 1200] : [1, 100];
    if (value < min || value > max) return null;
    params[key] = value;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = src[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return null;
    params[key] = value;
  }
  let json: string;
  try {
    json = JSON.stringify(params);
  } catch {
    return null;
  }
  if (json.length > MAX_COMPRESS_PRESET_PARAMS_BYTES) return null;
  return { name, params };
}

const keyOf = (name: string) => name.toLowerCase();

/** Keeps valid, uniquely named presets from untrusted disk data (invalid entries are dropped). */
export function sanitizeCompressPresets(raw: unknown): CompressUserPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: CompressUserPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const preset = normalize(item);
    if (!preset || seen.has(keyOf(preset.name))) continue;
    seen.add(keyOf(preset.name));
    out.push(preset);
    if (out.length >= MAX_COMPRESS_PRESETS) break;
  }
  return out;
}

/** Validates a renderer-provided list strictly. Throws the message of the first bad entry. */
export function validateCompressPresets(value: unknown): CompressUserPreset[] {
  if (!Array.isArray(value) || value.length > MAX_COMPRESS_PRESETS) {
    throw new Error(`compressPresets must be an array of at most ${MAX_COMPRESS_PRESETS}`);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const preset = normalize(item);
    if (!preset) throw new Error('Invalid compress preset');
    if (seen.has(keyOf(preset.name))) {
      throw new Error(`Duplicate compress preset name: ${preset.name}`);
    }
    seen.add(keyOf(preset.name));
    return preset;
  });
}
