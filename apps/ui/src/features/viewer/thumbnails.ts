import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocTab } from '../../app/state/documents';

/**
 * Lazily rendered page thumbnails shared by the sidebar and the page organizer.
 * Cached per document; after an op only `changedPages` are dropped when the core
 * reports a page list, everything when it reports 'all'.
 */

interface DocCache {
  version: number;
  pages: Map<string, string>; // `${pageIndex}@${width}` -> object URL
}

const cache = new Map<string, DocCache>();

/** Images may still be on screen until their replacement renders. */
function revokeLater(url: string) {
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function docCache(doc: DocTab): DocCache {
  let c = cache.get(doc.id);
  if (!c) {
    c = { version: doc.version, pages: new Map() };
    cache.set(doc.id, c);
  }
  if (c.version !== doc.version) {
    const changed = doc.lastChange;
    if (changed === 'all' || doc.version - c.version > 1) {
      c.pages.forEach(revokeLater);
      c.pages.clear();
    } else {
      for (const [key, url] of [...c.pages]) {
        if (changed.includes(Number(key.split('@')[0]))) {
          revokeLater(url);
          c.pages.delete(key);
        }
      }
    }
    c.version = doc.version;
  }
  return c;
}

export function dropThumbnails(docId: string) {
  cache.get(docId)?.pages.forEach((url) => URL.revokeObjectURL(url));
  cache.delete(docId);
}

// Small render queue so scrolling through hundreds of pages stays smooth.
const MAX_CONCURRENT = 2;
let running = 0;
const queue: (() => void)[] = [];

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

export async function renderPageToCanvas(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  cssWidth: number,
  dpr = window.devicePixelRatio || 1,
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('toBlob failed'))),
      'image/png',
    ),
  );
}

export function useThumbnail(
  doc: DocTab,
  pdf: PDFDocumentProxy | undefined,
  pageIndex: number,
  width: number,
  visible: boolean,
): string | undefined {
  const key = `${pageIndex}@${width}`;
  const cached = docCache(doc).pages.get(key);
  // Last image rendered by this hook: shown while a newer revision renders (no flash).
  const [rendered, setRendered] = useState<string | undefined>(undefined);
  const version = doc.version;

  useEffect(() => {
    const c = docCache(doc);
    if (c.pages.has(key) || !visible || !pdf || pageIndex >= pdf.numPages) return;
    let cancelled = false;
    schedule(async () => {
      if (cancelled) return undefined;
      const canvas = await renderPageToCanvas(pdf, pageIndex, width);
      return canvasToUrl(canvas);
    })
      .then((u) => {
        if (!u) return;
        // Only cache when the pdf matches the doc's current version.
        if (docCache(doc).version === version) c.pages.set(key, u);
        if (!cancelled) setRendered(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, version, pdf, key, visible]);

  return cached ?? rendered;
}

/** IntersectionObserver-based visibility for lazy rendering. */
export function useInView<T extends Element>(
  rootMargin = '300px',
): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setInView(true)),
      {
        rootMargin,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, rootMargin]);
  return [setEl, inView];
}
