/** Draw a form field rectangle directly on a displayed PDF page. */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import { useFormDraw } from './formDrawState';
import './forms.css';

interface Drag {
  page: MeasuredPage;
  start: { x: number; y: number };
  current: { x: number; y: number };
}

const sortedRect = (a: { x: number; y: number }, b: { x: number; y: number }) => [
  Math.min(a.x, b.x),
  Math.min(a.y, b.y),
  Math.max(a.x, b.x),
  Math.max(a.y, b.y),
];

export function FormDrawLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const drawing = useFormDraw((s) => s.drawing);
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!drawing) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setDrag(null);
      useFormDraw.getState().setDrawing(false);
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [drawing]);

  if (!drawing) return null;
  const pages = () => {
    const container = getContainer();
    const layer = layerRef.current;
    return container && layer ? measurePages(container, layer.getBoundingClientRect(), doc) : [];
  };
  const point = (event: RPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const down = (event: RPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const p = point(event);
    const page = pageAt(pages(), p.x, p.y);
    if (!page) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = pagePt(page, p);
    setDrag({ page, start, current: start });
  };
  const move = (event: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ ...drag, current: pagePt(drag.page, point(event)) });
  };
  const up = () => {
    if (!drag) return;
    const rect = sortedRect(drag.start, drag.current);
    setDrag(null);
    if (rect[2]! - rect[0]! < 14 || rect[3]! - rect[1]! < 14) return;
    useFormDraw.getState().setPending({ pageIndex: drag.page.index, rect });
    useFormDraw.getState().setDrawing(false);
    useUi.getState().openDialog('forms');
  };
  const band =
    drag &&
    (() => {
      const rect = sortedRect(drag.start, drag.current);
      const scale = drag.page.scale;
      return {
        left: drag.page.left + rect[0]! * scale,
        top: drag.page.top + rect[1]! * scale,
        width: (rect[2]! - rect[0]!) * scale,
        height: (rect[3]! - rect[1]!) * scale,
      };
    })();

  return (
    <div
      ref={layerRef}
      className="form-draw"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      role="application"
      aria-label={t('forms.drawHint')}
    >
      <div className="form-draw__hint" role="status">
        {t('forms.drawHint')}
      </div>
      {band && (
        <div
          className="form-draw__band"
          style={{ left: band.left, top: band.top, width: band.width, height: band.height }}
        />
      )}
    </div>
  );
}
