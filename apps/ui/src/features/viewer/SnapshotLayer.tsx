import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUi } from '../../app/state/ui';
import { chef } from '../../lib/bridge';
import { toast } from '../../components/Toast';
import { captureRegion, normalizeRect, type Rect } from './snapshot';

/** Drag a rectangle over the pages to copy it as a PNG image (B5). */
export function SnapshotLayer({ getContainer }: { getContainer(): HTMLElement | null }) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && useUi.getState().set({ tool: 'select' });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const finish = async (r: Rect) => {
    const container = getContainer();
    if (!container || r.right - r.left < 4 || r.bottom - r.top < 4) return;
    const png = captureRegion(container, r);
    if (!png) return;
    try {
      await chef().clipboard.writeImagePng(png);
      toast.success(t('viewer.snapshotCopied'));
    } catch {
      toast.error(t('viewer.snapshotFailed'));
    }
  };

  return (
    <div
      ref={layerRef}
      className="snapshot-layer"
      role="application"
      aria-label={t('viewer.snapshotHint')}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY };
        setBox(e.currentTarget.getBoundingClientRect());
        setRect(normalizeRect(e.clientX, e.clientY, e.clientX, e.clientY));
      }}
      onPointerMove={(e) =>
        start.current &&
        setRect(normalizeRect(start.current.x, start.current.y, e.clientX, e.clientY))
      }
      onPointerUp={(e) => {
        if (!start.current) return;
        const r = normalizeRect(start.current.x, start.current.y, e.clientX, e.clientY);
        start.current = null;
        setRect(null);
        void finish(r);
      }}
      onWheel={(e) => {
        const c = getContainer();
        if (c) c.scrollTop += e.deltaY;
      }}
    >
      {!rect && <div className="snapshot-layer__hint">{t('viewer.snapshotHint')}</div>}
      {rect && box && (
        <div
          className="snapshot-layer__rect"
          style={{
            left: rect.left - box.left,
            top: rect.top - box.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
          }}
        />
      )}
    </div>
  );
}
