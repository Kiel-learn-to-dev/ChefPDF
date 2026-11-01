/**
 * Pure model of "Cắt lề / đổi khổ" (C7; T5.09): page.crop (margins in mm, a box in points, or
 * auto-trim) and page.resize (A3 / A4 / Letter / custom, scaled or centred), with page scope.
 */
import type { PageCropParams, PageResizeParams } from '@chef/contracts';
import { isNumIn, scopeFields, scopeIssue, type ToolScope } from './pageScope';

export type CropMethod = 'margins' | 'box' | 'autoTrim';
export type ResizeSize = 'A3' | 'A4' | 'Letter' | 'custom';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CropForm {
  method: CropMethod;
  margins: Margins;
  /** x0, y0, x1, y1 in points. */
  box: number[];
  paddingMm: number;
  scope: ToolScope;
  pagesText: string;
}

export const DEFAULT_CROP_FORM: CropForm = {
  method: 'margins',
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  box: [0, 0, 595, 842],
  paddingMm: 3,
  scope: 'all',
  pagesText: '',
};

export type CropIssue = 'pages' | 'margins' | 'box' | 'padding';

/** Four finite numbers with x1 > x0 and y1 > y0. */
function boxValid(box: number[]): boolean {
  if (box.length !== 4 || !box.every((v) => Number.isFinite(v))) return false;
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  return x1 > x0 && y1 > y0;
}

export function cropIssues(form: CropForm, pageCount: number): CropIssue[] {
  const out: CropIssue[] = [];
  if (scopeIssue(form.scope, form.pagesText, pageCount)) out.push('pages');
  if (form.method === 'margins') {
    const m = form.margins;
    if (![m.top, m.right, m.bottom, m.left].every((v) => isNumIn(v, 0, 500))) out.push('margins');
  }
  if (form.method === 'box' && !boxValid(form.box)) out.push('box');
  if (form.method === 'autoTrim' && !isNumIn(form.paddingMm, 0, 50)) out.push('padding');
  return out;
}

/** Params of page.crop for a valid form: exactly one of margins, box or autoTrim. */
export function cropParams(form: CropForm, pageCount: number): PageCropParams {
  const base = scopeFields(form.scope, form.pagesText, pageCount);
  if (form.method === 'margins') return { ...base, margins: { ...form.margins } };
  if (form.method === 'box') return { ...base, box: [...form.box] };
  return { ...base, autoTrim: true, trimPaddingMm: form.paddingMm };
}

export interface ResizeForm {
  size: ResizeSize;
  customWidthMm: number;
  customHeightMm: number;
  fit: 'scale' | 'center';
  scope: ToolScope;
  pagesText: string;
}

export const DEFAULT_RESIZE_FORM: ResizeForm = {
  size: 'A4',
  customWidthMm: 210,
  customHeightMm: 297,
  fit: 'scale',
  scope: 'all',
  pagesText: '',
};

export type ResizeIssue = 'pages' | 'customSize';

export function resizeIssues(form: ResizeForm, pageCount: number): ResizeIssue[] {
  const out: ResizeIssue[] = [];
  if (scopeIssue(form.scope, form.pagesText, pageCount)) out.push('pages');
  if (
    form.size === 'custom' &&
    !(isNumIn(form.customWidthMm, 1, 5000) && isNumIn(form.customHeightMm, 1, 5000))
  ) {
    out.push('customSize');
  }
  return out;
}

export function resizeParams(form: ResizeForm, pageCount: number): PageResizeParams {
  const base = scopeFields(form.scope, form.pagesText, pageCount);
  const out: PageResizeParams = { ...base, size: form.size, fit: form.fit };
  if (form.size === 'custom') {
    out.customWidthMm = form.customWidthMm;
    out.customHeightMm = form.customHeightMm;
  }
  return out;
}
