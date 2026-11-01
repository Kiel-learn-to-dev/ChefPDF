/** Page-selection helpers shared by the page tools (scope = all / odd / even / a page list). */
import { parsePageRanges } from '../../lib/pageRange';

export type ToolScope = 'all' | 'odd' | 'even' | 'pages';

/** The 0-based pages of a scope, or null when a page list is needed but not valid. */
export function scopePages(
  scope: ToolScope,
  pagesText: string,
  pageCount: number,
): number[] | null {
  if (scope === 'pages') {
    const parsed = parsePageRanges(pagesText, pageCount);
    return parsed.ok ? parsed.pages : null;
  }
  return null;
}

/** Scope fields of a contract params object: `scope` plus `pages` for the page list. */
export function scopeFields(
  scope: ToolScope,
  pagesText: string,
  pageCount: number,
): { scope: ToolScope; pages?: number[] } {
  const pages = scopePages(scope, pagesText, pageCount);
  return pages ? { scope, pages } : { scope };
}

export function scopeIssue(scope: ToolScope, pagesText: string, pageCount: number): boolean {
  return scope === 'pages' && scopePages(scope, pagesText, pageCount) === null;
}

export function isIntIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

export function isNumIn(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}
