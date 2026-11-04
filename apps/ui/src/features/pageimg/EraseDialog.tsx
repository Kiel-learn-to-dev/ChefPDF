import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser } from 'lucide-react';
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
  eraseParams,
  parseEraseSinglePage,
  rectFromDrag,
  stainParams,
  STAIN_PRESETS,
} from './eraseModel';
import type { EraseRect, StainPreset } from './eraseModel';
import './erase.css';

type Tool = 'rect' | 'stain';

interface PagePicture {
  pageIndex: number;
  previewPath: string;
}

/** T8.03: draw rectangles to erase them (filled with paper), or remove one ink colour. */
export function EraseDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [tool, setTool] = useState<Tool>('rect');
  const [pageText, setPageText] = useState('');
  const [picture, setPicture] = useState<PagePicture | null>(null);
  const [rects, setRects] = useState<EraseRect[]>([]);
  const [drag, setDrag] = useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);
  const [fill, setFill] = useState<'paper' | '#ffffff'>('paper');
  const [stainPageText, setStainPageText] = useState('');
  const [preset, setPreset] = useState<StainPreset>(STAIN_PRESETS[0]!);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));
  const frameRef = useRef<HTMLDivElement>(null);

  const pageCount = doc?.info.pageCount ?? 0;
  const signed = doc?.state.signed ?? false;
  const pageIndex = useMemo(() => parseEraseSinglePage(pageText, pageCount), [pageText, pageCount]);
  const shownPicture = picture && picture.pageIndex === pageIndex ? picture : null;
  const rectParams = eraseParams(pageIndex, rects, fill);
  const stainPreset = stainParams(stainPageText, pageCount, preset);
  const canRun =
    !signed && !busy && (tool === 'rect' ? !!rectParams && !!shownPicture : !!stainPreset);

  if (!doc) return null;

  const showPage = async () => {
    if (pageIndex === null || signed || busy) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      const result = await runOp(
        'pageimg.pagePreview',
        { pageIndex },
        { sessionId: doc.id, title: t('pageimg.erase.preview'), silent: true, onStarted: setJobId },
      );
      const data = result.data as { status?: string; previewPath?: string; reason?: string };
      if (data.status !== 'done' || !data.previewPath) {
        setPicture(null);
        setError(t('pageimg.erase.noPicture'));
        return;
      }
      setPicture({ pageIndex, previewPath: data.previewPath });
      setRects([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const pointIn = (event: ReactPointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };

  const apply = async () => {
    if (!canRun || busy) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      if (tool === 'rect' && rectParams) {
        await runDocOp(
          doc.id,
          'pageimg.erase',
          rectParams,
          t('pageimg.erase.job', { name: doc.name }),
          {
            onStarted: setJobId,
          },
        );
      } else if (tool === 'stain' && stainPreset) {
        await runDocOp(
          doc.id,
          'pageimg.removeStains',
          stainPreset,
          t('pageimg.erase.stainJob', { name: doc.name }),
          { onStarted: setJobId },
        );
      }
      close();
    } catch (e) {
      showError(e, t('pageimg.erase.title'));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const rectPreview = (
    <div className="erase-preview">
      {tool === 'rect' && (
        <>
          <div className="erase-preview__actions">
            <Button
              variant="secondary"
              onClick={() => void showPage()}
              disabled={pageIndex === null || signed || busy}
            >
              {t('pageimg.erase.preview')}
            </Button>
          </div>
          {shownPicture ? (
            <div
              ref={frameRef}
              className="erase-preview__frame"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const point = pointIn(event);
                if (point) setDrag({ start: point, end: point });
              }}
              onPointerMove={(event) => {
                if (!drag) return;
                const point = pointIn(event);
                if (point) setDrag({ ...drag, end: point });
              }}
              onPointerUp={() => {
                if (drag) {
                  const rect = rectFromDrag(drag.start, drag.end);
                  if (rect) setRects([...rects, rect]);
                }
                setDrag(null);
              }}
            >
              <img
                src={chef().files.toUrl(shownPicture.previewPath)}
                alt={t('pageimg.erase.pageAlt', { page: shownPicture.pageIndex + 1 })}
                draggable={false}
              />
              {rects.map((r, i) => (
                <div
                  key={i}
                  className="erase-preview__rect"
                  style={{
                    left: `${r.x * 100}%`,
                    top: `${r.y * 100}%`,
                    width: `${r.w * 100}%`,
                    height: `${r.h * 100}%`,
                  }}
                />
              ))}
              {drag && (
                <div
                  className="erase-preview__rect erase-preview__rect--draft"
                  style={{
                    left: `${Math.min(drag.start.x, drag.end.x) * 100}%`,
                    top: `${Math.min(drag.start.y, drag.end.y) * 100}%`,
                    width: `${Math.abs(drag.end.x - drag.start.x) * 100}%`,
                    height: `${Math.abs(drag.end.y - drag.start.y) * 100}%`,
                  }}
                />
              )}
            </div>
          ) : (
            <p className="muted" role="status">
              {error ?? t('pageimg.erase.previewEmpty')}
            </p>
          )}
          {shownPicture && (
            <div className="erase-preview__list">
              <span>{t('pageimg.erase.count', { count: rects.length })}</span>
              {rects.length > 0 && (
                <Button variant="ghost" onClick={() => setRects([])}>
                  {t('pageimg.erase.clear')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {tool === 'stain' && <p className="muted">{t('pageimg.erase.stainHint')}</p>}
    </div>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(open) => !open && close()}
      title={t('pageimg.erase.title')}
      icon={<Eraser size={18} />}
      description={t('pageimg.erase.description')}
      preview={rectPreview}
      running={busy}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId).catch(showError) : undefined}
      onRun={() => void apply()}
      canRun={canRun}
      runLabel={tool === 'rect' ? t('pageimg.erase.applyRect') : t('pageimg.erase.applyStain')}
      size="xl"
    >
      <div className="erase-tools" role="radiogroup" aria-label={t('pageimg.erase.tool')}>
        <label>
          <input
            type="radio"
            name="erase-tool"
            checked={tool === 'rect'}
            onChange={() => setTool('rect')}
          />
          {t('pageimg.erase.toolRect')}
        </label>
        <label>
          <input
            type="radio"
            name="erase-tool"
            checked={tool === 'stain'}
            onChange={() => setTool('stain')}
          />
          {t('pageimg.erase.toolStain')}
        </label>
      </div>
      {tool === 'rect' && (
        <>
          <Field
            label={t('pageimg.erase.page')}
            htmlFor="erase-page"
            hint={t('pageimg.erase.pageHint')}
            error={
              pageText.trim() && pageIndex === null ? t('pageimg.erase.invalidPage') : undefined
            }
          >
            <TextInput
              id="erase-page"
              value={pageText}
              placeholder="1"
              onChange={(e) => {
                setPageText(e.target.value);
                setPicture(null);
                setRects([]);
              }}
              disabled={busy}
            />
          </Field>
          <div className="erase-tools" role="radiogroup" aria-label={t('pageimg.erase.fill')}>
            <label>
              <input
                type="radio"
                name="erase-fill"
                checked={fill === 'paper'}
                onChange={() => setFill('paper')}
              />
              {t('pageimg.erase.fillPaper')}
            </label>
            <label>
              <input
                type="radio"
                name="erase-fill"
                checked={fill === '#ffffff'}
                onChange={() => setFill('#ffffff')}
              />
              {t('pageimg.erase.fillWhite')}
            </label>
          </div>
        </>
      )}
      {tool === 'stain' && (
        <>
          <Field
            label={t('pageimg.erase.stainPages')}
            htmlFor="stain-pages"
            hint={t('pageimg.erase.stainPagesHint')}
            error={
              stainPageText.trim() && !stainPreset ? t('pageimg.erase.invalidPages') : undefined
            }
          >
            <TextInput
              id="stain-pages"
              value={stainPageText}
              placeholder="1-4"
              onChange={(e) => setStainPageText(e.target.value)}
              disabled={busy}
            />
          </Field>
          <div className="erase-tools" role="radiogroup" aria-label={t('pageimg.erase.ink')}>
            {STAIN_PRESETS.map((item) => (
              <label key={item.id}>
                <input
                  type="radio"
                  name="stain-ink"
                  checked={preset.id === item.id}
                  onChange={() => setPreset(item)}
                />
                {t(`pageimg.erase.ink_${item.id}`)}
              </label>
            ))}
          </div>
        </>
      )}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </TaskDialog>
  );
}
