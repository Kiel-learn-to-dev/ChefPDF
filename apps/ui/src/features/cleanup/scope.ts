/**
 * Page scope of the cleanup tools (watermark, background, similar objects): every page, the
 * current page, or a page list typed by the user. Pure.
 */
import { parsePageRanges } from '../../lib/pageRange';

export type CleanupScope =
  { kind: 'all' } | { kind: 'current'; page: number } | { kind: 'range'; text: string };

/**
 * The 0-based pages of a scope for a contract `pages` field: `undefined` for all pages (the field
 * is then omitted), a list for the others, or `null` when the typed range is not valid.
 */
export function cleanupPages(scope: CleanupScope, pageCount: number): number[] | undefined | null {
  if (scope.kind === 'all') return undefined;
  if (scope.kind === 'current') {
    return scope.page >= 0 && scope.page < pageCount ? [scope.page] : null;
  }
  const parsed = parsePageRanges(scope.text, pageCount);
  return parsed.ok ? parsed.pages : null;
}

/** Contract fields for the scope: `pages` is only present for a page list. */
export function scopeFieldsOf(scope: CleanupScope, pageCount: number): { pages?: number[] } | null {
  const pages = cleanupPages(scope, pageCount);
  if (pages === null) return null;
  return pages === undefined ? {} : { pages };
}
