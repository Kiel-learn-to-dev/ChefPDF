import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, Save, ScanLine, Trash2 } from 'lucide-react';
import type { ScanRasterizeParams } from '@chef/contracts';
import { useActiveDoc, useDocs } from '../../app/state/documents';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { errorMessage, openFiles, PDF_FILTERS, runDocOp, showError } from '../../app/actions';
import { TaskDialog } from '../../components/TaskDialog';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Select, Switch, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { call, cancelJob, runOp } from '../../lib/rpc';
import { formatBytes } from '../../lib/format';
import { i18n } from '../../i18n';
import { jobProgress, useJobStore } from '../jobs/jobStore';
import { PreviewScheduler } from './previewScheduler';
import { ScanPreviewPane, DEFAULT_PREVIEW_VIEW, type PreviewView } from './ScanPreview';
import {
  DEFAULT_SCAN_FORM,
  DPI_CHOICES,
  DPI_MAX,
  DPI_MIN,
  applyParams,
  buildParams,
  dpiLimitFromError,
  durationParts,
  formIssues,
  localizeWarning,
  mergePresetOptions,
  parseMegabytes,
  presetParamsOf,
  validatePresetName,
  type BuiltinPreset,
  type FormField,
  type PresetNameIssue,
  type ScanColor,
  type ScanEffectsPreset,
  type ScanFitData,
  type ScanForm,
  type ScanPreviewData,
} from './scanModel';
import './ScanDialog.css';

const CUSTOM_PRESET = 'custom';

/** A preview result, tagged with the options it was made for (see `requestKey`). */
interface PreviewResult {
  key: string;
  data: ScanPreviewData;
}

/** K5: the preview is a quick, silent run of the session op (not a job-panel entry). */
async function runPreview(
  docId: string,
  params: ScanRasterizeParams,
  onStarted: (jobId: string) => void,
): Promise<PreviewResult> {
  const result = await runOp('scan.preview', params, {
    sessionId: docId,
    title: i18n.t('scan.previewTitle'),
    silent: true,
    onStarted,
  });
  return { key: JSON.stringify(params), data: result.data as ScanPreviewData };
}

/** Shows the core's dpi limit in the form instead of an error. Returns true when handled. */
function clampToDpiLimit(
  error: unknown,
  setForm: (update: (f: ScanForm) => ScanForm) => void,
  setNotice: (text: string) => void,
): boolean {
  const err = toChefError(error);
  const limit = dpiLimitFromError(err.kind, err.detail);
  if (limit === null) return false;
  setForm((f) => ({ ...f, dpi: Math.min(f.dpi, limit) }));
  setNotice(i18n.t('scan.dpiLimited', { dpi: limit }));
  return true;
}

function timeText(seconds: number): string {
  const { unit, value } = durationParts(seconds);
  return unit === 'seconds'
    ? i18n.t('scan.durationSeconds', { value })
    : i18n.t('scan.durationMinutes', { value });
}

/** Number shown in a number input; NaN (empty field) shows as blank. */
const numberValue = (n: number) => (Number.isFinite(n) ? n : '');

/** Opens the scan dialog for the active document; asks for a PDF first when none is open. */
export async function openScanFlow(): Promise<void> {
  if (!useDocs.getState().activeId) {
    const [path] = await chef().files.openDialog({ multiple: false, filters: PDF_FILTERS });
    if (!path) return;
    await openFiles([path]);
  }
  if (useDocs.getState().activeId) useUi.getState().openDialog('scan');
}

/** C-K: "Chuyển thành bản scan" (K1-K10). Built on the shared TaskDialog template. */
export function ScanDialog() {
  const { t, i18n: i18nHook } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const userPresets = useSettings((s) => s.settings.scanPresets);
  const updateSettings = useSettings((s) => s.update);
  const docId = doc?.id;
  const pageCount = doc?.info.pageCount ?? 0;
  const signed = doc?.state.signed ?? false;

  const [form, setForm] = useState<ScanForm>(DEFAULT_SCAN_FORM);
  const [presetKey, setPresetKey] = useState(CUSTOM_PRESET);
  const [builtins, setBuiltins] = useState<BuiltinPreset[]>([]);
  const [dpiCustom, setDpiCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetIssue, setPresetIssue] = useState<PresetNameIssue | null>(null);
  const [result, setResult] = useState<{
    key: string;
    data: ScanPreviewData | null;
    error: string | null;
  } | null>(null);
  const requestedKey = useRef('');
  const [view, setView] = useState<PreviewView>(DEFAULT_PREVIEW_VIEW);
  const [notice, setNotice] = useState<string | null>(null);
  const [fitMb, setFitMb] = useState('5');
  const [fitBusy, setFitBusy] = useState(false);
  const [fitResult, setFitResult] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [done, setDone] = useState<{ warnings: string[] } | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));
  const schedulerRef = useRef<PreviewScheduler<ScanRasterizeParams, PreviewResult> | null>(null);

  const language = i18nHook.language;
  const options = useMemo(
    () => mergePresetOptions(builtins, userPresets, language),
    [builtins, userPresets, language],
  );

  // Built-in presets come from the core (scan.presets).
  useEffect(() => {
    let alive = true;
    call('scan.presets', {})
      .then((list) => alive && setBuiltins(list))
      .catch((e: unknown) => alive && showError(e));
    return () => {
      alive = false;
    };
  }, []);

  // One scheduler per document: debounced, latest-wins preview runs.
  useEffect(() => {
    if (!docId) return;
    const scheduler = new PreviewScheduler<ScanRasterizeParams, PreviewResult>(
      {
        run: (params, onStarted) => runPreview(docId, params, onStarted),
        cancel: (id) => void cancelJob(id).catch(() => undefined),
      },
      {
        onResult: ({ key, data }) => setResult({ key, data, error: null }),
        onError: (e) => {
          if (clampToDpiLimit(e, setForm, setNotice)) return;
          // Errors are only reported for the latest request, so its key is the right one.
          const key = requestedKey.current;
          setResult((prev) => ({ key, data: prev?.data ?? null, error: errorMessage(e) }));
        },
        isCancelled: (e) => toChefError(e).kind === 'CANCELLED',
      },
    );
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, [docId]);

  const issues: FormField[] = doc ? formIssues(form, pageCount) : [];
  const params = doc ? buildParams(form, pageCount) : null;
  const requestKey = params && !signed && !done ? JSON.stringify(params) : null;

  // Every change of the options asks for a new preview (debounced by the scheduler).
  useEffect(() => {
    if (requestKey === null) return;
    requestedKey.current = requestKey;
    schedulerRef.current?.request(JSON.parse(requestKey) as ScanRasterizeParams);
  }, [requestKey]);

  // The preview is loading while the shown result belongs to older options.
  const preview = {
    data: result?.data ?? null,
    error: result?.error ?? null,
    loading: requestKey !== null && result?.key !== requestKey,
  };

  if (!doc) return null;

  const set = (patch: Partial<ScanForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPresetKey(CUSTOM_PRESET);
    setFitResult(null);
  };

  const applyPreset = (key: string) => {
    if (key === CUSTOM_PRESET) {
      setPresetKey(CUSTOM_PRESET);
      return;
    }
    const option = options.find((o) => o.key === key);
    if (!option) return;
    setForm((f) => applyParams(f, option.params));
    setPresetKey(key);
    setNotice(null);
    setFitResult(null);
  };

  const selected = options.find((o) => o.key === presetKey);
  const takenNames = [
    ...builtins.flatMap((b) => [b.labelVi, b.labelEn, b.name]),
    ...userPresets.map((p) => p.name),
  ];

  const savePreset = () => {
    const check = validatePresetName(presetName, takenNames);
    if (!check.ok) {
      setPresetIssue(check.issue);
      return;
    }
    const params = presetParamsOf(form, pageCount);
    if (!params) return;
    setPresetIssue(null);
    updateSettings({ scanPresets: [...userPresets, { name: check.name, params }] })
      .then(() => {
        setSaving(false);
        setPresetName('');
        setPresetKey(`user:${check.name}`);
      })
      .catch((e: unknown) => showError(e));
  };

  const deletePreset = () => {
    if (selected?.source !== 'user') return;
    setPresetKey(CUSTOM_PRESET);
    updateSettings({ scanPresets: userPresets.filter((p) => p.name !== selected.name) }).catch(
      (e: unknown) => showError(e),
    );
  };

  const fit = async () => {
    const targetBytes = parseMegabytes(fitMb);
    if (!targetBytes || !params) return;
    setFitBusy(true);
    try {
      const fitRun = await runOp(
        'scan.fitSize',
        { ...params, targetBytes },
        { sessionId: doc.id, title: t('scan.fitTitle'), silent: true },
      );
      const data = fitRun.data as ScanFitData;
      setForm((f) => applyParams(f, data.params));
      setPresetKey(CUSTOM_PRESET);
      setFitResult(
        data.reachable
          ? t('scan.fit.done', {
              dpi: data.params.dpi,
              quality: data.params.jpegQuality ?? '–',
              size: formatBytes(data.estimatedBytes, language),
            })
          : t('scan.fit.unreachable', {
              mb: fitMb,
              dpi: data.params.dpi,
              quality: data.params.jpegQuality ?? '–',
              size: formatBytes(data.estimatedBytes, language),
            }),
      );
    } catch (e) {
      if (!clampToDpiLimit(e, setForm, setNotice)) showError(e);
    } finally {
      setFitBusy(false);
    }
  };

  const run = async () => {
    if (!params) return;
    setNotice(null);
    const applied = await runDocOp(
      doc.id,
      'scan.rasterize',
      params,
      t('scan.jobTitle', { name: doc.name }),
      {
        onStarted: setJobId,
        toastWarnings: false,
        onError: (e) => clampToDpiLimit(e, setForm, setNotice),
      },
    );
    setJobId(null);
    if (applied) setDone({ warnings: applied.warnings });
  };

  if (done) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && close()}
        icon={<CircleCheck size={18} />}
        title={t('scan.doneTitle')}
        description={t('scan.doneText', {
          count: params ? (params.pages?.length ?? pageCount) : pageCount,
        })}
        footer={
          <>
            <DialogSpacer />
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        {done.warnings.length > 0 && (
          <ul className="task__warnings" role="status">
            {done.warnings.map((w) => (
              <li key={w}>{warningText(w)}</li>
            ))}
          </ul>
        )}
      </Dialog>
    );
  }

  const estimate = preview.data?.estimate;
  const warnings: string[] = [];
  if (signed) warnings.push(t('scan.signedBlocked'));
  if (notice) warnings.push(notice);
  for (const w of new Set(estimate?.lossWarnings ?? [])) warnings.push(warningText(w));

  const dpiSelected = !dpiCustom && (DPI_CHOICES as readonly number[]).includes(form.dpi);
  const dpiOptions = [
    ...DPI_CHOICES.map((d) => ({ value: String(d), label: t('scan.dpiChoice', { dpi: d }) })),
    { value: 'custom', label: t('scan.dpiCustom') },
  ];
  const colorOptions = [
    { value: 'color' as const, label: t('scan.colorMode.color') },
    { value: 'gray' as const, label: t('scan.colorMode.gray') },
    { value: 'bw' as const, label: t('scan.colorMode.bw') },
  ];
  const effectOptions: { value: ScanEffectsPreset; label: string }[] = [
    { value: 'none', label: t('scan.effects.none') },
    { value: 'light', label: t('scan.effects.light') },
    { value: 'photocopy', label: t('scan.effects.photocopy') },
    { value: 'old-paper', label: t('scan.effects.oldPaper') },
  ];

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('scan.title')}
      icon={<ScanLine size={18} />}
      description={t('scan.description', { name: doc.name, count: pageCount })}
      size="xl"
      sideWidth={440}
      preset={{
        value: presetKey,
        onChange: applyPreset,
        options: [
          { value: CUSTOM_PRESET, label: t('scan.presetCustom') },
          ...options.map((o) => ({ value: o.key, label: o.label })),
        ],
        actions: (
          <>
            <IconButton
              label={t('scan.presetSave')}
              icon={<Save size={15} />}
              disabled={!params}
              onClick={() => {
                setSaving((s) => !s);
                setPresetIssue(null);
              }}
            />
            {selected?.source === 'user' && (
              <IconButton
                label={t('scan.presetDelete')}
                icon={<Trash2 size={15} />}
                onClick={deletePreset}
              />
            )}
          </>
        ),
      }}
      runLabel={t('scan.run')}
      onRun={() => void run()}
      canRun={!!params && !signed && !jobId && !fitBusy}
      running={!!jobId}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId) : undefined}
      warnings={warnings}
      estimate={
        estimate
          ? t('scan.estimateValue', {
              size: formatBytes(estimate.estimatedBytes, language),
              time: timeText(estimate.estimatedSeconds),
            })
          : preview.loading
            ? t('scan.estimating')
            : '–'
      }
      preview={
        <ScanPreviewPane
          data={preview.data}
          loading={preview.loading}
          error={preview.error}
          view={view}
          onViewChange={setView}
        />
      }
      advanced={
        <>
          {form.color === 'bw' && (
            <>
              <Field
                label={t('scan.threshold')}
                htmlFor="scan-threshold"
                hint={t('scan.thresholdHint')}
                error={issues.includes('threshold') ? t('scan.invalidThreshold') : undefined}
              >
                <TextInput
                  id="scan-threshold"
                  type="number"
                  min={0}
                  max={255}
                  value={numberValue(form.threshold)}
                  invalid={issues.includes('threshold')}
                  onChange={(e) => set({ threshold: Number(e.target.value) })}
                />
              </Field>
              <Switch
                checked={form.dithering}
                onChange={(dithering) => set({ dithering })}
                label={t('scan.dithering')}
              />
            </>
          )}
          <Field label={t('scan.effectsLabel')} htmlFor="scan-effects" hint={t('scan.effectsHint')}>
            <Select<ScanEffectsPreset>
              id="scan-effects"
              value={form.effectsPreset}
              onChange={(effectsPreset) => set({ effectsPreset })}
              options={effectOptions}
              aria-label={t('scan.effectsLabel')}
            />
          </Field>
          <Field
            label={t('scan.seed')}
            htmlFor="scan-seed"
            hint={t('scan.seedHint')}
            error={issues.includes('seed') ? t('scan.invalidSeed') : undefined}
          >
            <TextInput
              id="scan-seed"
              type="number"
              min={0}
              value={numberValue(form.seed)}
              invalid={issues.includes('seed')}
              onChange={(e) => set({ seed: Number(e.target.value) })}
            />
          </Field>
          <Checkbox
            checked={form.stripMetadata}
            onChange={(stripMetadata) => set({ stripMetadata })}
            label={t('scan.stripMetadata')}
            hint={t('scan.stripMetadataHint')}
          />
        </>
      }
    >
      {saving && (
        <Field
          label={t('scan.presetName')}
          htmlFor="scan-preset-name"
          error={presetIssue ? t(`scan.presetIssue.${presetIssue}`, { max: 60 }) : undefined}
        >
          <div className="field__row">
            <TextInput
              id="scan-preset-name"
              value={presetName}
              invalid={presetIssue !== null}
              autoFocus
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && savePreset()}
            />
            <Button variant="primary" onClick={savePreset}>
              {t('scan.presetSaveConfirm')}
            </Button>
          </div>
        </Field>
      )}
      <Field
        label={t('scan.dpi')}
        htmlFor="scan-dpi"
        error={
          issues.includes('dpi') ? t('scan.invalidDpi', { min: DPI_MIN, max: DPI_MAX }) : undefined
        }
      >
        <div className="field__row">
          <Select
            id="scan-dpi"
            value={dpiSelected ? String(form.dpi) : 'custom'}
            onChange={(v) => {
              if (v === 'custom') setDpiCustom(true);
              else {
                setDpiCustom(false);
                set({ dpi: Number(v) });
              }
            }}
            options={dpiOptions}
            aria-label={t('scan.dpi')}
          />
          {!dpiSelected && (
            <TextInput
              type="number"
              min={DPI_MIN}
              max={DPI_MAX}
              step={1}
              aria-label={t('scan.dpiCustomValue')}
              value={numberValue(form.dpi)}
              invalid={issues.includes('dpi')}
              onChange={(e) => set({ dpi: Number(e.target.value) })}
            />
          )}
        </div>
      </Field>
      <Field label={t('scan.colorLabel')}>
        <RadioGroup<ScanColor>
          value={form.color}
          onChange={(color) => set({ color })}
          options={colorOptions}
          aria-label={t('scan.colorLabel')}
        />
      </Field>
      <Field
        label={t('scan.jpegQuality')}
        htmlFor="scan-jpeg"
        hint={t('scan.jpegQualityHint')}
        error={issues.includes('jpegQuality') ? t('scan.invalidJpeg') : undefined}
      >
        <TextInput
          id="scan-jpeg"
          type="number"
          min={1}
          max={100}
          value={numberValue(form.jpegQuality)}
          invalid={issues.includes('jpegQuality')}
          onChange={(e) => set({ jpegQuality: Number(e.target.value) })}
        />
      </Field>
      <Field
        label={t('scan.pages')}
        htmlFor="scan-pages"
        hint={t('scan.pagesHint', { count: pageCount })}
        error={issues.includes('pages') ? t('scan.invalidPages', { count: pageCount }) : undefined}
      >
        <TextInput
          id="scan-pages"
          value={form.pagesText}
          placeholder={t('scan.allPages')}
          invalid={issues.includes('pages')}
          onChange={(e) => set({ pagesText: e.target.value })}
        />
      </Field>
      <Field label={t('scan.fitLabel')} htmlFor="scan-fit" hint={t('scan.fitHint')}>
        <div className="field__row">
          <TextInput
            id="scan-fit"
            type="number"
            min={0.1}
            step={0.5}
            value={fitMb}
            onChange={(e) => setFitMb(e.target.value)}
          />
          <span className="muted">{t('scan.unitMb')}</span>
          <Button
            onClick={() => void fit()}
            disabled={!parseMegabytes(fitMb) || !params || signed}
            loading={fitBusy}
          >
            {t('scan.fitRun')}
          </Button>
        </div>
        {fitResult && <div className="scan__fit-result">{fitResult}</div>}
      </Field>
    </TaskDialog>
  );
}

/** Core warnings are English; known ones are translated, anything else is shown as is. */
function warningText(message: string): string {
  const key = localizeWarning(message);
  return key ? i18n.t(key) : message;
}
