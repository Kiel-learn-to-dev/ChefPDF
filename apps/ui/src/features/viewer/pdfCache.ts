import { useEffect } from 'react';
import { create } from 'zustand';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { chef } from '../../lib/bridge';
import type { DocTab } from '../../app/state/documents';
import { destroyPdf, loadPdf } from './pdfjs';

/**
 * One pdf.js document per open tab, shared by the viewer, thumbnails, page
 * organizer and print. Keyed by revision path; the previous proxy stays
 * available until the new revision has loaded (no flash on reload).
 */
interface Entry {
  key: string;
  pdf?: PDFDocumentProxy;
  error?: string;
}

interface PdfCacheState {
  entries: Record<string, Entry>;
}

const usePdfCache = create<PdfCacheState>(() => ({ entries: {} }));
const loading = new Map<string, string>();

function ensure(doc: DocTab) {
  const key = doc.state.revisionPath;
  const current = usePdfCache.getState().entries[doc.id];
  if (current?.key === key || loading.get(doc.id) === key) return;
  loading.set(doc.id, key);
  const url = chef().files.toUrl(key);
  loadPdf(url, { password: doc.password }).then(
    (pdf) => {
      if (loading.get(doc.id) !== key) {
        void destroyPdf(pdf);
        return;
      }
      loading.delete(doc.id);
      const old = usePdfCache.getState().entries[doc.id]?.pdf;
      usePdfCache.setState((s) => ({ entries: { ...s.entries, [doc.id]: { key, pdf } } }));
      // Let consumers switch to the new proxy before tearing down the old one.
      if (old) setTimeout(() => void destroyPdf(old), 1500);
    },
    (e: unknown) => {
      if (loading.get(doc.id) !== key) return;
      loading.delete(doc.id);
      usePdfCache.setState((s) => ({
        entries: {
          ...s.entries,
          [doc.id]: {
            key,
            pdf: s.entries[doc.id]?.pdf,
            error: e instanceof Error ? e.message : String(e),
          },
        },
      }));
    },
  );
}

/** Loaded pdf.js document for a tab (possibly the previous revision while the new one loads). */
export function usePdfDocument(doc: DocTab | undefined): {
  pdf: PDFDocumentProxy | undefined;
  error?: string;
  stale: boolean;
} {
  const entry = usePdfCache((s) => (doc ? s.entries[doc.id] : undefined));
  const revisionPath = doc?.state.revisionPath;
  useEffect(() => {
    if (doc) ensure(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, revisionPath]);
  return { pdf: entry?.pdf, error: entry?.error, stale: !!entry && entry.key !== revisionPath };
}

export function getPdf(docId: string): PDFDocumentProxy | undefined {
  return usePdfCache.getState().entries[docId]?.pdf;
}

/** Wait until the current revision of `doc` is loaded. */
export function whenPdfLoaded(doc: DocTab): Promise<PDFDocumentProxy> {
  ensure(doc);
  return new Promise((resolve, reject) => {
    const check = (s: PdfCacheState) => {
      const e = s.entries[doc.id];
      if (e?.key === doc.state.revisionPath && e.pdf) {
        unsub();
        resolve(e.pdf);
      } else if (e?.key === doc.state.revisionPath && e.error) {
        unsub();
        reject(new Error(e.error));
      }
    };
    const unsub = usePdfCache.subscribe(check);
    check(usePdfCache.getState());
  });
}

export function releasePdf(docId: string) {
  loading.delete(docId);
  const e = usePdfCache.getState().entries[docId];
  usePdfCache.setState((s) => {
    const entries = { ...s.entries };
    delete entries[docId];
    return { entries };
  });
  if (e?.pdf) void destroyPdf(e.pdf);
}
