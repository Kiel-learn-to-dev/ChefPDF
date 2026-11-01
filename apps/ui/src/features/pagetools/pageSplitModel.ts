/** Pure model of "Chia đôi trang" (C9; T5.09): each page cut into rows x cols pieces (page.split). */
import type { PageSplitParams } from '@chef/contracts';
import { isIntIn, isNumIn, scopePages, scopeIssue } from './pageScope';

export interface PageSplitForm {
  /** page.split takes a page list (no odd / even scope). */
  scope: 'all' | 'pages';
  pagesText: string;
  rows: number;
  cols: number;
  overlapMm: number;
  order: 'ltr' | 'rtl';
}

export const DEFAULT_PAGE_SPLIT_FORM: PageSplitForm = {
  scope: 'all',
  pagesText: '',
  rows: 1,
  cols: 2,
  overlapMm: 0,
  order: 'ltr',
};

export type PageSplitIssue = 'pages' | 'rows' | 'cols' | 'pieces' | 'overlap';

export function pageSplitIssues(form: PageSplitForm, pageCount: number): PageSplitIssue[] {
  const out: PageSplitIssue[] = [];
  if (scopeIssue(form.scope, form.pagesText, pageCount)) out.push('pages');
  if (!isIntIn(form.rows, 1, 10)) out.push('rows');
  if (!isIntIn(form.cols, 1, 10)) out.push('cols');
  if (!out.includes('rows') && !out.includes('cols') && form.rows * form.cols < 2) {
    out.push('pieces');
  }
  if (!isNumIn(form.overlapMm, 0, 50)) out.push('overlap');
  return out;
}

export function pageSplitParams(form: PageSplitForm, pageCount: number): PageSplitParams {
  const out: PageSplitParams = {
    rows: form.rows,
    cols: form.cols,
    overlapMm: form.overlapMm,
    order: form.order,
  };
  if (form.scope === 'pages') out.pages = scopePages('pages', form.pagesText, pageCount) ?? [];
  return out;
}
