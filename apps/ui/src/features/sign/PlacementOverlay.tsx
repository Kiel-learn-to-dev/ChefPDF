/**
 * Signature box on the pages (T3.12): the layer over the viewer and the bar with its actions.
 * The layer draws the box and the anchor previews. In placement mode it takes the mouse: draw,
 * move, resize, or pick a preview. Screen px inside the page image are converted to PDF user space
 * by placementGeometry.ts (the single place where the mapping is defined).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FileSignature, ListChecks, PenLine, X } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useViewStore } from '../../app/state/viewer';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, TextInput } from '../../components/Form';
import { toast } from '../../components/Toast';
import {
  addEmptyField,
  listEmptyFields,
  pageGeomOf,
  rememberBoxSize,
  type FieldInfo,
} from './signActions';
import {
  MIN_BOX_PX,
  boxFromDrag,
  handlePoints,
  moveBox,
  resizeBox,
  type Handle,
} from './placementDrag';
import {
  boxSizeMm,
  screenBoxToUserRect,
  userRectToScreen,
  type PageGeom,
  type ScreenBox,
} from './placementGeometry';
import { usePlacementStore, usePlacementOf, type PlacedBox } from './placementStore';
import { useSignDraft, type PlacementMode } from './signDraft';

const MODE_OF_SOURCE: Record<PlacedBox['source'], PlacementMode> = {
  draw: 'draw',
  field: 'field',
  anchor: 'anchor',
  fixed: 'fixed',
};
import './sign.css';

/** Aspect of a new box when "keep proportions" is on: 2.5 : 1 (a typical signature box). */
const LOCKED_ASPECT = 2.5;

interface PageBox {
  index: number;
  /** Page image position inside the layer (px). */
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  geom: PageGeom;
}

type Drag =
  | { kind: 'create'; page: number; start: { x: number; y: number }; aspect: number | null }
  | { kind: 'move'; page: number; start: { x: number; y: number }; orig: ScreenBox }
  | {
      kind: 'resize';
      page: number;
      handle: Handle;
      start: { x: number; y: number };
      orig: ScreenBox;
      aspect: number | null;
    };

/** Pages of the viewer as boxes relative to the layer (only pages with a known size). */
function measurePages(container: HTMLElement, layer: DOMRect, doc: DocTab): PageBox[] {
  const out: PageBox[] = [];
  for (const el of container.querySelectorAll<HTMLElement>('.pdfViewer .page[data-page-number]')) {
    const index = Number(el.dataset.pageNumber) - 1;
    const geom = pageGeomOf(doc, index);
    if (!geom) continue;
    const canvas = el.querySelector<HTMLCanvasElement>('canvas');
    const r = (canvas ?? el).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      index,
      left: r.left - layer.left,
      top: r.top - layer.top,
      width: r.width,
      height: r.height,
      scale: r.width / geom.dispW,
      geom,
    });
  }
  return out;
}

function pageAt(pages: PageBox[], x: number, y: number): PageBox | undefined {
  return pages.find(
    (p) => x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height,
  );
}

function boxOnPage(p: PageBox, rect: PlacedBox['rect']): ScreenBox {
  return userRectToScreen(rect, p.geom, p.scale);
}

function insideBox(b: ScreenBox, x: number, y: number): boolean {
  return x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/** The layer (pointer events only in placement mode) and the bar next to it. */
export function PlacementOverlay({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const docId = doc.id;
  const layerRef = useRef<HTMLDivElement>(null);
  const placing = usePlacementStore((s) => s.placingDocId === docId);
  const { placement, previews, selected } = usePlacementOf(docId);
  const scale = useViewStore((s) => s.views[docId]?.scale);
  // A rotated view would shift the boxes: placement needs the view at 0 degrees.
  const viewRotated = useViewStore((s) => (s.views[docId]?.rotation ?? 0) !== 0);
  const [pages, setPages] = useState<PageBox[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState<{ page: number; box: ScreenBox } | null>(null);
  const [aspectLock, setAspectLock] = useState(false);
  const pagesKey = useRef('');

  const measure = () => {
    const container = getContainer();
    const layer = layerRef.current;
    if (!container || !layer) return;
    const next = measurePages(container, layer.getBoundingClientRect(), doc);
    const key = JSON.stringify(next);
    // Only a real change re-renders (the measure runs after renders).
    if (key !== pagesKey.current) {
      pagesKey.current = key;
      setPages(next);
    }
  };

  // Re-measure after renders that can move the pages (zoom, revision, placement changes).
  // The measure is guarded (it sets state only when the pages changed), so every render is safe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [scale, doc.info, doc.state.revision, placement, previews, placing]);

  useEffect(() => {
    const container = getContainer();
    if (!container) return;
    const onScroll = () => measure();
    container.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(container);
    window.addEventListener('resize', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Esc leaves placement mode; Delete removes the box. Only while placing.
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        usePlacementStore.getState().stopPlacing();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e.target)) {
        usePlacementStore.getState().setPlacement(docId, null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing, docId]);

  const local = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!placing || viewRotated || e.button !== 0) return;
    const pt = local(e);
    // A preview box picks that match.
    const hit = previews.findIndex((pv) => {
      const p = pages.find((x) => x.index === pv.pageIndex);
      return !!p && insideBox(boxOnPage(p, pv.rect), pt.x - p.left, pt.y - p.top);
    });
    if (hit >= 0) {
      usePlacementStore.getState().selectPreview(docId, hit);
      return;
    }
    const cur = placement ? pages.find((p) => p.index === placement.pageIndex) : undefined;
    if (placement && cur) {
      const orig = boxOnPage(cur, placement.rect);
      const x = pt.x - cur.left;
      const y = pt.y - cur.top;
      const handle = handlePoints(orig).find(
        (h) => Math.abs(h.x - x) <= 6 && Math.abs(h.y - y) <= 6,
      );
      const aspect = aspectLock ? LOCKED_ASPECT : null;
      if (handle) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({
          kind: 'resize',
          page: cur.index,
          handle: handle.handle,
          start: { x, y },
          orig,
          aspect,
        });
        setLive({ page: cur.index, box: orig });
        return;
      }
      if (insideBox(orig, x, y)) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ kind: 'move', page: cur.index, start: { x, y }, orig });
        setLive({ page: cur.index, box: orig });
        return;
      }
    }
    const page = pageAt(pages, pt.x, pt.y);
    if (!page) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = pt.x - page.left;
    const y = pt.y - page.top;
    setDrag({
      kind: 'create',
      page: page.index,
      start: { x, y },
      aspect: aspectLock ? LOCKED_ASPECT : null,
    });
    setLive({ page: page.index, box: { left: x, top: y, width: 0, height: 0 } });
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const page = pages.find((p) => p.index === drag.page);
    if (!page) return;
    const pt = local(e);
    const x = pt.x - page.left;
    const y = pt.y - page.top;
    const size = { width: page.width, height: page.height };
    let box: ScreenBox;
    if (drag.kind === 'create') box = boxFromDrag(drag.start, { x, y }, size, drag.aspect);
    else if (drag.kind === 'move')
      box = moveBox(drag.orig, x - drag.start.x, y - drag.start.y, size);
    else
      box = resizeBox(
        drag.orig,
        drag.handle,
        x - drag.start.x,
        y - drag.start.y,
        size,
        drag.aspect,
      );
    setLive({ page: drag.page, box });
  };

  const onPointerUp = () => {
    const finished = drag;
    const current = live;
    setDrag(null);
    setLive(null);
    if (!finished || !current) return;
    const page = pages.find((p) => p.index === current.page);
    if (!page) return;
    const box = current.box;
    if (finished.kind === 'create' && (box.width < MIN_BOX_PX || box.height < MIN_BOX_PX)) return;
    const rect = screenBoxToUserRect(box, page.geom, page.scale);
    usePlacementStore
      .getState()
      .setPlacement(docId, { pageIndex: page.index, rect, source: 'draw' });
    const mm = boxSizeMm(box.width, box.height, page.scale);
    void rememberBoxSize(mm.w, mm.h);
  };

  /** The box to draw on a page: the live one while dragging, else the stored placement. */
  const shown = (p: PageBox): ScreenBox | null => {
    const fresh = drag?.kind === 'create' && live && live.box.width === 0 && live.box.height === 0;
    if (live && live.page === p.index && !fresh) return live.box;
    if (placement && placement.pageIndex === p.index) return boxOnPage(p, placement.rect);
    return null;
  };

  return (
    <>
      <div
        ref={layerRef}
        className={`sign-layer${placing && !viewRotated ? ' sign-layer--place' : ''}`}
        data-testid="placement-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => {
          const c = getContainer();
          if (c && placing) c.scrollTop += e.deltaY;
        }}
      >
        {pages.map((p) => {
          const box = shown(p);
          const showHandles = placing && !!box && placement?.pageIndex === p.index;
          return (
            <div key={p.index} className="sign-layer__page">
              {previews
                .map((pv, i) => ({ pv, i }))
                .filter(({ pv }) => pv.pageIndex === p.index)
                .map(({ pv, i }) => {
                  const b = boxOnPage(p, pv.rect);
                  return (
                    <div
                      key={`pv-${i}`}
                      className={`sign-box sign-box--preview${i === selected ? ' is-selected' : ''}`}
                      style={{
                        left: p.left + b.left,
                        top: p.top + b.top,
                        width: b.width,
                        height: b.height,
                      }}
                      data-testid="anchor-preview"
                    />
                  );
                })}
              {box && (
                <div
                  className={`sign-box${placement?.fieldName ? ' sign-box--field' : ''}`}
                  style={{
                    left: p.left + box.left,
                    top: p.top + box.top,
                    width: box.width,
                    height: box.height,
                  }}
                  data-testid="placement-box"
                >
                  {box.width > 60 && box.height > 16 && (
                    <span className="sign-box__size">
                      {t('sign.place.sizeMm', {
                        w: boxSizeMm(box.width, box.height, p.scale).w,
                        h: boxSizeMm(box.width, box.height, p.scale).h,
                      })}
                    </span>
                  )}
                </div>
              )}
              {showHandles &&
                box &&
                handlePoints(box).map((h) => (
                  <span
                    key={h.handle}
                    className="sign-handle"
                    data-handle={h.handle}
                    style={{ left: p.left + h.x, top: p.top + h.y }}
                  />
                ))}
            </div>
          );
        })}
        {placing && (
          <div className="sign-layer__hint" aria-live="polite">
            {viewRotated ? t('sign.place.rotatedHint') : t('sign.place.hint')}
          </div>
        )}
      </div>
      {placing && <PlacementBar doc={doc} aspectLock={aspectLock} onAspectLock={setAspectLock} />}
    </>
  );
}

/** The bar with the placement actions. A sibling of the layer, so its clicks do not draw. */
export function PlacementBar({
  doc,
  aspectLock,
  onAspectLock,
}: {
  doc: DocTab;
  aspectLock: boolean;
  onAspectLock(v: boolean): void;
}) {
  const { t } = useTranslation();
  const docId = doc.id;
  const { placement } = usePlacementOf(docId);
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const stop = () => usePlacementStore.getState().stopPlacing();

  const chooseField = (f: FieldInfo) => {
    if (!f.rect) return;
    const [x1, y1, x2, y2] = f.rect as [number, number, number, number];
    usePlacementStore.getState().setPlacement(docId, {
      pageIndex: f.page,
      rect: [x1, y1, x2, y2],
      fieldName: f.fieldName,
      source: 'field',
    });
    setFields(null);
  };

  const openFields = async () => {
    try {
      setFields(await listEmptyFields(docId));
    } catch (e) {
      toast.error(t('sign.place.fieldsFailed'), errorMessage(e));
    }
  };

  const addField = async () => {
    if (!placement || placement.fieldName) return;
    setBusy(true);
    try {
      const name = await addEmptyField(docId, placement, label);
      if (name) {
        usePlacementStore.getState().setPlacement(docId, { ...placement, fieldName: name });
        setLabel('');
        toast.success(t('sign.place.fieldAdded'), name);
      }
    } finally {
      setBusy(false);
    }
  };

  const signHere = () => {
    stop();
    if (!placement) return;
    // The dialog shows the box the user made: the mode follows where the box came from.
    useSignDraft.getState().patch({ placementMode: MODE_OF_SOURCE[placement.source] });
    useUi.getState().openDialog('signDoc');
  };

  return (
    <div className="sign-bar" role="toolbar" aria-label={t('sign.place.barLabel')}>
      <span className="sign-bar__title">
        <PenLine size={16} aria-hidden /> {t('sign.place.title')}
      </span>
      <Checkbox checked={aspectLock} onChange={onAspectLock} label={t('sign.place.aspectLock')} />
      <Button
        size="sm"
        icon={<ListChecks size={14} />}
        onClick={() => void openFields()}
        aria-expanded={fields !== null}
      >
        {t('sign.place.pickField')}
      </Button>
      <div className="sign-bar__add">
        <TextInput
          size="sm"
          aria-label={t('sign.place.label')}
          placeholder={t('sign.place.labelPlaceholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button
          size="sm"
          loading={busy}
          disabled={!placement || !!placement.fieldName}
          onClick={() => void addField()}
        >
          {t('sign.place.addEmpty')}
        </Button>
      </div>
      <span className="sign-bar__spacer" />
      <IconButton size="sm" label={t('sign.place.cancel')} icon={<X size={15} />} onClick={stop} />
      <Button
        size="sm"
        variant="primary"
        icon={<FileSignature size={14} />}
        disabled={!placement}
        onClick={signHere}
        title={placement ? undefined : t('sign.place.needBox')}
      >
        {t('sign.place.signHere')}
      </Button>
      {fields !== null && (
        <div className="sign-bar__fields" role="listbox" aria-label={t('sign.place.fieldsTitle')}>
          {fields.length === 0 ? (
            <p className="sign-bar__none">{t('sign.place.noFields')}</p>
          ) : (
            fields.map((f) => (
              <button
                key={f.fieldName}
                type="button"
                role="option"
                aria-selected={placement?.fieldName === f.fieldName}
                className="sign-bar__field"
                onClick={() => chooseField(f)}
              >
                <Check size={13} aria-hidden /> {f.fieldName}
                <span className="sign-bar__page">
                  {t('sign.place.pageOf', { page: f.page + 1 })}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
