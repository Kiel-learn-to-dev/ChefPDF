/**
 * In-memory state of the annotation tools and of the annotation list (not saved): the drawing
 * tool in use, its colour, opacity and kinds, the list of the document's annotations and the
 * filter of the list.
 */
import { create } from 'zustand';
import {
  EMPTY_FILTER,
  PALETTE,
  type AnnotFilter,
  type AnnotItem,
  type MarkupKind,
  type ShapeKind,
} from './annotModel';

export type AnnotTool = 'none' | 'note' | 'freetext' | 'ink' | 'shape';

interface AnnotUiState {
  tool: AnnotTool;
  shape: ShapeKind;
  markup: MarkupKind;
  color: string;
  opacity: number;
  /** Annotations of the document (annots.list), refreshed after each change. */
  items: AnnotItem[];
  filter: AnnotFilter;
  selectedId: string | null;
  setTool(tool: AnnotTool): void;
  set(
    patch: Partial<
      Pick<AnnotUiState, 'shape' | 'markup' | 'color' | 'opacity' | 'filter' | 'selectedId'>
    >,
  ): void;
  setItems(items: AnnotItem[]): void;
}

export const useAnnotUi = create<AnnotUiState>((set) => ({
  tool: 'none',
  shape: 'arrow',
  markup: 'highlight',
  color: PALETTE[0],
  opacity: 1,
  items: [],
  filter: EMPTY_FILTER,
  selectedId: null,
  setTool(tool) {
    set({ tool });
  },
  set(patch) {
    set(patch);
  },
  setItems(items) {
    set({ items });
  },
}));
