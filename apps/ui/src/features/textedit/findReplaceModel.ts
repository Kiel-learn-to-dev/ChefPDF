/**
 * Pure model of "Tìm & thay thế" (D10, T7.04): the form, the text.findReplace params, the grouping
 * of the preview matches and the summary of a finished run. The core replaces every match in the
 * chosen pages; it has no per-match exclusion, so the dialog offers the page scope only.
 */
import type { TextFindReplaceParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

export interface FindForm {
  find: string;
  replace: string;
  caseSensitive: boolean;
  ignoreDiacritics: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 'all' = every page; 'pages' = the range in pageRange. */
  scope: 'all' | 'pages';
  pageRange: string;
}

export const DEFAULT_FIND_FORM: FindForm = {
  find: '',
  replace: '',
  caseSensitive: false,
  ignoreDiacritics: false,
  wholeWord: false,
  regex: false,
  scope: 'all',
  pageRange: '',
};

export interface FindMatch {
  pageIndex: number;
  lineId: string;
  before: string;
  after: string;
  /** [left, top, right, bottom] of the matched characters, points. */
  rect: number[];
  fit: string;
  fontSize: number;
  tracking: number;
  overflow: number;
  fontTo: string;
}

export interface FindSkip {
  pageIndex: number;
  lineId: string;
  reason: string;
  missing?: string[];
}

export interface FindSubstitution {
  pageIndex: number;
  lineId: string;
  from: string;
  to: string;
}

export interface FindReplaceData {
  matches: FindMatch[];
  replaced: number;
  fontSubstitutions: FindSubstitution[];
  skipped: FindSkip[];
  preview: boolean;
}

export type FindFormError = 'FIND_REQUIRED' | 'INVALID_REGEX' | 'PAGE_RANGE';

/** The first problem of the form, or null when it can run. */
export function validateForm(form: FindForm, pageCount: number): FindFormError | null {
  if (form.find.length === 0) return 'FIND_REQUIRED';
  if (form.regex) {
    try {
      new RegExp(form.find);
    } catch {
      return 'INVALID_REGEX';
    }
  }
  if (form.scope === 'pages') {
    const parsed = parsePageRanges(form.pageRange, pageCount);
    if (!parsed.ok) return 'PAGE_RANGE';
  }
  return null;
}

/** The text.findReplace params of the form. Pages are 0-based and sorted; none means all. */
export function buildFindParams(
  form: FindForm,
  pageCount: number,
  preview: boolean,
): TextFindReplaceParams {
  const params: TextFindReplaceParams = {
    find: form.find,
    replace: form.replace,
    caseSensitive: form.caseSensitive,
    ignoreDiacritics: form.ignoreDiacritics,
    wholeWord: form.wholeWord,
    regex: form.regex,
    preview,
    fontStrategy: 'auto',
    keepStyle: true,
    fitWidth: 'none',
  };
  if (form.scope === 'pages') {
    const parsed = parsePageRanges(form.pageRange, pageCount);
    if (parsed.ok) params.pages = [...new Set(parsed.pages)].sort((a, b) => a - b);
  }
  return params;
}

/** Matches of the preview, grouped by page (ascending). */
export function groupByPage(
  matches: readonly FindMatch[],
): { pageIndex: number; matches: FindMatch[] }[] {
  const byPage = new Map<number, FindMatch[]>();
  for (const m of matches) {
    const list = byPage.get(m.pageIndex) ?? [];
    list.push(m);
    byPage.set(m.pageIndex, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, list]) => ({ pageIndex, matches: list }));
}

export interface ReplaceSummary {
  replaced: number;
  pages: number[];
  substitutions: number;
  /** Count of skipped lines per reason (the reason text as the core sent it). */
  skippedByReason: Record<string, number>;
  fonts: string[];
}

/** Summary of a finished run for the dialog and the toast. */
export function summarize(data: FindReplaceData): ReplaceSummary {
  const skippedByReason: Record<string, number> = {};
  for (const s of data.skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  const pages = [...new Set(data.matches.map((m) => m.pageIndex))].sort((a, b) => a - b);
  const fonts = [...new Set(data.fontSubstitutions.map((s) => s.to))];
  return {
    replaced: data.replaced,
    pages,
    substitutions: data.fontSubstitutions.length,
    skippedByReason,
    fonts,
  };
}

/** The highlight boxes of the preview matches (display frame, points). */
export function matchHighlights(
  matches: readonly FindMatch[],
): { pageIndex: number; rect: number[] }[] {
  return matches.map((m) => ({ pageIndex: m.pageIndex, rect: m.rect }));
}
