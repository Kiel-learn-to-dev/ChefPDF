/**
 * Drawing layer of a new link (D11, T7.05): while the drawing mode is on, a drag over a page draws
 * the rectangle of the link; releasing it opens the link form with that rect. Esc cancels. Nothing
 * changes the document until the form is saved.
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import { dragRect, isLinkSized } from './linksModel';
import { useLinkDraw } from './linkState';
import './links.css';

interface Drag {
  page: MeasuredPage;
  start: { x: number; y: number };
  cur: { x: number; y: number };
}

export function LinkDrawLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const drawing = useLinkDraw((s) => s.drawing);
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setDrag(null);
      useLinkDraw.getState().setDrawing(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drawing]);

  if (!drawing) return null;

  const measure = (): MeasuredPage[] => {
    const container = getContainer();
    const layer = layerRef.current;
    return container && layer ? measurePages(container, layer.getBoundingClientRect(), doc) : [];
  };
  const local = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = local(e);
    const page = pageAt(measure(), p.x, p.y);
    if (!page) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ page, start: pagePt(page, p), cur: pagePt(page, p) });
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ ...drag, cur: pagePt(drag.page, local(e)) });
  };
  const onUp = () => {
    if (!drag) return;
    const rect = dragRect(drag.start, drag.cur);
    setDrag(null);
    if (!isLinkSized(rect)) return;
    const draw = useLinkDraw.getState();
    draw.setPending({ pageIndex: drag.page.index, rect });
    draw.setDrawing(false);
    useUi.getState().openDialog('linkDialog');
  };

  // The band in layer px, from the page origin and scale.
  const band =
    drag &&
    (() => {
      const [l, t2, r, b] = dragRect(drag.start, drag.cur);
      const s = drag.page.scale;
      return {
        left: drag.page.left + l! * s,
        top: drag.page.top + t2! * s,
        width: (r! - l!) * s,
        height: (b! - t2!) * s,
      };
    })();

  return (
    <div
      ref={layerRef}
      className="link-draw"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      role="application"
      aria-label={t('links.drawHint')}
    >
      <div className="link-draw__hint" role="status">
        {t('links.drawHint')}
      </div>
      {band && (
        <div
          className="link-draw__band"
          style={{ left: band.left, top: band.top, width: band.width, height: band.height }}
        />
      )}
    </div>
  );
}
