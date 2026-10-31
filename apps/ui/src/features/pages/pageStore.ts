import { create } from 'zustand';
import { emptySelection, type Selection } from './selection';

interface PageStore {
  selections: Record<string, Selection>;
  /** Thumbnail width in the organizer grid. */
  thumbWidth: number;
  setSelection(docId: string, sel: Selection): void;
  setThumbWidth(w: number): void;
}

export const usePageStore = create<PageStore>((set) => ({
  selections: {},
  thumbWidth: 148,
  setSelection(docId, sel) {
    set((s) => ({ selections: { ...s.selections, [docId]: sel } }));
  },
  setThumbWidth(w) {
    set({ thumbWidth: w });
  },
}));

export function useSelection(docId: string | undefined): Selection {
  return usePageStore((s) => (docId ? (s.selections[docId] ?? emptySelection) : emptySelection));
}

export function getSelection(docId: string): Selection {
  return usePageStore.getState().selections[docId] ?? emptySelection;
}
