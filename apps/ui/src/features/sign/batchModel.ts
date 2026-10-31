/**
 * Batch signing (T3.13): the file list, the output rules and the result table. Pure.
 * Result items are the core's sign.batch `data.results` entries (FileOutcome.to_wire).
 */
export const MAX_BATCH_FILES = 200;
export const DEFAULT_SUFFIX = '_da-ky';

export interface BatchRow {
  path: string;
  name: string;
  /** Password of an encrypted file: kept in memory for this batch only. */
  password?: string;
}

export interface AddResult {
  rows: BatchRow[];
  added: number;
  duplicates: number;
  overLimit: boolean;
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Appends paths that are not in the list yet, up to MAX_BATCH_FILES. */
export function addBatchPaths(rows: readonly BatchRow[], paths: readonly string[]): AddResult {
  const out = [...rows];
  let added = 0;
  let duplicates = 0;
  let overLimit = false;
  for (const path of paths) {
    if (out.some((r) => samePath(r.path, path))) {
      duplicates++;
      continue;
    }
    if (out.length >= MAX_BATCH_FILES) {
      overLimit = true;
      break;
    }
    out.push({ path, name: fileName(path) });
    added++;
  }
  return { rows: out, added, duplicates, overLimit };
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export type SuffixProblem = 'empty' | 'separator' | 'invalidChars' | 'long';

/** The problem with an output suffix, or null. The suffix is appended to the file name. */
export function suffixProblem(suffix: string): SuffixProblem | null {
  if (suffix.trim().length === 0) return 'empty';
  if (/[\\/]/.test(suffix)) return 'separator';
  if (/[<>:"|?*]/.test(suffix) || [...suffix].some((c) => c.charCodeAt(0) < 32)) {
    return 'invalidChars';
  }
  if (suffix.length > 40) return 'long';
  return null;
}

export interface BatchItem {
  path: string;
  outputPath: string | null;
  status: 'signed' | 'failed' | 'skipped';
  errorKind: string | null;
  message: string | null;
  fieldName: string | null;
  page: number | null;
  verification: { status: string; reasons: string[] } | null;
  warnings: string[];
}

export interface BatchSummary {
  total: number;
  signed: number;
  failed: number;
  skipped: number;
}

export function summarize(items: readonly BatchItem[]): BatchSummary {
  return {
    total: items.length,
    signed: items.filter((i) => i.status === 'signed').length,
    failed: items.filter((i) => i.status === 'failed').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
  };
}

/** Input paths of the items that failed or were skipped: the set the user can retry. */
export function retryPaths(items: readonly BatchItem[]): string[] {
  return items.filter((i) => i.status !== 'signed').map((i) => i.path);
}

/** The i18n key of a result's error: its error kind, or a generic one when unknown. */
export function batchErrorKey(kind: string | null): string {
  return kind ? `errors.${kind}` : 'signBatch.errUnknown';
}

/** Verification badge of a signed output. */
export function verificationTone(v: BatchItem['verification']): 'ok' | 'warn' | 'bad' | 'none' {
  if (!v) return 'none';
  if (v.status === 'valid') return 'ok';
  if (v.status === 'valid-with-warnings' || v.status === 'unknown') return 'warn';
  if (v.status === 'invalid') return 'bad';
  return 'none';
}

/** Output file names for the suffix rule: "<name><suffix>.pdf" next to the input. */
export function suffixOutputName(inputPath: string, suffix: string): string {
  const name = fileName(inputPath);
  const dot = name.toLowerCase().endsWith('.pdf') ? name.length - 4 : name.length;
  return `${name.slice(0, dot)}${suffix}.pdf`;
}
