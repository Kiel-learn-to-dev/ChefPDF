/**
 * Signing preferences kept in settings.prefs.sign (free-form prefs of the app). Only plain choices
 * are stored: never a password, a PIN or a file path of a token. Pure.
 */
import { MAX_RECENT_ANCHORS, anchorKey } from './anchorModel';
import type { CertifyMode, DigestName, SignLevel } from './signRequest';

export const PREF_KEY = 'sign';

export interface SignPrefs {
  /** Last size of a drawn box, in mm. */
  boxMm: { w: number; h: number };
  level: SignLevel;
  digest: DigestName;
  certify: CertifyMode;
  /** Recent anchor texts, most recent first. */
  anchors: string[];
}

export const DEFAULT_SIGN_PREFS: SignPrefs = {
  boxMm: { w: 50, h: 20 },
  level: 'B-B',
  digest: 'sha256',
  certify: 'none',
  anchors: [],
};

const LEVELS: readonly SignLevel[] = ['B-B', 'B-T', 'B-LT', 'B-LTA'];
const DIGESTS: readonly DigestName[] = ['sha256', 'sha384', 'sha512'];
const CERTIFY: readonly CertifyMode[] = ['none', 'no-changes', 'form-fill', 'annotate'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The sign preferences from the free-form prefs object; bad values fall back to the defaults. */
export function readSignPrefs(prefs: Record<string, unknown>): SignPrefs {
  const raw = prefs[PREF_KEY];
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const box = (typeof r.boxMm === 'object' && r.boxMm !== null ? r.boxMm : {}) as Record<
    string,
    unknown
  >;
  const w = isNum(box.w) && box.w >= 2 && box.w <= 300 ? box.w : DEFAULT_SIGN_PREFS.boxMm.w;
  const h = isNum(box.h) && box.h >= 2 && box.h <= 300 ? box.h : DEFAULT_SIGN_PREFS.boxMm.h;
  // Stored most recent first: keep that order, drop texts that repeat an earlier one.
  const anchors: string[] = [];
  if (Array.isArray(r.anchors)) {
    const seen = new Set<string>();
    for (const a of r.anchors) {
      if (typeof a !== 'string' || a.trim() === '') continue;
      const key = anchorKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push(a.trim());
    }
  }
  return {
    boxMm: { w, h },
    level: LEVELS.includes(r.level as SignLevel)
      ? (r.level as SignLevel)
      : DEFAULT_SIGN_PREFS.level,
    digest: DIGESTS.includes(r.digest as DigestName)
      ? (r.digest as DigestName)
      : DEFAULT_SIGN_PREFS.digest,
    certify: CERTIFY.includes(r.certify as CertifyMode)
      ? (r.certify as CertifyMode)
      : DEFAULT_SIGN_PREFS.certify,
    anchors: anchors.slice(0, MAX_RECENT_ANCHORS),
  };
}

/** Prefs with a patch merged in (the rest of the prefs object is kept as it is). */
export function writeSignPrefs(
  prefs: Record<string, unknown>,
  patch: Partial<SignPrefs>,
): Record<string, unknown> {
  const current = readSignPrefs(prefs);
  return { ...prefs, [PREF_KEY]: { ...current, ...patch } };
}
