/**
 * Object edit layer over the viewer (D4, T6.02) and the view-by-type overlay (E2).
 *
 * In object mode the layer takes the mouse: click selects the topmost object (Alt cycles the
 * overlapped ones, Shift toggles, Ctrl selects a range), dragging a selected object moves it, a drag
 * on empty space draws a rubber band. Keys: arrows nudge 1 pt (Shift 10 pt), Delete removes,
 * Ctrl+D duplicates, Esc clears. Nothing changes the document until the operation is run: a drag
 * only shows the displacement until the mouse is released.
 *
 * The view-by-type filter draws the objects of the chosen kinds over a dimmed page; it changes no
 * document (pure overlay). Mounted by Viewer.tsx.
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useViewStore } from '../../app/state/viewer';
import { showError } from '../../app/actions';
import { toast } from '../../components/Toast';
import { isEditableTarget } from '../../lib/shortcuts';
import { useEraseState } from '../erase/eraseState';
import { clearSelection, startDraft } from '../textedit/textEditActions';
import { useTextEdit } from '../textedit/textEditState';
import {
  addIds,
  bboxToPageBox,
  toggleId,
  hitObjects,
  nudgeFor,
  objectsInRect,
  pickHit,
  pxDeltaToPt,
  rangeIds,
  normRectPt,
  type ObjectKind,
  type PageObject,
} from './objectModel';
import {
  deleteSelection,
  duplicateSelection,
  listPageObjects,
  listPageTypes,
  moveSelection,
} from './objectActions';
import { useObjectEdit } from './objectState';
import { measurePages, pageAt, pagePt, type MeasuredPage } from './pageMeasure';
import './objects.css';

/** Most boxes drawn per page: keeps very large pages responsive (the list stays complete). */
const MAX_BOXES = 2000;
const DRAG_PX = 3;

interface Drag {
  mode: 'move' | 'band';
  page: MeasuredPage;
  start: { x: number; y: number };
  cur: { x: number; y: number };
  moved: boolean;
  additive: boolean;
}

const KIND_KEYS: ObjectKind[] = ['text', 'image', 'path', 'shading', 'form'];

/**
 * The objects the layer answers for. In the Sửa chữ mode (D66) the text runs are not objects here:
 * the text part draws one outline per paragraph and answers for the text (D67).
 */
function answering(list: PageObject[]): PageObject[] {
  return useTextEdit.getState().active ? list.filter((o) => o.kind !== 'text') : list;
}

export function ObjectLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const active = useObjectEdit((s) => s.active);
  const kinds = useObjectEdit((s) => s.kinds);
  const objects = useObjectEdit((s) => s.objects);
  const types = useObjectEdit((s) => s.types);
  const selected = useObjectEdit((s) => s.selected);
  const eraseActive = useEraseState((s) => s.active);
  const tool = useUi((s) => s.tool);
  const rotated = useViewStore((s) => (s.views[doc.id]?.rotation ?? 0) !== 0);
  const blocked = doc.state.signed;
  const cacheKey = `${doc.id}:${doc.version}`;
  const [pages, setPages] = useState<MeasuredPage[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const measureKey = useRef('');
  const visibleKey = pages
    .filter((p) => p.visible)
    .map((p) => p.index)
    .join(',');

  // A new revision (or document) starts with an empty page cache.
  useEffect(() => {
    useObjectEdit.getState().resetFor(cacheKey);
  }, [cacheKey]);

  const remeasure = () => {
    const container = getContainer();
    const layer = layerRef.current;
    if (!container || !layer) return;
    const next = measurePages(container, layer.getBoundingClientRect(), doc);
    const k = JSON.stringify(next);
    if (k !== measureKey.current) {
      measureKey.current = k;
      setPages(next);
    }
  };

  useLayoutEffect(() => {
    if (active || kinds) remeasure();
  });

  useEffect(() => {
    if (!active && !kinds) return;
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
  }, [active, !!kinds, doc.id]);

  // Load the visible pages (debounced) for the current revision.
  useEffect(() => {
    if (!active && !kinds) return;
    const wanted = visibleKey ? visibleKey.split(',').map(Number) : [];
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const index of wanted) {
          if (cancelled) return;
          const st = useObjectEdit.getState();
          if (st.key !== cacheKey) return;
          try {
            if (active && !st.objects[index]) {
              const objs = await listPageObjects(doc.id, index);
              if (!cancelled) useObjectEdit.getState().setPage(cacheKey, index, objs);
            }
            if (kinds && !useObjectEdit.getState().types[index]) {
              const data = await listPageTypes(doc.id, index);
              if (!cancelled) useObjectEdit.getState().setTypes(cacheKey, index, data);
            }
          } catch (e) {
            if (!cancelled) showError(e);
            return;
          }
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, kinds, cacheKey, visibleKey, doc.id]);

  // Keys of the mode: capture phase, so the global shortcuts do not run on the same key.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      const sel = useObjectEdit.getState().selected;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (sel.length === 0) return;
        e.preventDefault();
        useObjectEdit.getState().setSelected([]);
        return;
      }
      if (sel.length === 0) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (blocked) return void toast.warning(t('objects.title'), t('overlay.signedBlocked'));
        void deleteSelection(doc.id);
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (blocked) return void toast.warning(t('objects.title'), t('overlay.signedBlocked'));
        void duplicateSelection(doc.id);
        return;
      }
      const nudge = nudgeFor(e.key, e.shiftKey);
      if (nudge && !mod) {
        e.preventDefault();
        if (blocked) return void toast.warning(t('objects.title'), t('overlay.signedBlocked'));
        void moveSelection(doc.id, nudge.dx, nudge.dy);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, blocked, doc.id, t]);

  if (!active && !kinds) return null;
  const live = active && !rotated && !eraseActive && tool === 'select';

  const local = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!live || e.button !== 0) return;
    const pt = local(e);
    const page = pageAt(pages, pt.x, pt.y);
    // The Sửa chữ mode answers the empty page too (D66): with Thêm văn bản on, a press places a new
    // text box; otherwise a press writes the text that is open and clears the text selection.
    const text = useTextEdit.getState();
    if (text.active) {
      if (text.addingText && page) {
        // The press keeps the focus for the new text box, which takes it as it opens.
        e.preventDefault();
        void startDraft(doc.id, page.index, pagePt(page, pt));
        return;
      }
      void clearSelection();
    }
    const st = useObjectEdit.getState();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!page) {
      if (!additive) st.setSelected([]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const pageObjs = answering(st.objects[page.index] ?? []);
    const p = pagePt(page, pt);
    const hits = hitObjects(pageObjs, p.x, p.y);
    const top = pickHit(hits, anchor.current, e.altKey);
    if (!top) {
      if (!additive) st.setSelected([]);
      setDrag({ mode: 'band', page, start: pt, cur: pt, moved: false, additive: e.shiftKey });
      return;
    }
    if (e.shiftKey) {
      st.setSelected(toggleId(st.selected, top.id));
    } else if (e.ctrlKey || e.metaKey) {
      st.setSelected(addIds(st.selected, rangeIds(pageObjs, anchor.current, top.id)));
    } else {
      const keep = !e.altKey && st.selected.includes(top.id);
      st.setSelected(keep ? st.selected : [top.id]);
      if (!blocked)
        setDrag({ mode: 'move', page, start: pt, cur: pt, moved: false, additive: false });
    }
    anchor.current = top.id;
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const pt = local(e);
    if (!drag) {
      if (!live) return;
      const page = pageAt(pages, pt.x, pt.y);
      if (!page) return setHover(null);
      const p = pagePt(page, pt);
      const top = hitObjects(answering(objects[page.index] ?? []), p.x, p.y)[0];
      setHover(top?.id ?? null);
      return;
    }
    const moved = drag.moved || Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y) > DRAG_PX;
    setDrag({ ...drag, cur: pt, moved });
  };

  const onPointerUp = () => {
    const d = drag;
    setDrag(null);
    if (!d || !d.moved) return;
    if (d.mode === 'move') {
      const { dx, dy } = pxDeltaToPt(d.cur.x - d.start.x, d.cur.y - d.start.y, d.page.scale);
      void moveSelection(doc.id, dx, dy);
      return;
    }
    const rect = normRectPt(pagePt(d.page, d.start), pagePt(d.page, d.cur));
    const ids = objectsInRect(answering(objects[d.page.index] ?? []), rect).map((o) => o.id);
    const st = useObjectEdit.getState();
    st.setSelected(d.additive ? addIds(st.selected, ids) : ids);
  };

  // The selected objects, as boxes of the page image (px), with the drag displacement applied.
  const offset =
    drag?.mode === 'move' && drag.moved
      ? { x: drag.cur.x - drag.start.x, y: drag.cur.y - drag.start.y }
      : { x: 0, y: 0 };
  const selSet = new Set(selected);

  const renderPage = (page: MeasuredPage) => {
    const pageObjs = active ? answering(objects[page.index] ?? []) : [];
    const summary = kinds ? types[page.index] : undefined;
    const nodes: ReactNode[] = [];
    const selectedBoxes: { left: number; top: number; right: number; bottom: number }[] = [];
    let n = 0;
    for (const o of pageObjs) {
      if (n++ >= MAX_BOXES) break;
      const b = bboxToPageBox(o.bbox, page);
      const isSel = selSet.has(o.id);
      const style: CSSProperties = {
        left: page.left + b.left,
        top: page.top + b.top,
        width: b.width,
        height: b.height,
      };
      if (isSel) {
        selectedBoxes.push({
          left: style.left as number,
          top: style.top as number,
          right: (style.left as number) + b.width,
          bottom: (style.top as number) + b.height,
        });
        style.transform = `translate(${offset.x}px, ${offset.y}px)`;
      }
      const cls = ['obj-box', `obj-box--${o.kind}`];
      if (isSel) cls.push('is-selected');
      else if (hover === o.id) cls.push('is-hover');
      nodes.push(
        <div
          key={o.id}
          className={cls.join(' ')}
          data-testid="object-box"
          data-kind={o.kind}
          data-id={o.id}
          style={style}
          title={labelOf(o, t)}
        />,
      );
    }
    if (selectedBoxes.length) {
      const l = Math.min(...selectedBoxes.map((b) => b.left));
      const tp = Math.min(...selectedBoxes.map((b) => b.top));
      const r = Math.max(...selectedBoxes.map((b) => b.right));
      const bt = Math.max(...selectedBoxes.map((b) => b.bottom));
      const style: CSSProperties = {
        left: l,
        top: tp,
        width: r - l,
        height: bt - tp,
        transform: `translate(${offset.x}px, ${offset.y}px)`,
      };
      nodes.push(
        <div key="sel" className="obj-sel" data-testid="object-selection" style={style}>
          {HANDLES.map((h) => (
            <span key={h} className={`obj-handle obj-handle--${h}`} aria-hidden />
          ))}
        </div>,
      );
    }
    if (summary) {
      nodes.push(
        <div
          key="dim"
          className="obj-dim"
          style={{ left: page.left, top: page.top, width: page.width, height: page.height }}
        />,
      );
      for (const kind of KIND_KEYS) {
        if (!kinds?.includes(kind)) continue;
        for (const bbox of (summary.kinds[kind]?.bboxes ?? []).slice(0, MAX_BOXES)) {
          const b = bboxToPageBox(bbox, page);
          nodes.push(
            <div
              key={`${kind}-${bbox.join(',')}`}
              className={`obj-typebox obj-typebox--${kind}`}
              data-testid="object-type-box"
              data-kind={kind}
              style={{
                left: page.left + b.left,
                top: page.top + b.top,
                width: b.width,
                height: b.height,
              }}
            />,
          );
        }
      }
    }
    return nodes;
  };

  const band =
    drag?.mode === 'band' && drag.moved
      ? {
          left: Math.min(drag.start.x, drag.cur.x),
          top: Math.min(drag.start.y, drag.cur.y),
          width: Math.abs(drag.cur.x - drag.start.x),
          height: Math.abs(drag.cur.y - drag.start.y),
        }
      : null;

  const hint = !active
    ? null
    : rotated
      ? t('objects.rotatedHint')
      : selected.length > 0
        ? t('objects.selectedHint', { count: selected.length })
        : t('objects.hint');

  return (
    <>
      <div
        ref={layerRef}
        className={`obj-layer${live ? ' obj-layer--live' : ''}`}
        data-testid="object-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onWheel={(e) => {
          const c = getContainer();
          if (c) c.scrollTop += e.deltaY;
        }}
      >
        {pages
          .filter((p) => p.visible)
          .map((page) => (
            <Fragment key={`p${page.index}`}>{renderPage(page)}</Fragment>
          ))}
        {band && <div className="obj-band" data-testid="object-band" style={band} />}
        {hint && (
          <div className="obj-hint" role="status" aria-live="polite">
            {hint}
          </div>
        )}
      </div>
    </>
  );
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

function labelOf(
  o: PageObject,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const kind = t(`objects.kind.${o.kind}`);
  if (o.kind === 'text' && o.string) return `${kind}: ${o.string.slice(0, 60)}`;
  return kind;
}
