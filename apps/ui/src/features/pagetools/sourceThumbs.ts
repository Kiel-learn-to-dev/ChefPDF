/** Thumbnails of every page of a local PDF (not an open tab), rendered with pdf.js. */
import { useEffect, useState } from 'react';
import { errorMessage } from '../../app/actions';
import { chef } from '../../lib/bridge';
import { destroyPdf, loadPdf } from '../viewer/pdfjs';
import { renderPageToCanvas } from '../viewer/thumbnails';

export interface SourceThumbs {
  urls: string[];
  error: string | null;
  loading: boolean;
}

interface Rendered {
  /** The path and password the thumbnails belong to. */
  key: string;
  urls: string[];
  error: string | null;
}

const THUMB_WIDTH = 110;
const NONE: SourceThumbs = { urls: [], error: null, loading: false };

/** Renders the pages of `path` to PNG data URLs; nothing leaves the machine. */
export function useSourceThumbs(path: string | null, password?: string): SourceThumbs {
  const key = path ? `${path}\u0000${password ?? ''}` : '';
  const [rendered, setRendered] = useState<Rendered>({ key: '', urls: [], error: null });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let pdf: Awaited<ReturnType<typeof loadPdf>> | undefined;
    (async () => {
      try {
        pdf = await loadPdf(chef().files.toUrl(path), { password });
        const urls: string[] = [];
        for (let i = 0; i < pdf.numPages && alive; i++) {
          const canvas = await renderPageToCanvas(pdf, i, THUMB_WIDTH);
          urls.push(canvas.toDataURL('image/png'));
        }
        if (alive) setRendered({ key, urls, error: null });
      } catch (e) {
        if (alive) setRendered({ key, urls: [], error: errorMessage(e) });
      }
    })();
    return () => {
      alive = false;
      if (pdf) void destroyPdf(pdf).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key already covers path and password
  }, [key]);
  if (!path) return NONE;
  // Results of an earlier path are not shown: the view is loading until this path has rendered.
  if (rendered.key !== key) return { urls: [], error: null, loading: true };
  return { urls: rendered.urls, error: rendered.error, loading: false };
}
