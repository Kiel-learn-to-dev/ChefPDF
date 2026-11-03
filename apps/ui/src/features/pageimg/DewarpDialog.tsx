import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanLine } from 'lucide-react';
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
import { applyParams, previewParams, readPreviewData, reviewPages } from './dewarpModel';
import type { DewarpPreviewData } from './dewarpModel';
import './dewarp.css';

interface PreviewState {
  key: string;
  data: DewarpPreviewData;
}

/** L13: the user reviews before/after samples and confidence before applying to selected pages. */
export function DewarpDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [pagesText, setPagesText] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [selectedPreview, setSelectedPreview] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<'preview' | 'apply' | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));

  const pageCount = doc?.info.pageCount ?? 0;
  const signed = doc?.state.signed ?? false;
  const pParams = useMemo(() => previewParams(pagesText, pageCount), [pagesText, pageCount]);
  const aParams = useMemo(() => applyParams(pagesText, pageCount), [pagesText, pageCount]);
  const previewIsCurrent = preview?.key === pagesText.trim();
  const rows = previewIsCurrent ? (preview?.data.pages ?? []) : [];
  const visibleRows = rows.filter((r) => r.status === 'done');
  const row = visibleRows[Math.min(selectedPreview, visibleRows.length - 1)];
  const warnings = [];
  const lowConfidencePages = rows
    .filter((r) => r.status === 'done' && (r.confidence ?? 0) < 0.35)
    .map((r) => r.pageIndex + 1);
  const skippedPages = rows.filter((r) => r.status === 'skipped').map((r) => r.pageIndex + 1);
  if (lowConfidencePages.length) {
    warnings.push(t('pageimg.dewarp.reviewWarning', { pages: lowConfidencePages.join(', ') }));
  }
  if (skippedPages.length) {
    warnings.push(t('pageimg.dewarp.skippedWarning', { pages: skippedPages.join(', ') }));
  }
  if (!doc) return null;

  const requestPreview = async () => {
    if (!pParams || signed || busy) return;
    setBusy(true);
    setBusyKind('preview');
    setError(null);
    setJobId(null);
    try {
      const result = await runOp('pageimg.dewarpPreview', pParams, {
        sessionId: doc.id,
        title: t('pageimg.dewarp.preview'),
        silent: true,
        onStarted: setJobId,
      });
      setPreview({ key: pagesText.trim(), data: readPreviewData(result.data) });
      setSelectedPreview(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setBusyKind(null);
      setJobId(null);
    }
  };

  const apply = async () => {
    if (!aParams || !previewIsCurrent || visibleRows.length === 0 || signed || busy) return;
    setBusy(true);
    setBusyKind('apply');
    setError(null);
    setJobId(null);
    try {
      const result = await runDocOp(
        doc.id,
        'pageimg.dewarp',
        aParams,
        t('pageimg.dewarp.job', { name: doc.name }),
        { onStarted: setJobId },
      );
      if (result) {
        const needsReview = reviewPages(result.data);
        if (needsReview.length) {
          toast.warning(
            t('pageimg.dewarp.title'),
            t('pageimg.dewarp.applyReview', {
              pages: needsReview.map((page) => page + 1).join(', '),
            }),
          );
        }
        close();
      }
    } catch (e) {
      showError(e, t('pageimg.dewarp.title'));
    } finally {
      setBusy(false);
      setBusyKind(null);
      setJobId(null);
    }
  };

  const previewContent = (
    <div className="dewarp-preview">
      {!previewIsCurrent || visibleRows.length === 0 ? (
        <p className="muted" role="status">
          {error ?? t('pageimg.dewarp.previewEmpty')}
        </p>
      ) : (
        <>
          {visibleRows.length > 1 && (
            <div
              className="dewarp-preview__pages"
              role="group"
              aria-label={t('pageimg.dewarp.pages')}
            >
              {visibleRows.map((item, index) => (
                <button
                  key={item.pageIndex}
                  type="button"
                  aria-pressed={index === selectedPreview}
                  onClick={() => setSelectedPreview(index)}
                >
                  {t('scan.pageN', { page: item.pageIndex + 1 })}
                </button>
              ))}
            </div>
          )}
          {row && (
            <>
              <div className="dewarp-preview__images">
                <figure>
                  <figcaption>{t('pageimg.dewarp.original')}</figcaption>
                  <img
                    src={chef().files.toUrl(row.originalPath!)}
                    alt={t('pageimg.dewarp.original')}
                  />
                </figure>
                <figure>
                  <figcaption>{t('pageimg.dewarp.result')}</figcaption>
                  <img src={chef().files.toUrl(row.resultPath!)} alt={t('pageimg.dewarp.result')} />
                </figure>
              </div>
              <p className="dewarp-preview__meta" role="status">
                {t('pageimg.dewarp.confidence', {
                  value: Math.round((row.confidence ?? 0) * 100),
                })}
                <span>{t('pageimg.dewarp.correction', { value: row.correctionPx ?? 0 })}</span>
              </p>
            </>
          )}
          {error && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(open) => !open && close()}
      title={t('pageimg.dewarp.title')}
      icon={<ScanLine size={18} />}
      description={t('pageimg.dewarp.description')}
      preview={previewContent}
      warnings={warnings}
      running={busy}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId).catch(showError) : undefined}
      onRun={() => void apply()}
      canRun={!signed && !busy && !!aParams && previewIsCurrent && visibleRows.length > 0}
      runLabel={t('pageimg.dewarp.apply')}
      size="xl"
    >
      <Field
        label={t('pageimg.dewarp.pages')}
        htmlFor="dewarp-pages"
        hint={t('pageimg.dewarp.pagesHint')}
        error={pagesText.trim() && !aParams ? t('pageimg.dewarp.invalidPages') : undefined}
      >
        <TextInput
          id="dewarp-pages"
          value={pagesText}
          invalid={pagesText.trim() !== '' && !aParams}
          onChange={(event) => setPagesText(event.target.value)}
          placeholder={t('scan.allPages')}
          disabled={busy || signed}
        />
      </Field>
      {signed && (
        <p className="field__error" role="alert">
          {t('pageTools.signedBlocked')}
        </p>
      )}
      <Button
        variant="secondary"
        onClick={() => void requestPreview()}
        disabled={!pParams || busy || signed}
        loading={busyKind === 'preview'}
      >
        {t('pageimg.dewarp.preview')}
      </Button>
      {previewIsCurrent && rows.length > 0 && (
        <p className="muted" role="status">
          {t('pageimg.dewarp.previewCount', { count: pParams?.pages.length ?? 0 })}
        </p>
      )}
    </TaskDialog>
  );
}
