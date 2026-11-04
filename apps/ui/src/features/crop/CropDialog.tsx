import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Crop } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Field, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import {
  pointAt,
  validQuad,
  resizeRectangle,
  snapRectangleTarget,
  type Point,
  type RectangleHandle,
} from './quadModel';
import { outputSizeFromMm } from './cropSizing';
import './crop.css';

interface QuadRow {
  pageIndex: number;
  status: 'done' | 'skipped';
  imagePath?: string;
  cornersFraction?: number[][];
  confidence?: number;
  reason?: string;
}

function CorrectedPreview({
  docId,
  revision,
  pageIndex,
  points,
  outSize,
  angle,
}: {
  docId: string;
  revision: string;
  pageIndex: number;
  points: Point[];
  outSize?: [number, number];
  angle: number;
}) {
  const { t } = useTranslation();
  const corners = JSON.stringify(points);
  const sizeKey = JSON.stringify(outSize ?? null);
  const key = `${revision}:${pageIndex}:${corners}:${sizeKey}:${angle}`;
  const [result, setResult] = useState<{ key: string; path: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void runOp(
        'pageimg.cropPreview',
        {
          pageIndex,
          corners: JSON.parse(corners) as Point[],
          angle,
          ...(sizeKey !== 'null' ? { outSize: JSON.parse(sizeKey) as [number, number] } : {}),
        },
        { sessionId: docId, title: t('cropReview.corrected'), silent: true },
      )
        .then((output) => {
          const data = output.data as { imagePath?: unknown } | undefined;
          if (live)
            setResult({ key, path: typeof data?.imagePath === 'string' ? data.imagePath : null });
        })
        .catch(() => {
          if (live) setResult({ key, path: null });
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [angle, corners, docId, key, sizeKey, pageIndex, t]);
  return (
    <div className="crop-review__corrected">
      <p>{t('cropReview.corrected')}</p>
      {outSize && (
        <small>{t('cropReview.outputPixels', { width: outSize[0], height: outSize[1] })}</small>
      )}
      {result?.key === key && result.path ? (
        <img src={chef().files.toUrl(result.path)} alt={t('cropReview.corrected')} />
      ) : (
        <span role="status">
          {t(result?.key === key ? 'cropReview.previewFailed' : 'cropReview.previewLoading')}
        </span>
      )}
    </div>
  );
}

export function CropDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const open = useUi((s) => s.openDialog);
  const data = useUi((s) => s.dialogData) as { page?: number; queue?: number[] } | undefined;
  const queue = data?.queue ?? [];
  /** Opens the next page of the quick review, or closes when the queue is empty. */
  const nextInQueue = () => {
    const [next, ...rest] = queue;
    if (next === undefined) close();
    else open('cropReview', { page: next + 1, queue: rest });
  };
  const [page, setPage] = useState(() => String(data?.page ?? 1));
  const [preview, setPreview] = useState<{ revision: string; row: QuadRow } | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [sourceInfo, setSourceInfo] = useState<{
    ppi: number;
    width: number;
    height: number;
  } | null>(null);
  const [ratio, setRatio] = useState('free');
  const [shape, setShape] = useState<'quad' | 'rectangle'>('quad');
  const [widthMm, setWidthMm] = useState('');
  const [heightMm, setHeightMm] = useState('');
  const [angle, setAngle] = useState('0');
  const imageRef = useRef<HTMLDivElement>(null);
  if (!doc) return null;
  const pageNumber = Number(page);
  const validPage =
    Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= doc.info.pageCount;
  const current =
    preview &&
    preview.revision === doc.state.revisionPath &&
    preview.row.pageIndex === pageNumber - 1
      ? preview.row
      : null;
  const canApply = !!current && current.status === 'done' && validQuad(points) && !doc.state.signed;
  const sizeResult = outputSizeFromMm(widthMm, heightMm, sourceInfo?.ppi ?? 0);
  const angleValue = Number(angle);
  const validAngle =
    angle.trim() !== '' && Number.isFinite(angleValue) && angleValue >= -15 && angleValue <= 15;
  const detect = async () => {
    if (!validPage) return;
    setBusy(true);
    try {
      const result = await runOp(
        'pageimg.quadPreview',
        { pages: [pageNumber - 1] },
        { sessionId: doc.id, title: t('cropReview.detect') },
      );
      const payload = result.data as
        { pages?: Array<QuadRow & { ppi?: number; sourceSizePx?: number[] }> } | undefined;
      const row = payload?.pages?.[0];
      if (!row) throw new Error(t('cropReview.badResult'));
      setSourceInfo(
        (row.ppi ?? 0) > 0 && row.sourceSizePx?.length === 2
          ? { ppi: row.ppi!, width: row.sourceSizePx[0]!, height: row.sourceSizePx[1]! }
          : null,
      );
      setPreview({ revision: doc.state.revisionPath, row });
      setPoints(row.cornersFraction?.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 })) ?? []);
    } catch (e) {
      showError(e, t('cropReview.title'));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!canApply || !sizeResult.valid || !validAngle) return;
    setBusy(true);
    try {
      const result = await runDocOp(
        doc.id,
        'pageimg.crop',
        {
          pages: [
            {
              pageIndex: pageNumber - 1,
              corners: points,
              angle: angleValue,
              ...(sizeResult.outSize ? { outSize: sizeResult.outSize } : {}),
            },
          ],
        },
        t('cropReview.title'),
        { toastWarnings: true },
      );
      if (result) {
        toast.success(t('cropReview.done'));
        nextInQueue();
      }
    } finally {
      setBusy(false);
    }
  };
  const corners: RectangleHandle[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  const move = (index: number, point: Point) => {
    if (shape === 'rectangle') return moveRectangle(corners[index]!, point);
    setPoints((items) => items.map((p, i) => (i === index ? point : p)));
  };
  const moveRectangle = (handle: RectangleHandle, point: Point) => {
    const [width, height] = ratio.split('/').map(Number);
    const locked =
      ratio !== 'free' && sourceInfo?.width && sourceInfo.height
        ? (width! / height!) * (sourceInfo.height / sourceInfo.width)
        : undefined;
    setPoints((items) => resizeRectangle(items, handle, point, locked));
  };
  const snapDrag = (handle: RectangleHandle, point: Point, bounds: DOMRect) => {
    const detected =
      current?.cornersFraction?.map(([x, y]) => ({ x: x ?? NaN, y: y ?? NaN })) ?? [];
    return bounds.width > 0 && bounds.height > 0
      ? snapRectangleTarget(handle, point, detected, 8 / bounds.width, 8 / bounds.height)
      : point;
  };
  const drag = (e: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (!imageRef.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const bounds = imageRef.current.getBoundingClientRect();
    setImageSize({ width: bounds.width, height: bounds.height });
    const point = pointAt(e.clientX, e.clientY, bounds);
    move(index, shape === 'rectangle' ? snapDrag(corners[index]!, point, bounds) : point);
  };
  const dragEdge = (e: ReactPointerEvent<HTMLButtonElement>, edge: RectangleHandle) => {
    const image = e.currentTarget.parentElement;
    if (!image || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const bounds = image.getBoundingClientRect();
    moveRectangle(edge, snapDrag(edge, pointAt(e.clientX, e.clientY, bounds), bounds));
  };
  const activePoint = activeCorner === null ? undefined : points[activeCorner];
  const previewContent = (
    <div className="crop-review__preview">
      {current?.status === 'done' && current.imagePath ? (
        <>
          <p>
            {t('cropReview.confidence', { value: Math.round((current.confidence ?? 0) * 100) })}
          </p>
          <div className="crop-review__image" ref={imageRef}>
            <img
              src={chef().files.toUrl(current.imagePath)}
              alt={t('cropReview.image')}
              draggable={false}
            />
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')} />
            </svg>
            {points.map((point, index) => (
              <button
                key={index}
                type="button"
                className="crop-review__handle"
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                aria-label={t('cropReview.corner', { index: index + 1 })}
                onFocus={() => {
                  const bounds = imageRef.current?.getBoundingClientRect();
                  if (bounds) setImageSize({ width: bounds.width, height: bounds.height });
                  setActiveCorner(index);
                }}
                onBlur={() => setActiveCorner(null)}
                onPointerDown={(e) => {
                  setActiveCorner(index);
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag(e, index);
                }}
                onPointerMove={(e) => drag(e, index)}
                onKeyDown={(e) => {
                  const d = e.shiftKey ? 0.01 : 0.002;
                  const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
                  const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
                  if (dx || dy) {
                    e.preventDefault();
                    move(index, {
                      x: Math.max(0, Math.min(1, point.x + dx)),
                      y: Math.max(0, Math.min(1, point.y + dy)),
                    });
                  }
                }}
              />
            ))}
            {shape === 'rectangle' &&
              points.length === 4 &&
              (['top', 'right', 'bottom', 'left'] as const).map((edge, index) => {
                const a = points[index]!;
                const b = points[(index + 1) % 4]!;
                const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                return (
                  <button
                    key={edge}
                    type="button"
                    className="crop-review__handle crop-review__handle--edge"
                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                    aria-label={t(`cropReview.edge.${edge}`)}
                    onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                    onPointerMove={(e) => dragEdge(e, edge)}
                    onKeyDown={(e) => {
                      const d = e.shiftKey ? 0.01 : 0.002;
                      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
                      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
                      if (dx || dy) {
                        e.preventDefault();
                        moveRectangle(edge, { x: point.x + dx, y: point.y + dy });
                      }
                    }}
                  />
                );
              })}
            {activePoint && imageSize.width > 0 && (
              <div
                className="crop-review__magnifier"
                aria-hidden="true"
                style={{
                  backgroundImage: `url("${chef().files.toUrl(current.imagePath)}")`,
                  backgroundSize: `${imageSize.width * 4}px ${imageSize.height * 4}px`,
                  backgroundPosition: `${70 - activePoint.x * imageSize.width * 4}px ${70 - activePoint.y * imageSize.height * 4}px`,
                }}
              />
            )}
          </div>
          {!validQuad(points) && <p role="alert">{t('cropReview.invalidQuad')}</p>}
          {queue.length > 0 && (
            <p className="crop-review__queue">
              <Button variant="ghost" onClick={nextInQueue} disabled={busy}>
                {t('cropReview.skipNext', { left: queue.length })}
              </Button>
            </p>
          )}
          {validQuad(points) && validAngle && (
            <CorrectedPreview
              docId={doc.id}
              revision={doc.state.revisionPath}
              pageIndex={pageNumber - 1}
              points={points}
              outSize={sizeResult.outSize}
              angle={angleValue}
            />
          )}
        </>
      ) : (
        <p>{current?.status === 'skipped' ? t('cropReview.noImage') : t('cropReview.hint')}</p>
      )}
    </div>
  );
  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('cropReview.title')}
      icon={<Crop size={18} />}
      description={t('cropReview.description')}
      preview={previewContent}
      warnings={[t('cropReview.warning')]}
      onRun={() => void apply()}
      runLabel={t('cropReview.apply')}
      canRun={canApply && sizeResult.valid && validAngle && !busy}
      running={busy}
      size="xl"
    >
      <Field label={t('cropReview.page')} htmlFor="crop-review-page">
        <TextInput
          id="crop-review-page"
          type="number"
          min={1}
          max={doc.info.pageCount}
          value={page}
          disabled={busy}
          onChange={(e) => {
            setPage(e.target.value);
            setPreview(null);
            setPoints([]);
            setSourceInfo(null);
            setWidthMm('');
            setHeightMm('');
            setAngle('0');
            setRatio('free');
            setShape('quad');
          }}
        />
      </Field>
      <Button disabled={!validPage || busy} onClick={() => void detect()}>
        {t('cropReview.detect')}
      </Button>
      {current?.status === 'done' && (
        <div className="crop-review__dimensions">
          <Field
            label={t('cropReview.angle')}
            htmlFor="crop-review-angle"
            hint={t('cropReview.angleHint')}
          >
            <TextInput
              id="crop-review-angle"
              type="number"
              min={-15}
              max={15}
              step={0.1}
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
            />
          </Field>
          {!validAngle && <small role="alert">{t('cropReview.invalidAngle')}</small>}
          <Field label={t('cropReview.shape')} htmlFor="crop-review-shape">
            <select
              id="crop-review-shape"
              value={shape}
              onChange={(e) => {
                const next = e.target.value as 'quad' | 'rectangle';
                setShape(next);
                setRatio('free');
                if (next === 'rectangle' && points.length === 4) {
                  const x0 = Math.min(...points.map((p) => p.x));
                  const x1 = Math.max(...points.map((p) => p.x));
                  const y0 = Math.min(...points.map((p) => p.y));
                  const y1 = Math.max(...points.map((p) => p.y));
                  setPoints([
                    { x: x0, y: y0 },
                    { x: x1, y: y0 },
                    { x: x1, y: y1 },
                    { x: x0, y: y1 },
                  ]);
                }
              }}
            >
              <option value="quad">{t('cropReview.quadrilateral')}</option>
              <option value="rectangle">{t('cropReview.rectangle')}</option>
            </select>
          </Field>
          <Field label={t('cropReview.ratio')} htmlFor="crop-review-ratio">
            <select
              id="crop-review-ratio"
              value={ratio}
              onChange={(e) => {
                const value = e.target.value;
                setRatio(value);
                if (value !== 'free' && imageRef.current && points.length === 4) {
                  setShape('rectangle');
                  const [rw, rh] = value.split('/').map(Number);
                  const bounds = imageRef.current.getBoundingClientRect();
                  const x0 = Math.min(...points.map((p) => p.x));
                  const x1 = Math.max(...points.map((p) => p.x));
                  const y0 = Math.min(...points.map((p) => p.y));
                  const y1 = Math.max(...points.map((p) => p.y));
                  const cx = (x0 + x1) / 2;
                  const cy = (y0 + y1) / 2;
                  let w = x1 - x0;
                  let h = y1 - y0;
                  const target = (rw! / rh!) * (bounds.height / bounds.width);
                  if (w / h > target) w = h * target;
                  else h = w / target;
                  setPoints([
                    { x: cx - w / 2, y: cy - h / 2 },
                    { x: cx + w / 2, y: cy - h / 2 },
                    { x: cx + w / 2, y: cy + h / 2 },
                    { x: cx - w / 2, y: cy + h / 2 },
                  ]);
                }
              }}
            >
              <option value="free">{t('cropReview.free')}</option>
              <option value="210/297">A4</option>
              <option value="148/210">A5</option>
              <option value="216/279">Letter</option>
              <option value="54/86">CCCD</option>
            </select>
          </Field>
          <Field label={t('cropReview.widthMm')} htmlFor="crop-review-width-mm">
            <TextInput
              id="crop-review-width-mm"
              type="number"
              min="1"
              value={widthMm}
              onChange={(e) => setWidthMm(e.target.value)}
            />
          </Field>
          <Field label={t('cropReview.heightMm')} htmlFor="crop-review-height-mm">
            <TextInput
              id="crop-review-height-mm"
              type="number"
              min="1"
              value={heightMm}
              onChange={(e) => setHeightMm(e.target.value)}
            />
          </Field>
          {!sourceInfo && <small>{t('cropReview.mmUnavailable')}</small>}
          {!sizeResult.valid && <small role="alert">{t('cropReview.invalidMm')}</small>}
        </div>
      )}
    </TaskDialog>
  );
}
