import { useTranslation } from 'react-i18next';
import { chef } from '../../lib/bridge';
import { Segmented } from '../../components/Form';
import { Slider } from '../../components/Slider';
import type { ScanPreviewData } from './scanModel';

export type CompareMode = 'side' | 'slider';

export interface PreviewView {
  sample: number;
  compare: CompareMode;
  /** 100% zoom (real pixels) instead of fitting the column. */
  actual: boolean;
  /** Divider position of the slider compare, 0..100. */
  split: number;
}

export const DEFAULT_PREVIEW_VIEW: PreviewView = {
  sample: 0,
  compare: 'side',
  actual: false,
  split: 50,
};

export interface ScanPreviewPaneProps {
  data: ScanPreviewData | null;
  loading: boolean;
  error: string | null;
  view: PreviewView;
  onViewChange(next: PreviewView): void;
}

/** K5: original and result of the sample pages, side by side or with a slider; optional 100% zoom. */
export function ScanPreviewPane({
  data,
  loading,
  error,
  view,
  onViewChange,
}: ScanPreviewPaneProps) {
  const { t } = useTranslation();
  const samples = data?.samples ?? [];

  if (error) return <p className="field__error">{error}</p>;
  if (samples.length === 0) {
    return <p className="muted">{loading ? t('scan.previewLoading') : t('scan.previewEmpty')}</p>;
  }

  const index = Math.min(view.sample, samples.length - 1);
  const sample = samples[index]!;
  const originalUrl = chef().files.toUrl(sample.originalPath);
  const resultUrl = chef().files.toUrl(sample.resultPath);
  const set = (patch: Partial<PreviewView>) => onViewChange({ ...view, ...patch });

  return (
    <div className="scan-preview">
      <div className="scan-preview__bar">
        <Segmented<CompareMode>
          aria-label={t('scan.compare.label')}
          value={view.compare}
          onChange={(compare) => set({ compare })}
          options={[
            { value: 'side', label: t('scan.compare.side') },
            { value: 'slider', label: t('scan.compare.slider') },
          ]}
        />
        <Segmented<'fit' | 'actual'>
          aria-label={t('scan.zoom.label')}
          value={view.actual ? 'actual' : 'fit'}
          onChange={(z) => set({ actual: z === 'actual' })}
          options={[
            { value: 'fit', label: t('scan.zoom.fit') },
            { value: 'actual', label: t('scan.zoom.actual') },
          ]}
        />
      </div>
      {samples.length > 1 && (
        <div className="scan-preview__pages" role="group" aria-label={t('scan.samplePages')}>
          {samples.map((s, i) => (
            <button
              key={s.pageIndex}
              type="button"
              className="scan-preview__page"
              aria-pressed={i === index}
              onClick={() => set({ sample: i })}
            >
              {t('scan.pageN', { page: s.pageIndex + 1 })}
            </button>
          ))}
        </div>
      )}
      <div
        className={view.actual ? 'scan-preview__view is-actual' : 'scan-preview__view'}
        data-compare={view.compare}
      >
        {view.compare === 'side' ? (
          <div className="scan-preview__pair">
            <figure>
              <figcaption>{t('scan.original')}</figcaption>
              <img src={originalUrl} alt={t('scan.original')} width={sample.widthPx} />
            </figure>
            <figure>
              <figcaption>{t('scan.result')}</figcaption>
              <img src={resultUrl} alt={t('scan.result')} width={sample.widthPx} />
            </figure>
          </div>
        ) : (
          <div className="scan-cmp">
            <img className="scan-cmp__result" src={resultUrl} alt={t('scan.result')} />
            <img
              className="scan-cmp__original"
              src={originalUrl}
              alt={t('scan.original')}
              style={{ clipPath: `inset(0 ${100 - view.split}% 0 0)` }}
            />
            <div className="scan-cmp__handle" style={{ left: `${view.split}%` }} aria-hidden />
          </div>
        )}
      </div>
      {view.compare === 'slider' && (
        <Slider
          value={view.split}
          min={0}
          max={100}
          label={t('scan.compare.split')}
          onChange={(split) => set({ split })}
        />
      )}
      <div className="scan-preview__meta muted">
        {t('scan.sampleMeta', { width: sample.widthPx, height: sample.heightPx })}
      </div>
    </div>
  );
}
