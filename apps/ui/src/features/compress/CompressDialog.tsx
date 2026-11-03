/**
 * "Nén PDF" (M1; T5.04): presets (built-in and the user's own), custom options, an exact size
 * estimate (slow: it runs the whole compression), "Nén sao cho ≤ X MB" (compress.fitSize applies
 * the params it finds), and the result with before / after size, ratio and skipped images.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Shrink, Trash2 } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, Field, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { toast } from '../../components/Toast';
import { runOp } from '../../lib/rpc';
import { NumberField } from '../overlay/OverlayControls';
import { savePrefs } from '../overlay/overlayActions';
import './compress.css';
import {
  BUILTIN_PRESETS,
  DEFAULT_COMPRESS_FORM,
  applyPreset,
  compressParams,
  formFromParams,
  formIssues,
  percentSaved,
  readCompressReport,
  readFitResult,
  readUserPresets,
  targetBytesOf,
  validatePresetName,
  type CompressForm,
  type CompressReport,
  type PresetChoice,
} from './compressModel';

const CUSTOM = 'custom';
const BUILTIN_PREFIX = 'builtin:';
const USER_PREFIX = 'user:';

/** Nén PDF (M1). */
export function CompressDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  // Select the stored value (stable reference) and parse it here: parsing inside the selector
  // returns a new array on every store read and makes React loop (error #185).
  const storedPresets = useSettings((s) => s.settings.compressPresets);
  const userPresets = useMemo(() => readUserPresets(storedPresets), [storedPresets]);
  const [form, setForm] = useState<CompressForm>(DEFAULT_COMPRESS_FORM);
  const [presetKey, setPresetKey] = useState<string>(`${BUILTIN_PREFIX}ebook`);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetIssue, setPresetIssue] = useState<string | null>(null);
  const [fitMb, setFitMb] = useState('5');
  const [busy, setBusy] = useState<'estimate' | 'fit' | 'run' | null>(null);
  const [estimate, setEstimate] = useState<CompressReport | null>(null);
  const [fitNote, setFitNote] = useState<string | null>(null);
  const [result, setResult] = useState<CompressReport | null>(null);
  if (!doc) return null;

  const signed = doc.state.signed;
  const issues = formIssues(form);
  const set = (patch: Partial<CompressForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPresetKey(CUSTOM);
    setEstimate(null);
    setFitNote(null);
  };
  const pickPreset = (key: string) => {
    setPresetKey(key);
    setEstimate(null);
    setFitNote(null);
    if (key === CUSTOM) {
      setForm((f) => ({ ...f, preset: 'custom' }));
    } else if (key.startsWith(BUILTIN_PREFIX)) {
      const p = key.slice(BUILTIN_PREFIX.length) as PresetChoice;
      setForm((f) => applyPreset(f, p));
    } else {
      const found = userPresets.find((p) => `${USER_PREFIX}${p.name}` === key);
      if (found) setForm(formFromParams(found.params));
    }
  };
  const params = () => compressParams(form);

  const presetOptions = [
    { value: CUSTOM, label: t('compress.presetCustom') },
    ...BUILTIN_PRESETS.map((p) => ({
      value: `${BUILTIN_PREFIX}${p}`,
      label: t(`compress.preset.${p}`),
    })),
    ...userPresets.map((p) => ({ value: `${USER_PREFIX}${p.name}`, label: p.name })),
  ];
  const selectedUser = userPresets.find((p) => `${USER_PREFIX}${p.name}` === presetKey);

  const savePreset = async () => {
    const taken = [
      ...BUILTIN_PRESETS.map((p) => t(`compress.preset.${p}`)),
      ...userPresets.map((p) => p.name),
    ];
    const issue = validatePresetName(presetName, taken);
    if (issue) {
      setPresetIssue(issue);
      return;
    }
    const name = presetName.trim();
    const next = [...userPresets, { name, params: { ...params() } }];
    try {
      await useSettings.getState().update({ compressPresets: next });
      setSaving(false);
      setPresetName('');
      setPresetIssue(null);
      setPresetKey(`${USER_PREFIX}${name}`);
    } catch (e) {
      showError(e);
    }
  };

  const deletePreset = async () => {
    if (!selectedUser) return;
    setPresetKey(CUSTOM);
    try {
      await useSettings
        .getState()
        .update({ compressPresets: userPresets.filter((p) => p.name !== selectedUser.name) });
    } catch (e) {
      showError(e);
    }
  };

  const runEstimate = async () => {
    setBusy('estimate');
    setEstimate(null);
    try {
      const r = await runOp('compress.estimate', params(), {
        sessionId: doc.id,
        title: t('compress.estimateJob', { name: doc.name }),
        silent: true,
      });
      setEstimate(readCompressReport(r.data));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const fit = async () => {
    const target = targetBytesOf(Number(fitMb.replace(',', '.')));
    if (target === null) return;
    setBusy('fit');
    setFitNote(null);
    try {
      const r = await runOp(
        'compress.fitSize',
        { ...params(), targetBytes: target },
        { sessionId: doc.id, title: t('compress.fitJob', { name: doc.name }), silent: true },
      );
      const fitted = readFitResult(r.data);
      if (!fitted) return;
      setForm(fitted.form);
      setPresetKey(CUSTOM);
      setFitNote(
        fitted.reachable
          ? t('compress.fit.done', { mb: fitMb, size: mb(fitted.estimatedBytes) })
          : t('compress.fit.unreachable', { mb: fitMb, size: mb(fitted.estimatedBytes) }),
      );
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (issues.length > 0 || signed) return;
    setBusy('run');
    setResult(null);
    savePrefs('compress', { ...form });
    const r = await runDocOp(
      doc.id,
      'compress.pdf',
      params(),
      t('compress.jobTitle', { name: doc.name }),
      {
        toastWarnings: false,
      },
    );
    setBusy(null);
    if (!r) return;
    const report = readCompressReport(r.data);
    setResult(report);
    toast.success(
      t('compress.title'),
      t('compress.doneToast', { percent: percentSaved(report.bytesBefore, report.bytesAfter) }),
    );
  };

  const warnings: string[] = [];
  if (signed) warnings.push(t('compress.signedBlocked'));
  if (issues.includes('dpi')) warnings.push(t('compress.invalidDpi'));
  if (issues.includes('quality')) warnings.push(t('compress.invalidQuality'));

  const shown = result ?? null;
  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && busy === null && close()}
      title={t('compress.title')}
      icon={<Shrink size={18} />}
      description={t('compress.description', { name: doc.name })}
      size="xl"
      sideWidth={380}
      preset={{
        value: presetKey,
        onChange: pickPreset,
        options: presetOptions,
        actions: (
          <>
            <IconButton
              label={t('compress.presetSave')}
              icon={<Save size={15} />}
              onClick={() => {
                setSaving((s) => !s);
                setPresetIssue(null);
              }}
            />
            {selectedUser && (
              <IconButton
                label={t('compress.presetDelete')}
                icon={<Trash2 size={15} />}
                onClick={() => void deletePreset()}
              />
            )}
          </>
        ),
      }}
      runLabel={t('compress.run')}
      onRun={() => void run()}
      canRun={issues.length === 0 && !signed && busy === null}
      running={busy === 'run'}
      warnings={warnings}
      workflowStep={{
        op: 'compress.pdf',
        params: params() as unknown as Record<string, unknown>,
        label: t('compress.title'),
      }}
      estimate={
        busy === 'estimate' ? (
          <Spinner label={t('compress.estimating')} />
        ) : estimate ? (
          <span>
            {t('compress.estimate.line', {
              before: mb(estimate.bytesBefore),
              after: mb(estimate.bytesAfter),
              percent: percentSaved(estimate.bytesBefore, estimate.bytesAfter),
            })}
          </span>
        ) : (
          <Button size="sm" onClick={() => void runEstimate()} disabled={busy !== null || signed}>
            {t('compress.estimateButton')}
          </Button>
        )
      }
      advanced={
        <>
          <Checkbox
            checked={form.removeUnused}
            onChange={(removeUnused) => set({ removeUnused })}
            label={t('compress.opt.removeUnused')}
            hint={t('compress.opt.removeUnusedHint')}
          />
          <Checkbox
            checked={form.removeThumbnails}
            onChange={(removeThumbnails) => set({ removeThumbnails })}
            label={t('compress.opt.removeThumbnails')}
          />
          <Checkbox
            checked={form.removeAttachments}
            onChange={(removeAttachments) => set({ removeAttachments })}
            label={t('compress.opt.removeAttachments')}
            hint={t('compress.opt.removeAttachmentsHint')}
          />
          <Checkbox
            checked={form.removeMetadata}
            onChange={(removeMetadata) => set({ removeMetadata })}
            label={t('compress.opt.removeMetadata')}
          />
          <Checkbox
            checked={form.subsetFonts}
            onChange={(subsetFonts) => set({ subsetFonts })}
            label={t('compress.opt.subsetFonts')}
          />
          <Checkbox
            checked={form.flattenTransparency}
            onChange={(flattenTransparency) => set({ flattenTransparency })}
            label={t('compress.opt.flatten')}
            hint={t('compress.opt.flattenHint')}
          />
        </>
      }
    >
      {saving && (
        <Field
          label={t('compress.presetName')}
          htmlFor="compress-preset-name"
          error={presetIssue ? t(`compress.presetIssue.${presetIssue}`, { max: 60 }) : undefined}
        >
          <div className="field__row">
            <TextInput
              id="compress-preset-name"
              value={presetName}
              invalid={presetIssue !== null}
              autoFocus
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void savePreset()}
            />
            <Button variant="primary" onClick={() => void savePreset()}>
              {t('compress.presetSaveConfirm')}
            </Button>
          </div>
        </Field>
      )}
      <NumberField
        id="compress-dpi"
        label={t('compress.maxDpi')}
        value={form.maxImageDpi ?? 0}
        min={0}
        max={1200}
        step={1}
        hint={t('compress.maxDpiHint')}
        invalid={issues.includes('dpi')}
        onChange={(v) => set({ maxImageDpi: v > 0 ? v : null })}
      />
      <NumberField
        id="compress-quality"
        label={t('compress.quality')}
        value={form.jpegQuality ?? 0}
        min={0}
        max={100}
        step={1}
        hint={t('compress.qualityHint')}
        invalid={issues.includes('quality')}
        onChange={(v) => set({ jpegQuality: v > 0 ? v : null })}
      />
      <Checkbox
        checked={form.grayscale}
        onChange={(grayscale) => set({ grayscale })}
        label={t('compress.opt.grayscale')}
        hint={t('compress.opt.grayscaleHint')}
      />
      <Field
        label={t('compress.fitLabel')}
        htmlFor="compress-fit"
        hint={fitNote ?? t('compress.fitHint')}
      >
        <div className="field__row">
          <TextInput
            id="compress-fit"
            size="sm"
            inputMode="decimal"
            value={fitMb}
            invalid={targetBytesOf(Number(fitMb.replace(',', '.'))) === null}
            onChange={(e) => setFitMb(e.target.value)}
          />
          <Button
            onClick={() => void fit()}
            disabled={
              busy !== null || signed || targetBytesOf(Number(fitMb.replace(',', '.'))) === null
            }
            loading={busy === 'fit'}
          >
            {t('compress.fitButton', { mb: fitMb })}
          </Button>
        </div>
      </Field>
      {shown && (
        <section className="compress__result" role="status" aria-label={t('compress.resultLabel')}>
          <strong>
            {t('compress.result.line', {
              before: mb(shown.bytesBefore),
              after: mb(shown.bytesAfter),
              percent: percentSaved(shown.bytesBefore, shown.bytesAfter),
            })}
          </strong>
          <p>
            {t('compress.result.images', {
              processed: shown.imagesProcessed,
              skipped: shown.imagesSkipped,
            })}
          </p>
          {shown.skipped.length > 0 && (
            <ul>
              {shown.skipped.map((s) => (
                <li key={s.reason}>
                  {t(`compress.reason.${s.reason}`, { defaultValue: s.reason, count: s.count })}
                </li>
              ))}
            </ul>
          )}
          {shown.warnings.map((w) => (
            <p key={w} className="compress__warn">
              {w}
            </p>
          ))}
        </section>
      )}
    </TaskDialog>
  );
}

/** Size in MB with one decimal (the unit is translated in the strings that use it). */
function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}
