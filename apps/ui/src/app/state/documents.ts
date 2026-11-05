import { create } from 'zustand';
import type { ChangedPages, DocumentInfo, SessionState } from '@chef/contracts';

export interface DocTab {
  /** = sessionId */
  id: string;
  name: string;
  state: SessionState;
  info: DocumentInfo;
  /** Kept in memory only (pdf.js fallback for encrypted working copies, insert/merge inputs). Never persisted or logged. */
  password?: string;
  /** Increments on every new revision so views reload. */
  version: number;
  lastChange: ChangedPages;
  /** Number of running operations on this document. */
  busy: number;
}

interface DocsState {
  docs: DocTab[];
  /** null = start screen. */
  activeId: string | null;
  /** The About tab is open over the start screen or the active document (1.2). */
  aboutOpen: boolean;
  add(doc: Omit<DocTab, 'version' | 'lastChange' | 'busy'>): void;
  remove(id: string): void;
  /** Activates a document, or the start screen (null). Either one leaves the About tab. */
  activate(id: string | null): void;
  openAbout(): void;
  update(id: string, patch: Partial<DocTab>): void;
  /** Apply a new session state (after an op, undo/redo or save). */
  applyState(id: string, state: SessionState, changed: ChangedPages, info?: DocumentInfo): void;
  setBusy(id: string, delta: 1 | -1): void;
  move(id: string, toIndex: number): void;
}

export const useDocs = create<DocsState>((set) => ({
  docs: [],
  activeId: null,
  aboutOpen: false,

  add(doc) {
    set((s) => ({
      docs: [...s.docs, { ...doc, version: 0, lastChange: 'all', busy: 0 }],
      activeId: doc.id,
      aboutOpen: false,
    }));
  },

  remove(id) {
    set((s) => {
      const idx = s.docs.findIndex((d) => d.id === id);
      const docs = s.docs.filter((d) => d.id !== id);
      let activeId = s.activeId;
      if (activeId === id) activeId = docs[Math.min(idx, docs.length - 1)]?.id ?? null;
      return { docs, activeId };
    });
  },

  activate(id) {
    set({ activeId: id, aboutOpen: false });
  },

  openAbout() {
    set({ aboutOpen: true });
  },

  update(id, patch) {
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
  },

  applyState(id, state, changed, info) {
    set((s) => ({
      docs: s.docs.map((d) => {
        if (d.id !== id) return d;
        const revisionChanged =
          state.revisionPath !== d.state.revisionPath || state.revision !== d.state.revision;
        return {
          ...d,
          state,
          info: info ?? d.info,
          version: revisionChanged ? d.version + 1 : d.version,
          lastChange: revisionChanged ? changed : d.lastChange,
        };
      }),
    }));
  },

  setBusy(id, delta) {
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id ? { ...d, busy: Math.max(0, d.busy + delta) } : d)),
    }));
  },

  move(id, toIndex) {
    set((s) => {
      const docs = [...s.docs];
      const from = docs.findIndex((d) => d.id === id);
      if (from < 0) return s;
      const [doc] = docs.splice(from, 1);
      docs.splice(Math.max(0, Math.min(toIndex, docs.length)), 0, doc!);
      return { docs };
    });
  },
}));

export const selectActiveDoc = (s: DocsState): DocTab | undefined =>
  s.docs.find((d) => d.id === s.activeId);

export function useActiveDoc(): DocTab | undefined {
  return useDocs(selectActiveDoc);
}

export function getDoc(id: string): DocTab | undefined {
  return useDocs.getState().docs.find((d) => d.id === id);
}
