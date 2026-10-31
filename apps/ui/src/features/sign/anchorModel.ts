/**
 * Form state of "placement by anchor text" (I26) and of fixed positions (I27), and their mapping to
 * the op params. Pure. Sizes are typed in mm (the users' unit) and sent in points.
 */
import type { AnchorPlacement, FixedPlacement, SignPlaceFromAnchorParams } from '@chef/contracts';
import { mmToPt } from './placementGeometry';

export type AnchorPosition = 'below' | 'above' | 'right' | 'left' | 'over';
export type AnchorAlign = 'left' | 'center' | 'right';
export type OnMissing = 'skip' | 'fail' | 'fallback-fixed';

export interface AnchorForm {
  text: string;
  position: AnchorPosition;
  widthMm: number;
  heightMm: number;
  offsetXPt: number;
  offsetYPt: number;
  align: AnchorAlign;
  ignoreDiacritics: boolean;
  whichMatch: 'first' | 'last' | 'all';
  onMissing: OnMissing;
}

export const DEFAULT_ANCHOR_FORM: AnchorForm = {
  text: '',
  position: 'below',
  widthMm: 50,
  heightMm: 20,
  offsetXPt: 0,
  offsetYPt: 0,
  align: 'center',
  ignoreDiacritics: true,
  whichMatch: 'first',
  onMissing: 'skip',
};

export const MAX_RECENT_ANCHORS = 8;
const ANCHOR_TEXT_MAX = 120;

/** Recent anchor texts, most recent first. Case and diacritics do not make two entries. */
export function rememberAnchor(list: readonly string[], text: string): string[] {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, ANCHOR_TEXT_MAX);
  if (!clean) return [...list];
  const key = anchorKey(clean);
  const rest = list.filter((t) => anchorKey(t) !== key);
  return [clean, ...rest].slice(0, MAX_RECENT_ANCHORS);
}

/** Comparison key of an anchor text: no case, no diacritics, one space between words. */
export function anchorKey(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();
}

export interface AnchorFormError {
  field: 'text' | 'widthMm' | 'heightMm' | 'offsetXPt' | 'offsetYPt';
}

/** The first problem of the form, or null. Ranges match what the core accepts. */
export function validateAnchorForm(f: AnchorForm): AnchorFormError | null {
  if (f.text.trim().length === 0) return { field: 'text' };
  if (!inRange(f.widthMm, 2, 300)) return { field: 'widthMm' };
  if (!inRange(f.heightMm, 2, 300)) return { field: 'heightMm' };
  if (!inRange(f.offsetXPt, -500, 500)) return { field: 'offsetXPt' };
  if (!inRange(f.offsetYPt, -500, 500)) return { field: 'offsetYPt' };
  return null;
}

function inRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}

/** Params of the anchor placement used by the batch op. */
export function anchorPlacementParams(f: AnchorForm): AnchorPlacement {
  return {
    kind: 'anchor',
    text: f.text.trim(),
    position: f.position,
    width: round(mmToPt(f.widthMm)),
    height: round(mmToPt(f.heightMm)),
    offsetX: f.offsetXPt,
    offsetY: f.offsetYPt,
    align: f.align,
    ignoreDiacritics: f.ignoreDiacritics,
    whichMatch: f.whichMatch,
    onMissing: f.onMissing,
  };
}

/** Params of sign.placeFromAnchor for the matches found by sign.findAnchors. */
export function placeFromAnchorParams(
  f: AnchorForm,
  anchors: { pageIndex: number; rect: number[] }[],
): SignPlaceFromAnchorParams {
  return {
    anchors: anchors.map((a) => ({ pageIndex: a.pageIndex, rect: [...a.rect] })),
    width: round(mmToPt(f.widthMm)),
    height: round(mmToPt(f.heightMm)),
    position: f.position,
    offsetX: f.offsetXPt,
    offsetY: f.offsetYPt,
    align: f.align,
    clampToPage: true,
  };
}

export type FixedCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface FixedForm {
  corner: FixedCorner;
  widthMm: number;
  heightMm: number;
  marginPt: number;
  page: 'first' | 'last' | number;
}

export const DEFAULT_FIXED_FORM: FixedForm = {
  corner: 'bottom-right',
  widthMm: 50,
  heightMm: 20,
  marginPt: 36,
  page: 'last',
};

export function validateFixedForm(f: FixedForm): AnchorFormError | null {
  if (!inRange(f.widthMm, 2, 300)) return { field: 'widthMm' };
  if (!inRange(f.heightMm, 2, 300)) return { field: 'heightMm' };
  if (!inRange(f.marginPt, 0, 300)) return { field: 'offsetXPt' };
  return null;
}

export function fixedPlacementParams(f: FixedForm): FixedPlacement {
  return {
    kind: 'fixed',
    corner: f.corner,
    width: round(mmToPt(f.widthMm)),
    height: round(mmToPt(f.heightMm)),
    margin: f.marginPt,
    page: f.page,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
