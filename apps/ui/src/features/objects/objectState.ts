/**
 * In-memory state of the object edit mode (not saved): whether the mode is on, the selection, the
 * view-by-type filter (E2) and the objects of the pages loaded for the current revision.
 *
 * The page cache is keyed by `<doc id>:<revision version>`: a response for another key (an older
 * revision, another document) is dropped, so a slow listObjects cannot put stale objects on screen.
 */
import { create } from 'zustand';
import type { ObjectKind, PageObject, ViewByTypeData } from './objectModel';

interface ObjectEditState {
  /** Object edit mode is on (the toolbar toggle). */
  active: boolean;
  selected: string[];
  /** Objects of the loaded pages, by 0-based page index. */
  objects: Record<number, PageObject[]>;
  /** Kinds shown by the view-by-type filter (E2); null when the filter is off. */
  kinds: ObjectKind[] | null;
  /** View-by-type summaries of the loaded pages (only while the filter is on). */
  types: Record<number, ViewByTypeData>;
  /** Key of the revision the cache belongs to. */
  key: string;
  setActive(active: boolean): void;
  setSelected(ids: string[]): void;
  setKinds(kinds: ObjectKind[] | null): void;
  /** Starts a new cache for a revision (drops every page). */
  resetFor(key: string): void;
  setPage(key: string, index: number, objects: PageObject[]): void;
  setTypes(key: string, index: number, data: ViewByTypeData): void;
}

export const useObjectEdit = create<ObjectEditState>((set) => ({
  active: false,
  selected: [],
  objects: {},
  kinds: null,
  types: {},
  key: '',
  setActive(active) {
    set(active ? { active } : { active, selected: [] });
  },
  setSelected(ids) {
    set({ selected: ids });
  },
  setKinds(kinds) {
    set({ kinds, types: {} });
  },
  resetFor(key) {
    set((s) => {
      if (s.key === key) return s;
      // Another revision of the same document keeps the selection (an edit remaps it); another
      // document drops it.
      const sameDoc = s.key.split(':')[0] === key.split(':')[0];
      return { key, objects: {}, types: {}, ...(sameDoc ? {} : { selected: [] }) };
    });
  },
  setPage(key, index, objects) {
    set((s) => (s.key !== key ? s : { objects: { ...s.objects, [index]: objects } }));
  },
  setTypes(key, index, data) {
    set((s) => (s.key !== key ? s : { types: { ...s.types, [index]: data } }));
  },
}));

/** Objects of the selection, looked up in the loaded pages. */
export function selectedObjects(
  objects: Record<number, PageObject[]>,
  selected: readonly string[],
): PageObject[] {
  const ids = new Set(selected);
  return Object.values(objects)
    .flat()
    .filter((o) => ids.has(o.id));
}
