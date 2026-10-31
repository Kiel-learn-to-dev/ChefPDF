/**
 * Timestamp server (TSA) URLs of the settings (I28). The same rule is applied by the main process
 * when it reads or saves settings (apps/desktop/src/main/settings.ts). Pure.
 */

export const MAX_TSA_URLS = 5;
const TSA_URL_MAX = 2048;

/** The URL, trimmed, when it is an absolute http(s) URL; otherwise null. */
export function validTsaUrl(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0 || s.length > TSA_URL_MAX || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.toString();
}

export interface TsaCleanResult {
  urls: string[];
  /** Entries that are not valid http(s) URLs (shown to the user). */
  invalid: string[];
  /** True when the list had more entries than MAX_TSA_URLS (the extra ones are dropped). */
  tooMany: boolean;
}

/** Trims, validates and de-duplicates a list of TSA URLs. Order is kept (first = tried first). */
export function cleanTsaUrls(list: readonly string[]): TsaCleanResult {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of list) {
    if (raw.trim().length === 0) continue;
    const ok = validTsaUrl(raw);
    if (!ok) {
      invalid.push(raw.trim());
      continue;
    }
    if (!urls.includes(ok)) urls.push(ok);
  }
  const tooMany = urls.length > MAX_TSA_URLS;
  return { urls: urls.slice(0, MAX_TSA_URLS), invalid, tooMany };
}
