/**
 * Last-used options of the overlay dialogs, kept in settings.prefs.overlay.<dialog> (free-form
 * prefs of the app). Only plain choices are stored: never a file path, a file list or a password.
 * Stored values are checked against the defaults' shape; anything else falls back. Pure.
 */

export const PREF_KEY = 'overlay';

/** Keys that never go to the preferences: files and folders the user picked. */
const NEVER_STORED = new Set(['path', 'files', 'folder', 'sourcePath']);

/** Removes the file-like keys (recursively) so a form can be stored as preferences. */
export function stripPaths<T>(value: T): T {
  if (Array.isArray(value)) return value as T;
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_STORED.has(k)) continue;
    out[k] = stripPaths(v);
  }
  return out as T;
}

const MAX_TEXT = 5000;

/**
 * `raw` shaped like `defaults`: each field keeps its stored value when the type matches (and the
 * enum, when one is given for the field name); other fields take the default. Arrays are never
 * read back. Only fields of `defaults` survive.
 */
export function sanitizeLike<T>(
  raw: unknown,
  defaults: T,
  enums: Record<string, readonly unknown[]> = {},
): T {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    return defaults;
  }
  const src = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(defaults as Record<string, unknown>)) {
    const v = src[key];
    if (NEVER_STORED.has(key) || Array.isArray(d)) {
      out[key] = d;
    } else if (typeof d === 'object' && d !== null) {
      out[key] = sanitizeLike(v, d, enums);
    } else if (typeof d === 'number') {
      out[key] = typeof v === 'number' && Number.isFinite(v) ? v : d;
    } else if (typeof d === 'boolean') {
      out[key] = typeof v === 'boolean' ? v : d;
    } else if (typeof d === 'string') {
      const allowed = enums[key];
      const ok =
        typeof v === 'string' &&
        v.length <= MAX_TEXT &&
        (allowed === undefined || allowed.includes(v));
      out[key] = ok ? v : d;
    } else {
      out[key] = d;
    }
  }
  return out as T;
}

/** The stored preferences of one dialog, checked against its defaults. */
export function readPrefs<T>(
  prefs: Record<string, unknown>,
  dialog: string,
  defaults: T,
  enums: Record<string, readonly unknown[]> = {},
): T {
  const feature = prefs[PREF_KEY];
  const own =
    typeof feature === 'object' && feature !== null && !Array.isArray(feature)
      ? (feature as Record<string, unknown>)[dialog]
      : undefined;
  return sanitizeLike(own, defaults, enums);
}

/** The prefs object with one dialog's choices replaced (other dialogs and features are kept). */
export function writePrefs<T>(
  prefs: Record<string, unknown>,
  dialog: string,
  value: T,
): Record<string, unknown> {
  const feature = prefs[PREF_KEY];
  const current =
    typeof feature === 'object' && feature !== null && !Array.isArray(feature)
      ? (feature as Record<string, unknown>)
      : {};
  return { ...prefs, [PREF_KEY]: { ...current, [dialog]: stripPaths(value) } };
}
