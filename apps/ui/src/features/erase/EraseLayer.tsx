/**
 * Erase tool (D5, T6.03): drag a rectangle on a page, then choose the mode in the floating bar and
 * apply. Cut removes the content inside (text, images, vectors) and leaves no box; cover paints the
 * rectangle with a colour (sampled or chosen). Apply runs content.eraseRegion as one revision, so
 * undo is the session's undo. Esc cancels the current rectangle, then the tool.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { useViewStore } from '../../app/state/viewer';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, RadioGroup, Select } from '../../components/Form';
import { toast } from '../../components/Toast';
import { runDocOp } from '../../app/actions';
import { objectErrorCode } from '../../lib/errors';
import { objectErrorText } from '../objects/objectActions';
import {
  eraseChangedNothing,
  eraseRegionParams,
  normRectPt,
  type EraseCounts,
} from '../objects/objectModel';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import { useEraseState } from './eraseState';
import './erase.css';

const MIN_PT = 2;

export function EraseLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const active = useEraseState((s) => s.active);
  const options = useEraseState((s) => s.options);
  const rect = useEraseState((s) => s.rect);
  const setOptions = useEraseState((s) => s.setOptions);
  const setRect = useEraseState((s) => s.setRect);
  const rotated = useViewStore((s) => (s.views[doc.id]?.rotation ?? 0) !== 0);
  const [pages, setPages] = useState<MeasuredPage[]>([]);
  const [drag, setDrag] = useState<{
    page: MeasuredPage;
    start: { x: number; y: number };
    cur: { x: number; y: number };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const measureKey = useRef('');

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

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      e.preventDefault();
      if (useEraseState.getState().rect) setRect(null);
      else useEraseState.getState().setActive(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, setRect]);

  if (!active) return null;
  const live = !rotated && !busy;

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
    setRect(null);
    setDrag({ page, start: pt, cur: pt });
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ ...drag, cur: local(e) });
  };

  const onPointerUp = () => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    const a = pagePt(d.page, d.start);
    const b = pagePt(d.page, d.cur);
    const r = normRectPt(a, b);
    if (r[2] - r[0] < MIN_PT || r[3] - r[1] < MIN_PT) return;
    setRect({ pageIndex: d.page.index, rect: r });
  };

  const apply = async () => {
    if (!rect) return;
    setBusy(true);
    try {
      const params = eraseRegionParams(rect.pageIndex, rect.rect, options);
      const result = await runDocOp(doc.id, 'content.eraseRegion', params, t('erase.title'), {
        onError: (e) => {
          if (objectErrorCode(e) === null) return false;
          toast.error(t('erase.title'), objectErrorText(e));
          return true;
        },
      });
      if (!result) return;
      const c = (result.data ?? {}) as EraseCounts;
      if (eraseChangedNothing(c)) {
        toast.info(t('erase.title'), t('erase.nothing'));
      } else {
        toast.success(
          t('erase.title'),
          t('erase.result', {
            removed: c.removedObjects,
            split: c.splitObjects,
            images: c.modifiedImages,
            clipped: c.clippedObjects,
          }),
        );
      }
      setRect(null);
    } finally {
      setBusy(false);
    }
  };

  const boxPage = rect ? pages.find((p) => p.index === rect.pageIndex) : undefined;
  const shown =
    drag && !rect
      ? {
          left: Math.min(drag.start.x, drag.cur.x),
          top: Math.min(drag.start.y, drag.cur.y),
          width: Math.abs(drag.cur.x - drag.start.x),
          height: Math.abs(drag.cur.y - drag.start.y),
          page: drag.page,
        }
      : rect && boxPage
        ? {
            left: boxPage.left + rect.rect[0] * boxPage.scale,
            top: boxPage.top + rect.rect[1] * boxPage.scale,
            width: (rect.rect[2] - rect.rect[0]) * boxPage.scale,
            height: (rect.rect[3] - rect.rect[1]) * boxPage.scale,
            page: boxPage,
          }
        : null;

  return (
    <>
      <div
        ref={layerRef}
        className={`erase-layer${live ? ' erase-layer--live' : ''}`}
        data-testid="erase-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {shown && (
          <div
            className="erase-box"
            data-testid="erase-box"
            style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height }}
          />
        )}
        <div className="erase-hint" role="status" aria-live="polite">
          {rotated ? t('erase.rotatedHint') : rect ? t('erase.hintBar') : t('erase.hint')}
        </div>
      </div>
      {rect && (
        <div
          className="erase-bar"
          role="toolbar"
          aria-label={t('erase.title')}
          data-testid="erase-bar"
        >
          <span className="erase-bar__title">{t('erase.title')}</span>
          <RadioGroup<'cut' | 'cover'>
            aria-label={t('erase.mode.label')}
            value={options.mode}
            onChange={(v) => setOptions({ mode: v })}
            options={[
              { value: 'cut', label: t('erase.mode.cut'), hint: t('erase.mode.cutHint') },
              { value: 'cover', label: t('erase.mode.cover'), hint: t('erase.mode.coverHint') },
            ]}
          />
          {options.mode === 'cover' && (
            <label className="erase-bar__colour">
              <span>{t('erase.colour')}</span>
              <input
                type="color"
                value={options.color === 'auto' ? '#ffffff' : options.color}
                onChange={(e) => setOptions({ color: e.target.value })}
                aria-label={t('erase.colour')}
              />
              <Button size="sm" variant="ghost" onClick={() => setOptions({ color: 'auto' })}>
                {t('erase.colourAuto')}
              </Button>
            </label>
          )}
          <Checkbox
            checked={options.includeText}
            onChange={(v) => setOptions({ includeText: v })}
            label={t('erase.target.text')}
          />
          <Checkbox
            checked={options.includeImages}
            onChange={(v) => setOptions({ includeImages: v })}
            label={t('erase.target.images')}
          />
          <Checkbox
            checked={options.includeVectors}
            onChange={(v) => setOptions({ includeVectors: v })}
            label={t('erase.target.vectors')}
          />
          <Checkbox
            checked={!options.partial}
            onChange={(v) => setOptions({ partial: !v })}
            label={t('erase.wholeOnly')}
            hint={t('erase.wholeOnlyHint')}
          />
          {options.mode === 'cut' && (
            <Select<'transparent' | 'white' | 'auto'>
              aria-label={t('erase.imageFill')}
              value={options.imageFill}
              onChange={(v) => setOptions({ imageFill: v })}
              options={[
                { value: 'transparent', label: t('erase.fill.transparent') },
                { value: 'white', label: t('erase.fill.white') },
                { value: 'auto', label: t('erase.fill.auto') },
              ]}
            />
          )}
          <span className="erase-bar__spacer" />
          <IconButton
            size="sm"
            label={t('erase.cancel')}
            icon={<X size={15} />}
            onClick={() => setRect(null)}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<Check size={14} />}
            disabled={busy || doc.state.signed}
            title={doc.state.signed ? t('overlay.signedBlocked') : undefined}
            onClick={() => void apply()}
          >
            {t('erase.apply')}
          </Button>
        </div>
      )}
    </>
  );
}
