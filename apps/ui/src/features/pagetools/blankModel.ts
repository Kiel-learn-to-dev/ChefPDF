/**
 * Pure model of "Xóa trang trắng" (C8; T5.09): the detection params, the candidate rows of
 * page.findBlank, the default selection and the plan that deletes the selected pages.
 */
import type { PageDeleteParams, PageFindBlankParams, PageRemoveBlankParams } from '@chef/contracts';

export interface BlankForm {
  /** 0 = only pure blank; 1 = tolerant of specks. */
  sensitivity: number;
  keepIfAnnotations: boolean;
}

export const DEFAULT_BLANK_FORM: BlankForm = { sensitivity: 0.5, keepIfAnnotations: true };

export const BLANK_BORDER_MM = 5;

export function blankParams(form: BlankForm): PageFindBlankParams {
  return {
    sensitivity: form.sensitivity,
    borderMm: BLANK_BORDER_MM,
    keepIfAnnotations: form.keepIfAnnotations,
  };
}

export interface BlankRow {
  index: number;
  inkRatio: number;
  hasText: boolean;
  hasAnnotations: boolean;
  blank: boolean;
}

/** The per-page rows of page.findBlank (malformed rows are dropped). */
export function readBlankRows(data: unknown): BlankRow[] {
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.pages)) return [];
  return d.pages.filter(isRow);
}

function isRow(v: unknown): v is BlankRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.index === 'number' &&
    typeof r.inkRatio === 'number' &&
    typeof r.hasText === 'boolean' &&
    typeof r.hasAnnotations === 'boolean' &&
    typeof r.blank === 'boolean'
  );
}

/** The candidates the review starts with: the pages flagged blank. */
export function defaultBlankSelection(rows: readonly BlankRow[]): number[] {
  return rows.filter((r) => r.blank).map((r) => r.index);
}

export type RemovalPlan =
  | { opId: 'page.removeBlank'; params: PageRemoveBlankParams }
  | { opId: 'page.delete'; params: PageDeleteParams };

/**
 * What to run for the selected pages: page.removeBlank when the selection is exactly the
 * candidates (same detection), otherwise page.delete. Null when nothing can be deleted.
 */
export function removalPlan(
  rows: readonly BlankRow[],
  selected: readonly number[],
  pageCount: number,
  params: PageFindBlankParams,
): RemovalPlan | null {
  const pages = [...new Set(selected)].sort((a, b) => a - b);
  if (pages.length === 0 || pages.length >= pageCount) return null;
  const candidates = defaultBlankSelection(rows);
  const same = candidates.length === pages.length && candidates.every((c, i) => c === pages[i]);
  if (same) return { opId: 'page.removeBlank', params };
  return { opId: 'page.delete', params: { pages } };
}
