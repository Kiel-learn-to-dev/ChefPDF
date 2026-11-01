/**
 * Pure model of "Kiểm tra trước khi gửi" (J5; T5.03): reads the checklist of preflight.check,
 * maps each item's fixOp to what the UI does (run an op, open a dialog, or only show a hint).
 */
import type { OpId } from '../../lib/ops';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface FixOp {
  op: string;
  params?: Record<string, unknown>;
}

export interface CheckItem {
  id: string;
  status: CheckStatus;
  titleVi: string;
  titleEn: string;
  detail: Record<string, unknown>;
  fixOp: FixOp | null;
}

const STATUSES: readonly CheckStatus[] = ['ok', 'warn', 'fail'];

/** Validates the list returned by preflight.check. Malformed rows are dropped. */
export function readChecklist(data: unknown): CheckItem[] {
  if (!Array.isArray(data)) return [];
  const out: CheckItem[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !STATUSES.includes(r.status as CheckStatus)) continue;
    const fix = r.fixOp as Record<string, unknown> | null | undefined;
    out.push({
      id: r.id,
      status: r.status as CheckStatus,
      titleVi: typeof r.titleVi === 'string' ? r.titleVi : r.id,
      titleEn: typeof r.titleEn === 'string' ? r.titleEn : r.id,
      detail:
        r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)
          ? (r.detail as Record<string, unknown>)
          : {},
      fixOp:
        fix && typeof fix.op === 'string'
          ? {
              op: fix.op,
              params:
                fix.params && typeof fix.params === 'object'
                  ? (fix.params as Record<string, unknown>)
                  : {},
            }
          : null,
    });
  }
  return out;
}

/** Size limit choices of the checklist, in MB (0 = no limit). */
export const SIZE_LIMITS_MB = [0, 5, 10, 25] as const;

/** Bytes for preflight.check maxBytes; undefined when there is no limit. */
export function maxBytesOf(mb: number): number | undefined {
  return mb > 0 ? mb * 1024 * 1024 : undefined;
}

/** Items that need attention, failures first. */
export function attentionItems(items: CheckItem[]): CheckItem[] {
  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2 };
  return [...items].sort((a, b) => rank[a.status] - rank[b.status]);
}

export function countByStatus(items: CheckItem[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const i of items) out[i.status]++;
  return out;
}

/**
 * Ops the UI can run directly from the checklist with the given params. Typed against OpId so a
 * renamed op breaks the build instead of silently doing nothing.
 */
const RUNNABLE = {
  'inspect.removeHidden': true,
  'security.decrypt': true,
  'page.delete': true,
} as const satisfies Partial<Record<OpId, true>>;

/** Dialog that handles the fix of an op the checklist cannot run directly. */
const DIALOG_FOR_OP: Readonly<Record<string, string>> = {
  'security.decrypt': 'security',
  'security.encrypt': 'security',
  'inspect.removeHidden': 'inspect',
  'inspect.hiddenData': 'inspect',
  'compress.pdf': 'compress',
  'compress.fitSize': 'compress',
  'compress.estimate': 'compress',
};

export type FixAction =
  | { kind: 'none' }
  | {
      kind: 'run';
      opId: 'inspect.removeHidden' | 'security.decrypt' | 'page.delete';
      params: unknown;
    }
  | { kind: 'dialog'; dialog: string }
  | { kind: 'hint' };

/** Sanitizes the page indices of page.delete (0-based, unique, integers). */
function pageList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const pages = [...new Set(v)].filter((n): n is number => Number.isInteger(n) && n >= 0);
  return pages.length > 0 ? pages : null;
}

/** Decides what a fix button does. Pure: the caller runs the op or opens the dialog. */
export function fixActionOf(item: CheckItem): FixAction {
  const fix = item.fixOp;
  if (!fix) return { kind: 'none' };
  if (fix.op === 'inspect.removeHidden') {
    const cats = Array.isArray(fix.params?.categories)
      ? fix.params!.categories.filter((c): c is string => typeof c === 'string')
      : [];
    if (cats.length > 0) {
      return { kind: 'run', opId: 'inspect.removeHidden', params: { categories: cats } };
    }
  }
  if (fix.op === 'security.decrypt') {
    return { kind: 'run', opId: 'security.decrypt', params: {} };
  }
  if (fix.op === 'page.delete') {
    const pages = pageList(fix.params?.pages);
    if (pages) return { kind: 'run', opId: 'page.delete', params: { pages } };
  }
  const dialog = DIALOG_FOR_OP[fix.op];
  if (dialog) return { kind: 'dialog', dialog };
  return { kind: 'hint' };
}

/** True when the fix op is one the checklist runs directly (for tests and the UI). */
export function isRunnableFix(op: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUNNABLE, op);
}
