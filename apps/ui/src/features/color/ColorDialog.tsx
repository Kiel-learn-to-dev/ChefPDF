/**
 * "Chuyển màu" (M6; T5.07): grey, black and white (threshold or dithering), ink saver, and replace
 * one colour by another, on all pages or a page selection. Runs color.convert as a document op.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Palette } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Select, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { NumberField } from '../overlay/OverlayControls';
import '../pagetools/pagetools.css';
import {
  COLOR_MODES,
  DEFAULT_COLOR_FORM,
  colorIssues,
  colorParams,
  normalizeHex,
  readColorReport,
  type ColorForm,
  type ColorMode,
  type ColorReport,
} from './colorModel';

/** Chuyển màu (M6). */
export function ColorDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useState<ColorForm>(DEFAULT_COLOR_FORM);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ColorReport | null>(null);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const signed = doc.state.signed;
  const issues = colorIssues(form, pageCount);
  const set = (patch: Partial<ColorForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
  };

  const run = async () => {
    if (issues.length > 0 || signed) return;
    setRunning(true);
    setResult(null);
    const r = await runDocOp(
      doc.id,
      'color.convert',
      colorParams(form, pageCount),
      t('colour.jobTitle', { name: doc.name }),
    );
    setRunning(false);
    if (r) setResult(readColorReport(r.data));
  };

  const warnings: string[] = [];
  if (signed) warnings.push(t('colour.signedBlocked'));
  for (const issue of issues) warnings.push(t(`colour.issue.${issue}`));

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      title={t('colour.title')}
      icon={<Palette size={18} />}
      description={t('colour.description', { name: doc.name })}
      size="lg"
      sideWidth={300}
      runLabel={t('colour.run')}
      onRun={() => void run()}
      canRun={issues.length === 0 && !signed && !running}
      running={running}
      warnings={warnings}
      workflowStep={{
        op: 'color.convert',
        params: colorParams(form, pageCount) as unknown as Record<string, unknown>,
        label: t('colour.title'),
      }}
      advanced={
        <>
          <Checkbox
            checked={form.dithering}
            onChange={(dithering) => set({ dithering })}
            label={t('colour.dithering')}
            hint={t('colour.ditheringHint')}
            disabled={form.mode !== 'blackwhite'}
          />
        </>
      }
    >
      <Field label={t('colour.mode.label')} htmlFor="colour-mode">
        <Select<ColorMode>
          id="colour-mode"
          value={form.mode}
          onChange={(mode) => set({ mode })}
          options={COLOR_MODES.map((m) => ({ value: m, label: t(`colour.mode.${m}`) }))}
        />
      </Field>
      <p className="pt-hint">{t(`colour.modeHint.${form.mode}`)}</p>
      {form.mode === 'blackwhite' && (
        <NumberField
          id="colour-threshold"
          label={t('colour.threshold')}
          value={form.threshold}
          min={0}
          max={255}
          step={1}
          hint={t('colour.thresholdHint')}
          invalid={issues.includes('threshold')}
          onChange={(threshold) => set({ threshold })}
        />
      )}
      {form.mode === 'ink-saver' && (
        <NumberField
          id="colour-amount"
          label={t('colour.amount')}
          value={Math.round(form.amount * 100)}
          min={0}
          max={100}
          step={5}
          hint={t('colour.amountHint')}
          invalid={issues.includes('amount')}
          onChange={(v) => set({ amount: v / 100 })}
        />
      )}
      {form.mode === 'replace-color' && (
        <>
          <ColorField
            id="colour-source"
            label={t('colour.source')}
            value={form.sourceColor}
            invalid={issues.includes('sourceColor')}
            error={t('colour.issue.sourceColor')}
            onChange={(sourceColor) => set({ sourceColor })}
          />
          <ColorField
            id="colour-target"
            label={t('colour.target')}
            value={form.targetColor}
            invalid={issues.includes('targetColor')}
            error={t('colour.issue.targetColor')}
            onChange={(targetColor) => set({ targetColor })}
          />
          <NumberField
            id="colour-tolerance"
            label={t('colour.tolerance')}
            value={form.tolerance}
            min={0}
            max={255}
            step={1}
            hint={t('colour.toleranceHint')}
            invalid={issues.includes('tolerance')}
            onChange={(tolerance) => set({ tolerance })}
          />
        </>
      )}
      <Field label={t('colour.scope.label')}>
        <RadioGroup<'all' | 'pages'>
          value={form.scope}
          onChange={(scope) => set({ scope })}
          aria-label={t('colour.scope.label')}
          options={[
            { value: 'all', label: t('colour.scope.all') },
            { value: 'pages', label: t('colour.scope.pages') },
          ]}
        />
      </Field>
      {form.scope === 'pages' && (
        <Field
          label={t('colour.pages')}
          htmlFor="colour-pages"
          hint={t('range.hint')}
          error={issues.includes('pages') ? t('colour.issue.pages') : undefined}
        >
          <TextInput
            id="colour-pages"
            value={form.pagesText}
            invalid={issues.includes('pages')}
            onChange={(e) => set({ pagesText: e.target.value })}
          />
        </Field>
      )}
      {result && (
        <section className="pt-result" role="status" aria-label={t('colour.resultLabel')}>
          <strong>
            {t('colour.result.line', {
              colours: result.coloursChanged,
              images: result.imagesChanged,
              pages: result.pagesChanged,
            })}
          </strong>
          {result.kept.length > 0 && (
            <ul>
              {result.kept.map((k) => (
                <li key={k.reason}>
                  {t('colour.result.kept', {
                    reason: t(`colour.kept.${k.reason}`, { defaultValue: k.reason }),
                    count: k.count,
                  })}
                </li>
              ))}
            </ul>
          )}
          <Button variant="ghost" onClick={close}>
            {t('common.close')}
          </Button>
        </section>
      )}
    </TaskDialog>
  );
}

function ColorField({
  id,
  label,
  value,
  invalid,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid: boolean;
  error: string;
  onChange(v: string): void;
}) {
  const hex = normalizeHex(value);
  return (
    <Field label={label} htmlFor={id} error={invalid ? error : undefined}>
      <div className="field__row">
        <input
          type="color"
          className="pt-swatch"
          aria-label={label}
          value={hex ?? '#000000'}
          onChange={(e) => onChange(e.target.value)}
        />
        <TextInput
          id={id}
          value={value}
          invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </Field>
  );
}
