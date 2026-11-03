/**
 * In-memory state of the link drawing (not saved): the drag mode of the viewer and the rect drawn
 * on a page until the link form is saved or cancelled.
 */
import { create } from 'zustand';

export interface PendingLink {
  pageIndex: number;
  /** [left, top, right, bottom] in points, displayed frame. */
  rect: number[];
}

interface LinkDrawState {
  drawing: boolean;
  pending: PendingLink | null;
  setDrawing(on: boolean): void;
  setPending(p: PendingLink | null): void;
}

export const useLinkDraw = create<LinkDrawState>((set) => ({
  drawing: false,
  pending: null,
  setDrawing(on) {
    set({ drawing: on });
  },
  setPending(p) {
    set({ pending: p });
  },
}));
