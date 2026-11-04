import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Hand } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Field, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { chef } from '../../lib/bridge';
import { runOp, cancelJob } from '../../lib/rpc';
import { jobProgress, useJobStore } from '../jobs/jobStore';
import {
  brushRadiusPx,
  emptyMask,
  erasedPixels,
  FINGER_BRUSH_DEFAULT,
  FINGER_BRUSH_MAX,
  FINGER_BRUSH_MIN,
  maskFromRgba,
  maskToGrayRgba,
  overlayRgba,
  parseFingerPage,
  strokeLine,
} from './fingerModel';
import type { FingerMask } from './fingerModel';
import './finger.css';

interface Proposal {
  pageIndex: number;
  pagePath: string;
  maskPath: string;
  width: number;
  height: number;
  coverage: number;
}

/** T8.10: the proposed finger regions are shown on the page; the user paints or clears them. */
export function FingerDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [pageText, setPageText] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [mask, setMask] = useState<FingerMask | null>(null);
  const [tool, setTool] = useState<'add' | 'remove'>('add');
  const [brush, setBrush] = useState(FINGER_BRUSH_DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  const pageCount = doc?.info.pageCount ?? 0;
  const signed = doc?.state.signed ?? false;
  const pageIndex = useMemo(() => parseFingerPage(pageText, pageCount), [pageText, pageCount]);
  const shownProposal = proposal && proposal.pageIndex === pageIndex ? proposal : null;
  const erased = mask ? erasedPixels(mask) : 0;
  const canApply = !!mask && !!shownProposal && erased > 0 && !signed && !busy;

  // Draw the overlay whenever the mask changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mask) return;
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = new ImageData(overlayRgba(mask) as ImageDataArray, mask.width, mask.height);
    ctx.putImageData(image, 0, 0);
  }, [mask]);

  if (!doc) return null;

  const propose = async () => {
    if (pageIndex === null || signed || busy) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      const result = await runOp(
        'pageimg.proposeFingerMask',
        { pageIndex },
        {
          sessionId: doc.id,
          title: t('pageimg.finger.propose'),
          silent: true,
          onStarted: setJobId,
        },
      );
      const data = result.data as {
        status?: string;
        reason?: string;
        pagePath?: string;
        maskPath?: string;
        pixelSize?: [number, number];
        coverage?: number;
      };
      if (data.status !== 'done' || !data.pagePath || !data.maskPath || !data.pixelSize) {
        setProposal(null);
        setMask(null);
        setError(t('pageimg.finger.noProposal'));
        return;
      }
      const [width, height] = data.pixelSize;
      const next: Proposal = {
        pageIndex,
        pagePath: data.pagePath,
        maskPath: data.maskPath,
        width,
        height,
        coverage: data.coverage ?? 0,
      };
      setProposal(next);
      setMask(await loadMask(next.maskPath, width, height));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const apply = async () => {
    if (!mask || !shownProposal || !canApply) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = mask.width;
      canvas.height = mask.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.putImageData(
        new ImageData(maskToGrayRgba(mask) as ImageDataArray, mask.width, mask.height),
        0,
        0,
      );
      const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
      await runDocOp(
        doc.id,
        'pageimg.removeFingers',
        {
          pages: [shownProposal.pageIndex],
          mode: 'mask',
          maskPngBase64: base64,
          fill: 'paper',
        },
        t('pageimg.finger.job', { name: doc.name }),
        { onStarted: setJobId },
      );
      close();
    } catch (e) {
      showError(e, t('pageimg.finger.title'));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const pointAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !mask) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * mask.width,
      y: ((event.clientY - rect.top) / rect.height) * mask.height,
    };
  };

  const paint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!mask || !drawing.current) return;
    const point = pointAt(event);
    if (!point) return;
    const radius = brushRadiusPx(brush, mask);
    strokeLine(mask, drawing.current, point, radius, tool === 'add' ? 255 : 0);
    drawing.current = point;
    setMask({ ...mask });
  };

  const editor = shownProposal && mask && (
    <div className="finger-editor">
      <div className="finger-editor__frame">
        <img
          src={chef().files.toUrl(shownProposal.pagePath)}
          alt={t('pageimg.finger.pageAlt', { page: shownProposal.pageIndex + 1 })}
        />
        <canvas
          ref={canvasRef}
          className="finger-editor__mask"
          aria-label={t('pageimg.finger.maskAlt')}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drawing.current = pointAt(event);
            if (drawing.current) paint(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons) paint(event);
          }}
          onPointerUp={() => {
            drawing.current = null;
          }}
          onPointerLeave={() => {
            drawing.current = null;
          }}
        />
      </div>
      <div className="finger-editor__tools" role="group" aria-label={t('pageimg.finger.tools')}>
        <button type="button" aria-pressed={tool === 'add'} onClick={() => setTool('add')}>
          {t('pageimg.finger.toolAdd')}
        </button>
        <button type="button" aria-pressed={tool === 'remove'} onClick={() => setTool('remove')}>
          {t('pageimg.finger.toolRemove')}
        </button>
        <label>
          {t('pageimg.finger.brush')}
          <input
            type="range"
            min={FINGER_BRUSH_MIN}
            max={FINGER_BRUSH_MAX}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="muted" role="status">
        {t('pageimg.finger.coverage', {
          value: ((erased / Math.max(1, mask.width * mask.height)) * 100).toFixed(2),
        })}
      </p>
    </div>
  );

  const previewContent = (
    <div className="finger-preview">
      {editor ? (
        editor
      ) : (
        <p className="muted" role="status">
          {error ?? t('pageimg.finger.previewEmpty')}
        </p>
      )}
      {error && editor && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(open) => !open && close()}
      title={t('pageimg.finger.title')}
      icon={<Hand size={18} />}
      description={t('pageimg.finger.description')}
      preview={previewContent}
      running={busy}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId).catch(showError) : undefined}
      onRun={() => void apply()}
      canRun={canApply}
      runLabel={t('pageimg.finger.apply')}
      size="xl"
    >
      <Field
        label={t('pageimg.finger.page')}
        htmlFor="finger-page"
        hint={t('pageimg.finger.pageHint')}
        error={pageText.trim() && pageIndex === null ? t('pageimg.finger.invalidPage') : undefined}
      >
        <TextInput
          id="finger-page"
          value={pageText}
          placeholder="1"
          onChange={(e) => {
            setPageText(e.target.value);
            setMask(null);
          }}
          disabled={busy}
        />
      </Field>
      <Button
        variant="secondary"
        onClick={() => void propose()}
        disabled={pageIndex === null || signed || busy}
      >
        {t('pageimg.finger.propose')}
      </Button>
    </TaskDialog>
  );
}

type ImageDataArray = Uint8ClampedArray<ArrayBuffer>;

/** Loads the proposed mask (a grayscale PNG) into an editable mask at the page pixel size.
 * The bytes come through fetch, so the canvas is not tainted by a cross-origin <img>. */
async function loadMask(path: string, width: number, height: number): Promise<FingerMask> {
  const response = await fetch(chef().files.toUrl(path));
  if (!response.ok) throw new Error(`mask ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return emptyMask(width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  return maskFromRgba(width, height, pixels);
}
