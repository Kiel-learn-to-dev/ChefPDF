/**
 * Placement of an overlay object on the page (D1, D2, F10): while a dialog waits for a position,
 * this layer takes the mouse over the viewer. A click places a point; a drag draws a box (only
 * for the modes that use a size). The result is top-left coordinates in points of the DISPLAYED
 * page (overlayModel.boxToTopLeft). Esc cancels and reopens the dialog.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Crosshair, RotateCcw, X } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { useViewStore } from '../../app/state/viewer';
import { Button, IconButton } from '../../components/Button';
import { MIN_BOX_PX, boxFromDrag } from '../sign/placementDrag';
import type { ScreenBox } from '../sign/placementGeometry';
import '../sign/sign.css';
import { boxToTopLeft, fromPt } from './overlayModel';
import { useOverlayState } from './overlayState';

interface PageBox {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  dispW: number;
  dispH: number;
}

interface Selection {
  page: number;
  box: ScreenBox;
}

function measure(container: HTMLElement, layer: DOMRect, doc: DocTab): PageBox[] {
  const out: PageBox[] = [];
  for (const el of container.querySelectorAll<HTMLElement>('.pdfViewer .page[data-page-number]')) {
    const index = Number(el.dataset.pageNumber) - 1;
    const page = doc.info.pages[index];
    if (!page) continue;
    const canvas = el.querySelector<HTMLCanvasElement>('canvas');
    const r = (canvas ?? el).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      index,
      left: r.left - layer.left,
      top: r.top - layer.top,
      width: r.width,
      height: r.height,
      scale: r.width / page.width,
      dispW: page.width,
      dispH: page.height,
    });
  }
  return out;
}

function pageAt(pages: PageBox[], x: number, y: number): PageBox | undefined {
  return pages.find(
    (p) => x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height,
  );
}

export function OverlayPlacementLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const request = useOverlayState((s) => s.request);
  const active = request?.docId === doc.id;
  const mode = request?.mode ?? 'point';
  const rotated = useViewStore((s) => (s.views[doc.id]?.rotation ?? 0) !== 0);
  const [pages, setPages] = useState<PageBox[]>([]);
  const [drag, setDrag] = useState<{
    page: number;
    start: { x: number; y: number };
    cur: { x: number; y: number };
  } | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const key = useRef('');

  const remeasure = () => {
    const container = getContainer();
    const layer = layerRef.current;
    if (!container || !layer) return;
    const next = measure(container, layer.getBoundingClientRect(), doc);
    const k = JSON.stringify(next);
    if (k !== key.current) {
      key.current = k;
      setPages(next);
    }
  };

  // Keep the page boxes in step with the viewer; measuring is guarded, so each render is safe.
  useLayoutEffect(() => {
    if (active) remeasure();
  });

  useEffect(() => {
    if (!active) return;
    const container = getContainer();
    if (!container) return;
    container.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);
    const ro = new ResizeObserver(remeasure);
    ro.observe(container);
    return () => {
      container.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc.id]);

  // A new request starts from a clean selection (reset while rendering, not in an effect).
  const requestKey = request ? `${request.docId}|${request.returnTo}|${request.mode}` : '';
  const [seenKey, setSeenKey] = useState(requestKey);
  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setSel(null);
    setDrag(null);
  }

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        useOverlayState.getState().cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  if (!active || !request) return null;
  const live = !rotated;

  const local = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!live || e.button !== 0) return;
    const pt = local(e);
    const page = pageAt(pages, pt.x, pt.y);
    if (!page) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = pt.x - page.left;
    const y = pt.y - page.top;
    setSel(null);
    setDrag({ page: page.index, start: { x, y }, cur: { x, y } });
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const page = pages.find((p) => p.index === drag.page);
    if (!page) return;
    const pt = local(e);
    setDrag({ ...drag, cur: { x: pt.x - page.left, y: pt.y - page.top } });
  };

  const onPointerUp = () => {
    if (!drag) return;
    const page = pages.find((p) => p.index === drag.page);
    setDrag(null);
    if (!page) return;
    const size = { width: page.width, height: page.height };
    const moved =
      Math.abs(drag.cur.x - drag.start.x) >= MIN_BOX_PX ||
      Math.abs(drag.cur.y - drag.start.y) >= MIN_BOX_PX;
    if (mode === 'box' && moved) {
      setSel({ page: page.index, box: boxFromDrag(drag.start, drag.cur, size, null) });
    } else {
      setSel({
        page: page.index,
        box: { left: drag.start.x, top: drag.start.y, width: 0, height: 0 },
      });
    }
  };

  const finish = () => {
    if (!sel) return;
    const page = pages.find((p) => p.index === sel.page);
    if (!page) return;
    const tl = boxToTopLeft(sel.box, page.dispW, page.dispH, page.scale);
    useOverlayState.getState().finish({
      docId: doc.id,
      returnTo: request.returnTo,
      pageIndex: page.index,
      x: tl.x,
      y: tl.y,
      width: mode === 'box' ? tl.width : 0,
      height: mode === 'box' ? tl.height : 0,
    });
  };

  const shownBox: { page: number; box: ScreenBox } | null =
    drag && !sel
      ? {
          page: drag.page,
          box:
            mode === 'box'
              ? boxFromDrag(
                  drag.start,
                  drag.cur,
                  pages.find((p) => p.index === drag.page) ?? { width: 1, height: 1 },
                  null,
                )
              : { left: drag.cur.x, top: drag.cur.y, width: 0, height: 0 },
        }
      : sel;

  const readout = (() => {
    if (!sel) return null;
    const page = pages.find((p) => p.index === sel.page);
    if (!page) return null;
    const tl = boxToTopLeft(sel.box, page.dispW, page.dispH, page.scale);
    return t('overlay.place.readout', {
      page: sel.page + 1,
      x: fromPt(tl.x, 'mm'),
      y: fromPt(tl.y, 'mm'),
    });
  })();

  return (
    <>
      <div
        ref={layerRef}
        className={`sign-layer${live ? ' sign-layer--place' : ''}`}
        data-testid="overlay-placement-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => {
          const c = getContainer();
          if (c) c.scrollTop += e.deltaY;
        }}
      >
        {pages.map((p) => {
          if (!shownBox || shownBox.page !== p.index) return null;
          const b = shownBox.box;
          if (b.width === 0 && b.height === 0) {
            return (
              <span
                key={p.index}
                className="ov-point"
                data-testid="overlay-point"
                style={{ left: p.left + b.left, top: p.top + b.top }}
              >
                <Crosshair size={18} aria-hidden />
              </span>
            );
          }
          return (
            <div
              key={p.index}
              className="sign-box"
              data-testid="overlay-box"
              style={{
                left: p.left + b.left,
                top: p.top + b.top,
                width: b.width,
                height: b.height,
              }}
            />
          );
        })}
        <div className="sign-layer__hint" aria-live="polite">
          {!live
            ? t('sign.place.rotatedHint')
            : mode === 'box'
              ? t('overlay.place.hintBox')
              : t('overlay.place.hintPoint')}
        </div>
      </div>
      <div className="ov-bar" role="toolbar" aria-label={t('overlay.place.barLabel')}>
        <span className="ov-bar__title">{t(`overlay.place.title.${request.returnTo}`)}</span>
        <span className="ov-bar__readout" aria-live="polite">
          {readout ?? t('overlay.place.noneYet')}
        </span>
        <span className="ov-bar__spacer" />
        <Button
          size="sm"
          icon={<RotateCcw size={14} />}
          disabled={!sel}
          onClick={() => setSel(null)}
        >
          {t('overlay.place.redo')}
        </Button>
        <IconButton
          size="sm"
          label={t('overlay.place.cancel')}
          icon={<X size={15} />}
          onClick={() => useOverlayState.getState().cancel()}
        />
        <Button
          size="sm"
          variant="primary"
          icon={<Check size={14} />}
          disabled={!sel || !live}
          onClick={finish}
        >
          {t('overlay.place.done')}
        </Button>
      </div>
    </>
  );
}
