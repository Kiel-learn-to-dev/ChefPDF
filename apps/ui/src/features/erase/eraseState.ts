/**
 * In-memory state of the erase tool (D5, T6.03): whether the tool is on, its options and the
 * rectangle drawn on the page (points, displayed frame, origin top-left). Nothing is saved here.
 */
import { create } from 'zustand';
import { DEFAULT_ERASE, type EraseOptions } from '../objects/objectModel';

export interface EraseRect {
  pageIndex: number;
  rect: [number, number, number, number];
}

interface EraseState {
  active: boolean;
  options: EraseOptions;
  rect: EraseRect | null;
  setActive(active: boolean): void;
  setOptions(patch: Partial<EraseOptions>): void;
  setRect(rect: EraseRect | null): void;
}

export const useEraseState = create<EraseState>((set) => ({
  active: false,
  options: DEFAULT_ERASE,
  rect: null,
  setActive(active) {
    set({ active, rect: null });
  },
  setOptions(patch) {
    set((s) => ({ options: { ...s.options, ...patch } }));
  },
  setRect(rect) {
    set({ rect });
  },
}));
