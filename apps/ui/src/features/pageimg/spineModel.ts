import type { PageimgSplitSpreadParams, PageimgSpinePreviewParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

export const SPINE_PREVIEW_LIMIT = 3;
export const SPINE_MIN_PERCENT = 10;
export const SPINE_MAX_PERCENT = 90;

export type SpineMode = 'auto' | 'manual';

export interface SpinePreviewRow {
  pageIndex: number;
  status: 'done' | 'skipped';
  previewPath?: string;
  autoX?: number;
  confidence?: number;
  reason?: string;
}

export interface SpinePreviewData {
  pages: SpinePreviewRow[];
}

/** Parses the page field. Empty means all pages; null means the text is not a valid range. */
export function parseSpinePages(pagesText: string, pageCount: number): number[] | null {
  if (!pagesText.trim()) return null;
  const parsed = parsePageRanges(pagesText, pageCount);
  return parsed.ok ? [...parsed.pages].sort((a, b) => a - b) : [];
}

export function spinePreviewParams(
  pagesText: string,
  pageCount: number,
): PageimgSpinePreviewParams | null {
  const parsed = parseSpinePages(pagesText, pageCount);
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  const pages = (parsed ?? Array.from({ length: pageCount }, (_, i) => i)).slice(
    0,
    SPINE_PREVIEW_LIMIT,
  );
  return pages.length ? { pages } : null;
}

/** Split parameters. Manual mode applies one fraction to every page of the range. */
export function spineApplyParams(
  pagesText: string,
  pageCount: number,
  mode: SpineMode,
  percent: number,
): PageimgSplitSpreadParams | null {
  const parsed = parseSpinePages(pagesText, pageCount);
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  const base = parsed ? { pages: parsed } : {};
  if (mode === 'auto') return { ...base, order: 'ltr' };
  if (!Number.isFinite(percent) || percent < SPINE_MIN_PERCENT || percent > SPINE_MAX_PERCENT) {
    return null;
  }
  return { ...base, mode: 'x', x: Math.round(percent * 10) / 1000, order: 'ltr' };
}

/** The automatic split of the first previewed page, as a percentage for the slider. */
export function startPercent(data: SpinePreviewData): number {
  const first = data.pages.find((row) => row.status === 'done' && typeof row.autoX === 'number');
  if (!first || first.autoX === undefined) return 50;
  return clampPercent(Math.round(first.autoX * 1000) / 10);
}

export function clampPercent(value: number): number {
  return Math.min(SPINE_MAX_PERCENT, Math.max(SPINE_MIN_PERCENT, value));
}

export function readSpinePreview(data: unknown): SpinePreviewData {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { pages?: unknown }).pages)
  ) {
    return { pages: [] };
  }
  return {
    pages: (data as { pages: unknown[] }).pages.filter(
      (row): row is SpinePreviewRow =>
        typeof row === 'object' &&
        row !== null &&
        Number.isInteger((row as SpinePreviewRow).pageIndex) &&
        ['done', 'skipped'].includes((row as SpinePreviewRow).status),
    ),
  };
}
