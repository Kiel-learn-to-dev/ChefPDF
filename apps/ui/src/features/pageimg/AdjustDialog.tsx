import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal } from 'lucide-react';
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
  applyParams,
  CURVE_INPUTS,
  DEFAULT_ADJUST,
  dpiValid,
  levelsValid,
  parseAdjustPage,
  previewParams,
} from './adjustModel';
import type { AdjustState } from './adjustModel';
import './adjust.css';

interface Pictures {
  key: string;
  before: string;
  after: string;
}

/** T8.02: clean up and tone a scanned page (levels, curve, contrast, invert, grey, DPI). */
export function AdjustDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [state, setState] = useState<AdjustState>(DEFAULT_ADJUST);
  const [pagesText, setPagesText] = useState('');
  const [previewPage, setPreviewPage] = useState('');
  const [pictures, setPictures] = useState<Pictures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));

  const pageCount = doc?.info.pageCount ?? 0;
  const signed = doc?.state.signed ?? false;
  const shownPage = parseAdjustPage(previewPage, pageCount);
  const pictureKey = `${shownPage}|${JSON.stringify(state)}`;
  const pictureIsCurrent = !!pictures && pictures.key === pictureKey;
  const aParams = useMemo(
    () => applyParams(state, pagesText, pageCount),
    [state, pagesText, pageCount],
  );
  const canRun = !!aParams && !signed && !busy;
  // A workflow step runs on every file, so it carries the settings without the page list.
  const stepSettings = useMemo(() => {
    const settings = applyParams(state, '', pageCount);
    return settings && !pagesText.trim() ? (settings as Record<string, unknown>) : null;
  }, [state, pagesText, pageCount]);

  if (!doc) return null;

  const set = <K extends keyof AdjustState>(key: K, value: AdjustState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  const showPreview = async () => {
    if (shownPage === null || busy || signed) return;
    const params = previewParams(state, shownPage);
    if (!params) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      const before = await runOp(
        'pageimg.pagePreview',
        { pageIndex: shownPage },
        {
          sessionId: doc.id,
          title: t('pageimg.adjust.preview'),
          silent: true,
          onStarted: setJobId,
        },
      );
      const after = await runOp('pageimg.enhancePreview', params, {
        sessionId: doc.id,
        title: t('pageimg.adjust.preview'),
        silent: true,
        onStarted: setJobId,
      });
      const beforePath = (before.data as { previewPath?: string }).previewPath;
      const afterPath = (after.data as { previewPath?: string }).previewPath;
      if (!beforePath || !afterPath) {
        setPictures(null);
        setError(t('pageimg.adjust.noPicture'));
        return;
      }
      setPictures({
        key: `${shownPage}|${JSON.stringify(state)}`,
        before: beforePath,
        after: afterPath,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const apply = async () => {
    if (!aParams || !canRun) return;
    setBusy(true);
    setError(null);
    setJobId(null);
    try {
      await runDocOp(
        doc.id,
        'pageimg.enhance',
        aParams,
        t('pageimg.adjust.job', { name: doc.name }),
        {
          onStarted: setJobId,
        },
      );
      close();
    } catch (e) {
      showError(e, t('pageimg.adjust.title'));
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    id: string,
  ): ReactNode => (
    <Field label={`${label}: ${value}`} htmlFor={id}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );

  const previewContent = (
    <div className="adjust-preview">
      {pictureIsCurrent && pictures ? (
        <div className="adjust-preview__pair">
          <figure>
            <figcaption>{t('pageimg.adjust.before')}</figcaption>
            <img src={chef().files.toUrl(pictures.before)} alt={t('pageimg.adjust.before')} />
          </figure>
          <figure>
            <figcaption>{t('pageimg.adjust.after')}</figcaption>
            <img src={chef().files.toUrl(pictures.after)} alt={t('pageimg.adjust.after')} />
          </figure>
        </div>
      ) : (
        <p className="muted" role="status">
          {error ?? t('pageimg.adjust.previewEmpty')}
        </p>
      )}
      {error && pictureIsCurrent && (
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
      title={t('pageimg.adjust.title')}
      icon={<SlidersHorizontal size={18} />}
      description={t('pageimg.adjust.description')}
      preview={previewContent}
      running={busy}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId).catch(showError) : undefined}
      onRun={() => void apply()}
      canRun={canRun}
      runLabel={t('pageimg.adjust.apply')}
      workflowStep={stepSettings ? { op: 'pageimg.enhance', params: stepSettings, label: t('pageimg.adjust.title') } : undefined}
      size="xl"
    >
      <div className="adjust-grid">
        <Field
          label={t('pageimg.adjust.pages')}
          htmlFor="adjust-pages"
          hint={t('pageimg.adjust.pagesHint')}
          error={pagesText.trim() && !aParams ? t('pageimg.adjust.invalidPages') : undefined}
        >
          <TextInput
            id="adjust-pages"
            value={pagesText}
            placeholder={t('pageimg.adjust.pagesPlaceholder')}
            onChange={(e) => setPagesText(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field
          label={t('pageimg.adjust.previewPage')}
          htmlFor="adjust-preview-page"
          error={
            previewPage.trim() && shownPage === null ? t('pageimg.adjust.invalidPage') : undefined
          }
        >
          <div className="adjust-inline">
            <TextInput
              id="adjust-preview-page"
              value={previewPage}
              placeholder="1"
              onChange={(e) => setPreviewPage(e.target.value)}
              disabled={busy}
            />
            <Button
              variant="secondary"
              onClick={() => void showPreview()}
              disabled={
                shownPage === null || busy || signed || !levelsValid(state) || !dpiValid(state)
              }
            >
              {t('pageimg.adjust.preview')}
            </Button>
          </div>
        </Field>

        <fieldset className="adjust-group">
          <legend>{t('pageimg.adjust.cleanup')}</legend>
          <label>
            <input
              type="checkbox"
              checked={state.whiten}
              onChange={(e) => set('whiten', e.target.checked)}
            />
            {t('pageimg.adjust.whiten')}
          </label>
          {state.whiten &&
            slider(
              t('pageimg.adjust.strength'),
              state.whitenStrength,
              0,
              1,
              0.05,
              (v) => set('whitenStrength', v),
              'adjust-whiten',
            )}
          <label>
            <input
              type="checkbox"
              checked={state.denoise}
              onChange={(e) => set('denoise', e.target.checked)}
            />
            {t('pageimg.adjust.denoise')}
          </label>
          {state.denoise &&
            slider(
              t('pageimg.adjust.strength'),
              state.denoiseStrength,
              0,
              1,
              0.05,
              (v) => set('denoiseStrength', v),
              'adjust-denoise',
            )}
        </fieldset>

        <fieldset className="adjust-group">
          <legend>{t('pageimg.adjust.levels')}</legend>
          {slider(
            t('pageimg.adjust.black'),
            state.black,
            0,
            254,
            1,
            (v) => set('black', v),
            'adjust-black',
          )}
          {slider(
            t('pageimg.adjust.white'),
            state.white,
            1,
            255,
            1,
            (v) => set('white', v),
            'adjust-white',
          )}
          {slider(
            t('pageimg.adjust.gamma'),
            state.gamma,
            0.5,
            2.5,
            0.05,
            (v) => set('gamma', Math.round(v * 100) / 100),
            'adjust-gamma',
          )}
          {!levelsValid(state) && (
            <p className="field__error" role="alert">
              {t('pageimg.adjust.levelsInvalid')}
            </p>
          )}
        </fieldset>

        <fieldset className="adjust-group">
          <legend>{t('pageimg.adjust.curve')}</legend>
          {CURVE_INPUTS.map((input, i) =>
            slider(
              t('pageimg.adjust.curvePoint', { input }),
              state.curve[i]!,
              0,
              255,
              1,
              (v) =>
                setState((current) => ({
                  ...current,
                  curve: current.curve.map((out, j) => (j === i ? v : out)),
                })),
              `adjust-curve-${input}`,
            ),
          )}
        </fieldset>

        <fieldset className="adjust-group">
          <legend>{t('pageimg.adjust.tone')}</legend>
          {slider(
            t('pageimg.adjust.contrast'),
            state.contrast,
            -100,
            100,
            1,
            (v) => set('contrast', v),
            'adjust-contrast',
          )}
          {slider(
            t('pageimg.adjust.brightness'),
            state.brightness,
            -100,
            100,
            1,
            (v) => set('brightness', v),
            'adjust-brightness',
          )}
          <label>
            <input
              type="checkbox"
              checked={state.invert}
              onChange={(e) => set('invert', e.target.checked)}
            />
            {t('pageimg.adjust.invert')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.grayscale}
              onChange={(e) => set('grayscale', e.target.checked)}
            />
            {t('pageimg.adjust.grayscale')}
          </label>
        </fieldset>

        <fieldset className="adjust-group">
          <legend>{t('pageimg.adjust.resolution')}</legend>
          <Field
            label={t('pageimg.adjust.dpi')}
            htmlFor="adjust-dpi"
            hint={t('pageimg.adjust.dpiHint')}
            error={!dpiValid(state) ? t('pageimg.adjust.invalidDpi') : undefined}
          >
            <TextInput
              id="adjust-dpi"
              value={state.dpi}
              placeholder={t('pageimg.adjust.dpiPlaceholder')}
              onChange={(e) => set('dpi', e.target.value)}
              disabled={busy}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={state.resizePage}
              disabled={!state.dpi.trim()}
              onChange={(e) => set('resizePage', e.target.checked)}
            />
            {t('pageimg.adjust.resizePage')}
          </label>
        </fieldset>
      </div>
    </TaskDialog>
  );
}
