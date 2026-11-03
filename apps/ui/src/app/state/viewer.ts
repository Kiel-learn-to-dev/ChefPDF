import { create } from 'zustand';

/** Scroll modes (values match pdf.js ScrollMode) and spread modes (SpreadMode). */
export type ViewMode = 'single' | 'continuous' | 'twoPage' | 'book';
export type ZoomPreset = 'page-width' | 'page-fit' | 'auto' | 'page-actual';

export interface ViewState {
  page: number; // 1-based (pdf.js)
  pageCount: number;
  /** Actual scale (1 = 100%). */
  scale: number;
  /** pdf.js currentScaleValue: a preset or a number string. */
  scaleValue: string;
  rotation: 0 | 90 | 180 | 270;
  mode: ViewMode;
  night: boolean;
  /** Last position for restoring after reload: [left, top] in PDF points of `page`. */
  location?: { page: number; left: number; top: number };
}

export const defaultView: ViewState = {
  page: 1,
  pageCount: 0,
  scale: 1,
  scaleValue: 'auto',
  rotation: 0,
  mode: 'continuous',
  night: false,
};

interface ViewerStore {
  views: Record<string, ViewState>;
  split: boolean;
  setSplit(value: boolean): void;
  patch(docId: string, patch: Partial<ViewState>): void;
  drop(docId: string): void;
}

export const useViewStore = create<ViewerStore>((set) => ({
  views: {},
  split: false,
  setSplit: (split) => set({ split }),
  patch(docId, patch) {
    set((s) => ({
      views: { ...s.views, [docId]: { ...(s.views[docId] ?? defaultView), ...patch } },
    }));
  },
  drop(docId) {
    set((s) => {
      const views = { ...s.views };
      delete views[docId];
      return { views };
    });
  },
}));

export function useView(docId: string | undefined): ViewState {
  return useViewStore((s) => (docId ? (s.views[docId] ?? defaultView) : defaultView));
}

export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

export function nextZoom(scale: number, dir: 1 | -1): number {
  if (dir > 0)
    return ZOOM_STEPS.find((z) => z > scale + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001) ?? ZOOM_STEPS[0]!;
}
