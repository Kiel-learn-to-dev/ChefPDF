/**
 * Boxes shown on the pages while a cleanup or redaction dialog is open: candidates, matches and
 * manual areas. In memory only; the document is not changed by showing them.
 */
import { create } from 'zustand';

/** A box on one page: display frame [x1, y1, x2, y2], points, origin top-left. */
export interface HighlightItem {
  pageIndex: number;
  rect: number[];
}

interface HighlightState {
  docId: string | null;
  items: HighlightItem[];
  show(docId: string, items: HighlightItem[]): void;
  clear(): void;
}

export const useHighlight = create<HighlightState>((set) => ({
  docId: null,
  items: [],
  show: (docId, items) => set({ docId, items }),
  clear: () => set({ docId: null, items: [] }),
}));

/** Boxes of a list of matches or candidates as highlight items (rects with four numbers). */
export function itemsFrom(
  list: readonly { pageIndex: number; rects?: number[][]; bbox?: number[] }[],
): HighlightItem[] {
  const out: HighlightItem[] = [];
  for (const m of list) {
    for (const r of m.rects ?? (m.bbox ? [m.bbox] : [])) {
      if (r.length === 4) out.push({ pageIndex: m.pageIndex, rect: r });
    }
  }
  return out;
}
