import { create } from 'zustand';

export type FindStatus = 'idle' | 'pending' | 'found' | 'notFound' | 'wrapped';

interface FindStore {
  query: string;
  matchDiacritics: boolean;
  entireWord: boolean;
  caseSensitive: boolean;
  status: FindStatus;
  current: number;
  total: number;
  set(patch: Partial<Omit<FindStore, 'set'>>): void;
}

export const useFind = create<FindStore>((set) => ({
  query: '',
  matchDiacritics: false,
  entireWord: false,
  caseSensitive: false,
  status: 'idle',
  current: 0,
  total: 0,
  set: (patch) => set(patch),
}));

/** pdf.js FindState -> FindStatus */
export function statusFromPdfjs(state: number): FindStatus {
  switch (state) {
    case 0:
      return 'found';
    case 1:
      return 'notFound';
    case 2:
      return 'wrapped';
    default:
      return 'pending';
  }
}
