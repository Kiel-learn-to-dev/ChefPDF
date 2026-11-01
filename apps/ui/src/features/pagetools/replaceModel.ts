/** Pure model of "Thay trang" (C6; T5.09): target pages, source file and range, params of page.replace. */
import type { PageReplaceParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

export interface ReplaceForm {
  /** 1-based ranges of the pages to replace in the open document. */
  targetText: string;
  sourcePath: string;
  sourcePassword?: string;
  /** Page count of the source file (from the probe). */
  sourceCount: number;
  /** 1-based ranges of the source pages; empty = all. */
  sourceText: string;
}

export const DEFAULT_REPLACE_FORM: ReplaceForm = {
  targetText: '',
  sourcePath: '',
  sourceCount: 0,
  sourceText: '',
};

export type ReplaceIssue = 'target' | 'source' | 'sourcePages';

export function replaceIssues(form: ReplaceForm, pageCount: number): ReplaceIssue[] {
  const out: ReplaceIssue[] = [];
  if (!parsePageRanges(form.targetText, pageCount).ok) out.push('target');
  if (!form.sourcePath) out.push('source');
  if (form.sourceText.trim() && !parsePageRanges(form.sourceText, form.sourceCount).ok) {
    out.push('sourcePages');
  }
  return out;
}

export function replaceParams(form: ReplaceForm, pageCount: number): PageReplaceParams {
  const target = parsePageRanges(form.targetText, pageCount);
  const out: PageReplaceParams = {
    pages: target.ok ? target.pages : [],
    path: form.sourcePath,
  };
  if (form.sourcePassword) out.password = form.sourcePassword;
  if (form.sourceText.trim()) {
    const src = parsePageRanges(form.sourceText, form.sourceCount);
    if (src.ok) out.sourcePages = src.pages;
  }
  return out;
}
