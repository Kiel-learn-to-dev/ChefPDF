import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useView, useViewStore } from '../../app/state/viewer';
import { IconButton } from '../../components/Button';
import { usePdfDocument } from './pdfCache';
import { getViewer } from './controllers';

/** Simple presentation mode: fullscreen, one page fitted to the screen, arrow keys to navigate. */
export function Presentation({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { pdf } = usePdfDocument(doc);
  const view = useView(doc.id);
  const [page, setPage] = useState(view.page);
  const [cursor, setCursor] = useState(true);
  const count = pdf?.numPages ?? view.pageCount;

  const exit = useCallback(() => {
    useUi.getState().set({ presenting: false });
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  const go = useCallback(
    (n: number) => setPage((p) => Math.max(1, Math.min(count || 1, p + n))),
    [count],
  );

  useEffect(() => {
    rootRef.current?.focus();
    rootRef.current?.requestFullscreen?.().catch(() => undefined);
    const onFs = () => !document.fullscreenElement && useUi.getState().set({ presenting: false });
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Sync the viewer to the last presented page.
  useEffect(() => {
    return () => {
      useViewStore.getState().patch(doc.id, { page });
      getViewer(doc.id)?.goToPage(page);
    };
  }, [doc.id, page]);

  useEffect(() => {
    let timer = setTimeout(() => setCursor(false), 2000);
    const onMove = () => {
      setCursor(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCursor(false), 2000);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    void (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1, rotation: (p.rotate + view.rotation) % 360 });
      const scale = Math.min(window.innerWidth / base.width, window.innerHeight / base.height);
      const dpr = window.devicePixelRatio || 1;
      const viewport = p.getViewport({
        scale: scale * dpr,
        rotation: (p.rotate + view.rotation) % 360,
      });
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      task = p.render({ canvas, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, view.rotation]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) go(1);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(-1);
    else if (e.key === 'Home') setPage(1);
    else if (e.key === 'End') setPage(count);
    else if (e.key === 'Escape') exit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={rootRef}
      className="presentation"
      tabIndex={-1}
      role="dialog"
      aria-label={t('viewer.presentation')}
      data-cursor={cursor ? 'visible' : 'hidden'}
      onKeyDown={onKeyDown}
      onClick={(e) =>
        e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS'
          ? go(1)
          : undefined
      }
    >
      <canvas ref={canvasRef} />
      <div className="presentation__hud">
        <IconButton
          size="sm"
          label={t('viewer.prevPage')}
          icon={<ChevronLeft size={16} />}
          onClick={() => go(-1)}
          tooltip={false}
        />
        <span>{t('status.pageOf', { page, count })}</span>
        <IconButton
          size="sm"
          label={t('viewer.nextPage')}
          icon={<ChevronRight size={16} />}
          onClick={() => go(1)}
          tooltip={false}
        />
        <IconButton
          size="sm"
          label={t('viewer.exitPresentation')}
          icon={<X size={16} />}
          onClick={exit}
          tooltip={false}
        />
      </div>
    </div>,
    document.body,
  );
}
