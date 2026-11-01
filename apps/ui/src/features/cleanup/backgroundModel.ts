/**
 * Page backgrounds (E5): reading background.detect, the per-page list and the background.remove
 * params. Pure.
 */
import type { BackgroundRemoveParams } from '@chef/contracts';
import { scopeFieldsOf, type CleanupScope } from './scope';

export interface BackgroundItem {
  pageIndex: number;
  id: string;
  /** "rectangle", "image" or "fill" as the core names it. */
  kind: string;
  /** Display frame [x1, y1, x2, y2], points, origin top-left. */
  bbox: number[];
  /** 0..1 of the page area. */
  coverage: number;
  /** #rrggbb or null. */
  fill: string | null;
}

export type BackgroundMode = 'remove' | 'replaceColor';

const HEX = /^#[0-9a-fA-F]{6}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Backgrounds of a background.detect result; malformed entries are skipped. */
export function readBackgrounds(data: unknown): BackgroundItem[] {
  if (!isRecord(data) || !Array.isArray(data.backgrounds)) return [];
  const out: BackgroundItem[] = [];
  for (const raw of data.backgrounds) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.pageIndex !== 'number') {
      continue;
    }
    out.push({
      pageIndex: raw.pageIndex,
      id: raw.id,
      kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
      bbox: Array.isArray(raw.bbox) ? raw.bbox.map(Number) : [],
      coverage: typeof raw.coverage === 'number' ? raw.coverage : 0,
      fill: typeof raw.fill === 'string' ? raw.fill : null,
    });
  }
  return out;
}

export interface PageBackgrounds {
  pageIndex: number;
  items: BackgroundItem[];
  /** The largest coverage on the page, 0..1. */
  coverage: number;
}

/** Backgrounds grouped per page, in page order. */
export function groupByPage(items: readonly BackgroundItem[]): PageBackgrounds[] {
  const byPage = new Map<number, BackgroundItem[]>();
  for (const it of items) {
    const list = byPage.get(it.pageIndex) ?? [];
    list.push(it);
    byPage.set(it.pageIndex, list);
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageIndex, list]) => ({
      pageIndex,
      items: list,
      coverage: Math.max(0, ...list.map((i) => i.coverage)),
    }));
}

/**
 * background.remove params. `replaceColor` needs a #rrggbb colour. Null when the colour is not
 * valid or the page scope is not valid.
 */
export function backgroundRemoveParams(
  mode: BackgroundMode,
  color: string,
  scope: CleanupScope,
  pageCount: number,
): BackgroundRemoveParams | null {
  const fields = scopeFieldsOf(scope, pageCount);
  if (!fields) return null;
  if (mode === 'remove') return { mode: 'remove', ...fields };
  if (!HEX.test(color)) return null;
  return { mode: 'replaceColor', color, ...fields };
}

/** Objects removed or recoloured, from a background.remove result. */
export function readBackgroundResult(data: unknown): number {
  return isRecord(data) && typeof data.objects === 'number' ? data.objects : 0;
}
