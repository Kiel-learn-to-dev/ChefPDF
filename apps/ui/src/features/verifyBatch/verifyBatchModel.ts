/**
 * "Kiểm tra chữ ký hàng loạt" (I36): the form, its checks, the core params (sign.verifyBatch) and
 * the summary by status. Pure.
 */
import type { SignVerifyBatchParams } from '@chef/contracts';

export type VerifyScope = 'files' | 'folder';
export type Revocation = 'none' | 'soft' | 'hard';
export type ReportFormat = 'csv' | 'xlsx';

export const REPORT_FORMATS: readonly ReportFormat[] = ['csv', 'xlsx'];
export const DEFAULT_REPORT_NAME = 'kiem-tra-chu-ky';
export const TRUST_ROOT_FILTERS = ['pem', 'cer', 'crt', 'der'];

export interface VerifyForm {
  scope: VerifyScope;
  files: string[];
  folder: string | null;
  recursive: boolean;
  revocation: Revocation;
  /** Extra trust roots (certificate files or folders). The bundled and user stores always apply. */
  trustRoots: string[];
  format: ReportFormat;
  reportPath: string | null;
}

export const DEFAULT_VERIFY_FORM: VerifyForm = {
  scope: 'files',
  files: [],
  folder: null,
  recursive: false,
  revocation: 'soft',
  trustRoots: [],
  format: 'csv',
  reportPath: null,
};

export type VerifyProblem = 'noInput' | 'noReport' | 'extension';

/** The first problem with the form, or null when the batch can start. */
export function verifyProblem(f: VerifyForm): VerifyProblem | null {
  const hasInput = f.scope === 'files' ? f.files.length > 0 : f.folder !== null;
  if (!hasInput) return 'noInput';
  if (!f.reportPath || f.reportPath.trim().length === 0) return 'noReport';
  if (!f.reportPath.toLowerCase().endsWith(`.${f.format}`)) return 'extension';
  return null;
}

/** Core params: exactly one source (files or folder), the trust roots only when given. */
export function verifyBatchParams(f: VerifyForm): SignVerifyBatchParams {
  const source =
    f.scope === 'files'
      ? { files: f.files.map((path) => ({ path })) }
      : { folder: f.folder ?? '', recursive: f.recursive };
  return {
    ...source,
    checkRevocation: f.revocation,
    ...(f.trustRoots.length > 0 ? { trustRootPaths: [...f.trustRoots] } : {}),
    reportPath: f.reportPath ?? '',
    format: f.format,
  };
}

/** Changing the format swaps the report's extension, keeping its name. */
export function withFormat(path: string | null, format: ReportFormat): string | null {
  if (!path) return null;
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const stem = dot > slash ? path.slice(0, dot) : path;
  return `${stem}.${format}`;
}

/** Joins a folder and the default report name; the format decides the extension. */
export function defaultReportPath(dir: string, format: ReportFormat): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const base = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
  return `${base}${sep}${DEFAULT_REPORT_NAME}.${format}`;
}

/** Order of the statuses in the summary (the core's status names). */
export const STATUS_ORDER = [
  'valid',
  'valid-with-warnings',
  'invalid',
  'unknown',
  'unsigned',
  'error',
] as const;

export interface StatusCount {
  status: string;
  count: number;
}

/** Counts by status in the summary order; unknown statuses last; zero counts are left out. */
export function countsByStatus(byStatus: Record<string, number>): StatusCount[] {
  const known = STATUS_ORDER.filter((s) => (byStatus[s] ?? 0) > 0);
  const extra = Object.keys(byStatus)
    .filter((s) => !(STATUS_ORDER as readonly string[]).includes(s) && (byStatus[s] ?? 0) > 0)
    .sort();
  return [...known, ...extra].map((status) => ({ status, count: byStatus[status] ?? 0 }));
}

export interface VerifyResult {
  files: number;
  signatures: number;
  byStatus: Record<string, number>;
  reportPath: string;
}

/** Reads the core's sign.verifyBatch data. Null when the shape is not the expected one. */
export function parseVerifyResult(data: unknown): VerifyResult | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<VerifyResult>;
  if (typeof d.files !== 'number' || typeof d.reportPath !== 'string') return null;
  const byStatus: Record<string, number> = {};
  for (const [k, v] of Object.entries(d.byStatus ?? {})) {
    if (typeof v === 'number') byStatus[k] = v;
  }
  return {
    files: d.files,
    signatures: typeof d.signatures === 'number' ? d.signatures : 0,
    byStatus,
    reportPath: d.reportPath,
  };
}
