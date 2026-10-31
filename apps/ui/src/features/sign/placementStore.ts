/**
 * Signature placement on the open documents (T3.12). In memory only: nothing here is saved, the
 * last box size is kept in settings.prefs.sign by the caller.
 *
 * `placement` is the box the next signature uses (user space rect). `previews` are the boxes of
 * the anchor preview (I26), shown on the pages until they are cleared.
 */
import { create } from 'zustand';

export type PlacementSource = 'draw' | 'field' | 'anchor' | 'fixed';

export interface PlacedBox {
  pageIndex: number;
  /** User space [x1, y1, x2, y2] in points. */
  rect: [number, number, number, number];
  /** Existing empty field the signature is drawn into. */
  fieldName?: string;
  source: PlacementSource;
}

export interface AnchorPreview {
  pageIndex: number;
  rect: [number, number, number, number];
}

interface DocPlacement {
  placement: PlacedBox | null;
  previews: AnchorPreview[];
  /** Index in previews of the box the signature uses. */
  selected: number;
}

interface PlacementState {
  /** Document in placement mode (the viewer accepts drags), or null. */
  placingDocId: string | null;
  byDoc: Record<string, DocPlacement>;
  startPlacing(docId: string): void;
  stopPlacing(): void;
  setPlacement(docId: string, box: PlacedBox | null): void;
  setPreviews(docId: string, previews: AnchorPreview[]): void;
  selectPreview(docId: string, index: number): void;
  forget(docId: string): void;
}

const EMPTY: DocPlacement = { placement: null, previews: [], selected: 0 };

export const usePlacementStore = create<PlacementState>((set) => ({
  placingDocId: null,
  byDoc: {},
  startPlacing(docId) {
    set({ placingDocId: docId });
  },
  stopPlacing() {
    set({ placingDocId: null });
  },
  setPlacement(docId, box) {
    set((s) => ({
      byDoc: { ...s.byDoc, [docId]: { ...(s.byDoc[docId] ?? EMPTY), placement: box } },
    }));
  },
  setPreviews(docId, previews) {
    set((s) => ({
      byDoc: {
        ...s.byDoc,
        [docId]: { ...(s.byDoc[docId] ?? EMPTY), previews, selected: 0 },
      },
    }));
  },
  selectPreview(docId, index) {
    set((s) => {
      const cur = s.byDoc[docId] ?? EMPTY;
      if (index < 0 || index >= cur.previews.length) return s;
      const picked = cur.previews[index]!;
      return {
        byDoc: {
          ...s.byDoc,
          [docId]: {
            ...cur,
            selected: index,
            placement: { pageIndex: picked.pageIndex, rect: picked.rect, source: 'anchor' },
          },
        },
      };
    });
  },
  forget(docId) {
    set((s) => {
      const next = { ...s.byDoc };
      delete next[docId];
      return { byDoc: next, placingDocId: s.placingDocId === docId ? null : s.placingDocId };
    });
  },
}));

/** Reactive placement of a document: the component re-renders when it changes. */
export function usePlacementOf(docId: string | undefined): DocPlacement {
  return usePlacementStore((s) => (docId && s.byDoc[docId]) || EMPTY);
}

export function placementOf(docId: string | undefined): DocPlacement {
  return (docId && usePlacementStore.getState().byDoc[docId]) || EMPTY;
}
