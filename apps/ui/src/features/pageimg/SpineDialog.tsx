import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Field, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { chef } from '../../lib/bridge';
import { runOp, cancelJob } from '../../lib/rpc';
import { toast } from '../../components/Toast';
import { jobProgress, useJobStore } from '../jobs/jobStore';
import {
  readSpinePreview,
  spineApplyParams,
  spinePreviewParams,
  startPercent,
  SPINE_MAX_PERCENT,
  SPINE_MIN_PERCENT,
} from './spineModel';
import type { SpineMode, SpinePreviewData } from './spineModel';
import './spine.css';

interface PreviewState {
  key: string;
  data: SpinePreviewData;
}

/** T8.08: the automatic spine position is shown on a preview; the user may move it by hand. */
export function SpineDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [pagesText, setPagesText] = useState('');
  const [mode, setMode] = useState<SpineMode>('auto');
  const [percent, setPercent] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));

  const pageCount = doc?.info.pageCount ?? 0;
  const signed = doc?.state.signed ?? false;
  const pParams = useMemo(() => spinePreviewParams(pagesText, pageCount), [pagesText, pageCount]);
  const previewIsCurrent = preview?.key === pagesText.trim();
  const rows = previewIsCurrent ? (preview?.data.pages ?? []) : [];
  const visibleRows = rows.filter((r) => r.status === 'done');
  const row = visibleRows[0];
  const shownPercent = percent ?? (previewIsCurrent && preview ? startPercent(preview.data) : 50);
  const aParams = useMemo(
    () => spineApplyParams(pagesText, pageCount, mode, shownPercent),
    [pagesText, pageCount, mode, shownPercent],
  );
  const skipped = rows.filter((r) => r.status === 'skipped').map((r) => r.pageIndex + 1);
  const lowConfidence = visibleRows
    .filter((r) => (r.confidence ?? 0) < 0.4)
    .map((r) => r.pageIndex + 1);
  const warnings: string[] = [];
  if (skipped.length)
    warnings.push(t('pageimg.spine.skippedWarning', { pages: skipped.join(', ') }));
  if (lowConfidence.length && mode === 'auto') {
    warnings.push(t('pageimg.spine.lowConfidence', { pages: lowConfidence.join(', ') }));
  }
  if (!doc) return null;

  const requestPreview = async () => {
    if (!pParams || signed || busy) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      const result = await runOp('pageimg.spinePreview', pParams, {
        sessionId: doc.id,
        title: t('pageimg.spine.preview'),
        silent: true,
        onStarted: setJobId,
      });
      setPreview({ key: pagesText.trim(), data: readSpinePreview(result.data) });
      setPercent(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const apply = async () => {
    if (!aParams || !previewIsCurrent || visibleRows.length === 0 || signed || busy) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      const result = await runDocOp(
        doc.id,
        'pageimg.splitSpread',
        aParams,
        t('pageimg.spine.job', { name: doc.name }),
        { onStarted: setJobId },
      );
      if (result) {
        const review = (result.data as { pages?: { status: string; pageIndex: number }[] }).pages
          ?.filter((p) => p.status === 'review')
          .map((p) => p.pageIndex + 1);
        if (review?.length) {
          toast.warning(
            t('pageimg.spine.title'),
            t('pageimg.spine.applyReview', { pages: review.join(', ') }),
          );
        }
        close();
      }
    } catch (e) {
      showError(e, t('pageimg.spine.title'));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const linePercent = mode === 'manual' ? shownPercent : null;

  const previewContent = (
    <div className="spine-preview">
      {!previewIsCurrent || !row ? (
        <p className="muted" role="status">
          {error ?? t('pageimg.spine.previewEmpty')}
        </p>
      ) : (
        <>
          <div className="spine-preview__frame">
            <img
              src={chef().files.toUrl(row.previewPath!)}
              alt={t('pageimg.spine.previewAlt', { page: row.pageIndex + 1 })}
            />
            {linePercent !== null && (
              <div
                className="spine-preview__line"
                style={{ left: `${linePercent}%` }}
                aria-hidden="true"
              />
            )}
          </div>
          <p className="spine-preview__meta" role="status">
            {t('pageimg.spine.auto', { value: Math.round((row.autoX ?? 0.5) * 1000) / 10 })}
            <span>
              {t('pageimg.spine.confidence', { value: Math.round((row.confidence ?? 0) * 100) })}
            </span>
          </p>
        </>
      )}
      {error && previewIsCurrent && (
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
      title={t('pageimg.spine.title')}
      icon={<BookOpen size={18} />}
      description={t('pageimg.spine.description')}
      preview={previewContent}
      warnings={warnings}
      running={busy}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId).catch(showError) : undefined}
      onRun={() => void apply()}
      canRun={!signed && !busy && !!aParams && previewIsCurrent && visibleRows.length > 0}
      runLabel={t('pageimg.spine.apply')}
      workflowStep={
        mode === 'auto'
          ? { op: 'pageimg.splitSpread', params: { order: 'ltr' }, label: t('pageimg.spine.title') }
          : undefined
      }
      size="xl"
    >
      <Field
        label={t('pageimg.spine.pages')}
        htmlFor="spine-pages"
        hint={t('pageimg.spine.pagesHint')}
        error={pagesText.trim() && !aParams ? t('pageimg.spine.invalidPages') : undefined}
      >
        <TextInput
          id="spine-pages"
          value={pagesText}
          placeholder={t('pageimg.spine.pagesPlaceholder')}
          onChange={(e) => setPagesText(e.target.value)}
          disabled={busy}
        />
      </Field>
      <div className="spine-modes" role="radiogroup" aria-label={t('pageimg.spine.mode')}>
        <label>
          <input
            type="radio"
            name="spine-mode"
            value="auto"
            checked={mode === 'auto'}
            onChange={() => setMode('auto')}
          />
          {t('pageimg.spine.modeAuto')}
        </label>
        <label>
          <input
            type="radio"
            name="spine-mode"
            value="manual"
            checked={mode === 'manual'}
            onChange={() => setMode('manual')}
          />
          {t('pageimg.spine.modeManual')}
        </label>
      </div>
      {mode === 'manual' && (
        <Field
          label={t('pageimg.spine.position', { value: shownPercent.toFixed(1) })}
          htmlFor="spine-x"
        >
          <input
            id="spine-x"
            type="range"
            min={SPINE_MIN_PERCENT}
            max={SPINE_MAX_PERCENT}
            step={0.1}
            value={shownPercent}
            disabled={!row || busy}
            onChange={(e) => setPercent(Number(e.target.value))}
          />
        </Field>
      )}
      <div className="spine-actions">
        <Button
          variant="secondary"
          onClick={() => void requestPreview()}
          disabled={!pParams || signed || busy}
        >
          {t('pageimg.spine.preview')}
        </Button>
      </div>
    </TaskDialog>
  );
}
