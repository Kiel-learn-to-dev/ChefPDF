/**
 * Pure model of the cross-page seal (giáp lai, F4): the form, its checks, the core params of
 * stamp.seam, and the strip plan the preview shows (the same sets and slices as the core).
 */
import type { StampSeamParams } from '@chef/contracts';
import {
  inRange,
  pageSelection,
  selectedPages,
  type FormCheck,
  type PagesSel,
} from '../overlay/overlayModel';

export type SeamVertical = 'center' | 'top' | 'bottom' | 'mm';
export type SeamSide = 'right' | 'left';

export interface SeamForm {
  /** Absolute path of the seal image. Never stored in preferences (stripPaths). */
  path: string;
  side: SeamSide;
  /** Pages per set. 0 = one set with all the selected pages. */
  groupSize: number;
  cutFirstPage: boolean;
  vertical: SeamVertical;
  /** Distance from the top edge, used when vertical is "mm". */
  verticalMm: number;
  overlapMm: number;
  /** Width of the whole seal across all strips. 0 = natural size. */
  scaleWidthMm: number;
  opacity: number;
  blendMultiply: boolean;
  pages: PagesSel;
}

export const DEFAULT_SEAM_FORM: SeamForm = {
  path: '',
  side: 'right',
  groupSize: 0,
  cutFirstPage: true,
  vertical: 'center',
  verticalMm: 20,
  overlapMm: 0,
  scaleWidthMm: 30,
  opacity: 1,
  blendMultiply: true,
  pages: { choice: 'all', range: '' },
};

export interface SeamSlot {
  /** 0-based page that gets the strip. */
  page: number;
  /** 0-based number of the strip inside its set. */
  strip: number;
  /** Strips in that set. */
  of: number;
  /** 0-based set number. */
  set: number;
}

/**
 * The strips the core will place: the selected pages split into sets of `groupSize` (0 = one
 * set); in each set the first page is skipped when `cutFirstPage` is false. Mirrors stamp.seam.
 */
export function seamPlan(pages: number[], groupSize: number, cutFirstPage: boolean): SeamSlot[] {
  const sets: number[][] = [];
  if (groupSize <= 0) sets.push(pages);
  else for (let i = 0; i < pages.length; i += groupSize) sets.push(pages.slice(i, i + groupSize));
  return sets.flatMap((group, set) => {
    const targets = cutFirstPage ? group : group.slice(1);
    return targets.map((page, strip) => ({ page, strip, of: targets.length, set }));
  });
}

/** The strips per set of the first set, for the diagram (N slices). */
export function seamSliceCount(plan: SeamSlot[]): number {
  return plan.length === 0 ? 0 : plan[0]!.of;
}

export function checkSeamForm(form: SeamForm, pageCount: number, current: number): FormCheck {
  if (form.path.trim() === '') return { ok: false, field: 'path' };
  if (!Number.isInteger(form.groupSize) || !inRange(form.groupSize, 0, 10000)) {
    return { ok: false, field: 'groupSize' };
  }
  if (!inRange(form.overlapMm, 0, 50)) return { ok: false, field: 'overlapMm' };
  if (!inRange(form.scaleWidthMm, 0, 1000)) return { ok: false, field: 'scaleWidthMm' };
  if (!inRange(form.verticalMm, 0, 10000)) return { ok: false, field: 'verticalMm' };
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  const plan = seamPlan(
    selectedPages(form.pages, current, pageCount),
    form.groupSize,
    form.cutFirstPage,
  );
  if (plan.length === 0) return { ok: false, field: 'cutFirstPage' };
  return { ok: true };
}

/** The core params of stamp.seam for the form. */
export function seamParams(form: SeamForm, current: number, pageCount: number): StampSeamParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const pages = sel.ok ? sel.params : {};
  return {
    path: form.path,
    side: form.side,
    sliceMode: 'even',
    cutFirstPage: form.cutFirstPage,
    vertical: form.vertical === 'mm' ? form.verticalMm : form.vertical,
    overlapMm: form.overlapMm,
    opacity: form.opacity,
    blendMultiply: form.blendMultiply,
    ...(form.groupSize > 0 ? { groupSize: form.groupSize } : {}),
    ...(form.scaleWidthMm > 0 ? { scaleWidthMm: form.scaleWidthMm } : {}),
    ...pages,
  };
}

/**
 * Summary of the strips the core returned (data.strips, strip numbered from 1): how many strips,
 * how many sets (each set starts at strip 1) and how many pages got a strip.
 */
export function summarizeSeam(strips: { page: number; strip: number }[]): {
  strips: number;
  sets: number;
  pages: number;
} {
  return {
    strips: strips.length,
    sets: strips.filter((s) => s.strip === 1).length,
    pages: new Set(strips.map((s) => s.page)).size,
  };
}
