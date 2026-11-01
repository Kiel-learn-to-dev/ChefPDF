/**
 * Pure model of "Chuyển màu" (M6; T5.07): the form, its validation, the params of color.convert
 * (only the fields of the chosen mode are sent) and the report of the result.
 */
import type { ColorConvertParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

export const COLOR_MODES = ['gray', 'blackwhite', 'ink-saver', 'replace-color'] as const;
export type ColorMode = ColorConvertParams['mode'];
export type ColorScope = 'all' | 'pages';

export interface ColorForm {
  mode: ColorMode;
  scope: ColorScope;
  /** 1-based page ranges, used when scope is 'pages'. */
  pagesText: string;
  /** blackwhite: cut-off 0..255. */
  threshold: number;
  dithering: boolean;
  /** ink-saver: 0..1. */
  amount: number;
  /** replace-color: '#rrggbb'. */
  sourceColor: string;
  targetColor: string;
  /** replace-color: per channel 0..255. */
  tolerance: number;
}

export const DEFAULT_COLOR_FORM: ColorForm = {
  mode: 'gray',
  scope: 'all',
  pagesText: '',
  threshold: 128,
  dithering: false,
  amount: 0.5,
  sourceColor: '#ff0000',
  targetColor: '#000000',
  tolerance: 24,
};

export type ColorIssue =
  'pages' | 'threshold' | 'amount' | 'sourceColor' | 'targetColor' | 'tolerance';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** '#rrggbb' in lower case, or null when the text is not a 6-digit hex colour. */
export function normalizeHex(text: string): string | null {
  const t = text.trim();
  return HEX.test(t) ? t.toLowerCase() : null;
}

function isIntIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/** 0-based pages of the selector; null when the text is empty or not valid for the document. */
export function selectedColorPages(form: ColorForm, pageCount: number): number[] | null {
  const parsed = parsePageRanges(form.pagesText, pageCount);
  return parsed.ok ? parsed.pages : null;
}

/** Problems of the form for a document with pageCount pages (empty = ready to run). */
export function colorIssues(form: ColorForm, pageCount: number): ColorIssue[] {
  const out: ColorIssue[] = [];
  if (form.scope === 'pages' && selectedColorPages(form, pageCount) === null) out.push('pages');
  if (form.mode === 'blackwhite' && !isIntIn(form.threshold, 0, 255)) out.push('threshold');
  if (form.mode === 'ink-saver' && !(form.amount >= 0 && form.amount <= 1)) out.push('amount');
  if (form.mode === 'replace-color') {
    if (normalizeHex(form.sourceColor) === null) out.push('sourceColor');
    if (normalizeHex(form.targetColor) === null) out.push('targetColor');
    if (!isIntIn(form.tolerance, 0, 255)) out.push('tolerance');
  }
  return out;
}

/** Params of color.convert for a valid form. */
export function colorParams(form: ColorForm, pageCount: number): ColorConvertParams {
  const out: ColorConvertParams = { mode: form.mode };
  if (form.scope === 'pages') out.pages = selectedColorPages(form, pageCount) ?? [];
  if (form.mode === 'blackwhite') {
    out.threshold = form.threshold;
    out.dithering = form.dithering;
  }
  if (form.mode === 'ink-saver') out.amount = form.amount;
  if (form.mode === 'replace-color') {
    out.sourceColor = normalizeHex(form.sourceColor) ?? form.sourceColor;
    out.targetColor = normalizeHex(form.targetColor) ?? form.targetColor;
    out.tolerance = form.tolerance;
  }
  return out;
}

export interface ColorReport {
  coloursChanged: number;
  imagesChanged: number;
  pagesChanged: number;
  kept: { reason: string; count: number }[];
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Reads the data of color.convert (missing fields count as zero). */
export function readColorReport(data: unknown): ColorReport {
  const d = (data ?? {}) as Record<string, unknown>;
  const kept =
    d.kept && typeof d.kept === 'object'
      ? Object.entries(d.kept as Record<string, unknown>)
          .filter(([, n]) => typeof n === 'number' && n > 0)
          .map(([reason, n]) => ({ reason, count: n as number }))
          .sort((a, b) => a.reason.localeCompare(b.reason))
      : [];
  return {
    coloursChanged: count(d.coloursChanged),
    imagesChanged: count(d.imagesChanged),
    pagesChanged: count(d.pagesChanged),
    kept,
  };
}
