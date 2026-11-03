import type { PageimgDewarpParams, PageimgDewarpPreviewParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

export const DEWARP_MIN_CONFIDENCE = 0.35;
export const DEWARP_PREVIEW_LIMIT = 3;

export interface DewarpPreviewPage {
  pageIndex: number;
  status: 'done' | 'skipped';
  reason?: string;
  originalPath?: string;
  resultPath?: string;
  confidence?: number;
  correctionPx?: number;
}

export interface DewarpPreviewData {
  pages: DewarpPreviewPage[];
}

export interface DewarpApplyData {
  pages: Array<{
    pageIndex: number;
    status: 'done' | 'skipped' | 'review';
    reason?: string;
    confidence?: number;
    correctionPx?: number;
  }>;
}

export function parseDewarpPages(pagesText: string, pageCount: number): number[] | null {
  if (!pagesText.trim()) return null;
  const parsed = parsePageRanges(pagesText, pageCount);
  return parsed.ok ? [...parsed.pages].sort((a, b) => a - b) : [];
}

export function previewParams(
  pagesText: string,
  pageCount: number,
): PageimgDewarpPreviewParams | null {
  const parsed = parseDewarpPages(pagesText, pageCount);
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  const pages = (parsed ?? Array.from({ length: pageCount }, (_, i) => i)).slice(
    0,
    DEWARP_PREVIEW_LIMIT,
  );
  return pages.length ? { pages } : null;
}

export function applyParams(pagesText: string, pageCount: number): PageimgDewarpParams | null {
  const parsed = parseDewarpPages(pagesText, pageCount);
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  return {
    ...(parsed ? { pages: parsed } : {}),
    minConfidence: DEWARP_MIN_CONFIDENCE,
  };
}

export function readPreviewData(data: unknown): DewarpPreviewData {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { pages?: unknown }).pages)
  ) {
    return { pages: [] };
  }
  return {
    pages: (data as { pages: unknown[] }).pages.filter(
      (row): row is DewarpPreviewPage =>
        typeof row === 'object' &&
        row !== null &&
        Number.isInteger((row as DewarpPreviewPage).pageIndex) &&
        ['done', 'skipped'].includes((row as DewarpPreviewPage).status),
    ),
  };
}

export function reviewPages(data: unknown): number[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { pages?: unknown }).pages)
  ) {
    return [];
  }
  return (data as { pages: unknown[] }).pages.flatMap((row) => {
    if (
      typeof row === 'object' &&
      row !== null &&
      (row as { status?: unknown }).status === 'review' &&
      Number.isInteger((row as { pageIndex?: unknown }).pageIndex)
    ) {
      return [(row as { pageIndex: number }).pageIndex];
    }
    return [];
  });
}
