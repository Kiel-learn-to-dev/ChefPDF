import type { PageimgEraseParams, PageimgRemoveStainsParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

export const ERASE_MIN_SIDE = 0.005;

export interface EraseRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StainPreset {
  id: 'blue' | 'highlighter' | 'red';
  hueMin: number;
  hueMax: number;
}

/** Hue ranges (degrees) of the three inks the stain tool knows. Red wraps around 0. */
export const STAIN_PRESETS: StainPreset[] = [
  { id: 'blue', hueMin: 200, hueMax: 250 },
  { id: 'highlighter', hueMin: 45, hueMax: 70 },
  { id: 'red', hueMin: 340, hueMax: 20 },
];

/** A rectangle from two drag points given as fractions of the image, clamped to the page. */
export function rectFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
): EraseRect | null {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp(Math.min(start.x, end.x));
  const x1 = clamp(Math.max(start.x, end.x));
  const y0 = clamp(Math.min(start.y, end.y));
  const y1 = clamp(Math.max(start.y, end.y));
  if (x1 - x0 < ERASE_MIN_SIDE || y1 - y0 < ERASE_MIN_SIDE) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function parseEraseSinglePage(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const page = Number(trimmed);
  if (page < 1 || page > pageCount) return null;
  return page - 1;
}

export function eraseParams(
  pageIndex: number | null,
  rects: EraseRect[],
  fill: 'paper' | '#ffffff',
): PageimgEraseParams | null {
  if (pageIndex === null || rects.length === 0) return null;
  return {
    pageIndex,
    rects: rects.map((r) => ({
      x: round(r.x),
      y: round(r.y),
      w: round(r.w),
      h: round(r.h),
    })),
    fill,
  };
}

export function stainParams(
  pagesText: string,
  pageCount: number,
  preset: StainPreset,
): PageimgRemoveStainsParams | null {
  const trimmed = pagesText.trim();
  if (!trimmed) return { hueMin: preset.hueMin, hueMax: preset.hueMax };
  const parsed = parsePageRanges(trimmed, pageCount);
  if (!parsed.ok || parsed.pages.length === 0) return null;
  return {
    pages: [...parsed.pages].sort((a, b) => a - b),
    hueMin: preset.hueMin,
    hueMax: preset.hueMax,
  };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}
