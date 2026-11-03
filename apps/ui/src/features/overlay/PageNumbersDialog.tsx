/**
 * Page numbers (F8): the template ("Trang {page}/{pages}"), number format, position on a page
 * diagram, start number, first page skipped, and page labels. The preset "Theo Nghị định
 * 30/2020/NĐ-CP" fills in the rule the core applies (nd30) and disables the fields it overrides.
 */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Hash } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select, Switch, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { ColorInput } from './ColorInput';
import { applyOverlay, prefsOf } from './overlayActions';
import {
  NumberField,
  PagePreview,
  PagesField,
  PositionDiagram,
  VariableChips,
  previewDocOf,
  useCurrentPage,
} from './OverlayControls';
import {
  DEFAULT_PAGE_NUMBERS_FORM,
  ND30_VALUES,
  NUMBER_POSITIONS,
  checkMargins,
  checkPageNumbers,
  effectiveNumberTemplate,
  pageNumbersParams,
  type NumberPosition,
  type PageNumbersForm,
} from './overlayModel';
import { useDraft } from './overlayState';
import { renderTemplate, type NumberFormat } from './variables';
import './overlay.css';

const FORMATS: NumberFormat[] = ['arabic', 'roman', 'ROMAN', 'alpha', 'ALPHA'];
const ENUMS = {
  preset: ['nd30', 'custom'],
  numberFormat: FORMATS,
  position: NUMBER_POSITIONS,
  choice: ['current', 'all', 'range', 'odd', 'even'],
};

/** CSS place of a number on the page preview. */
function placeStyle(pos: NumberPosition): CSSProperties {
  const vertical = pos.startsWith('top') ? { top: '3%' } : { bottom: '3%' };
  const horizontal = pos.endsWith('center')
    ? { left: '50%', transform: 'translateX(-50%)' }
    : pos.endsWith('right')
      ? { right: '5%' }
      : { left: '5%' };
  return { ...vertical, ...horizontal };
}

export function PageNumbersDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useDraft<PageNumbersForm>('pageNumbers', () =>
    prefsOf('pageNumbers', DEFAULT_PAGE_NUMBERS_FORM, ENUMS),
  );
  const current = useCurrentPage(doc?.id);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const blocked = doc.state.signed;
  const nd30 = form.preset === 'nd30';
  const set = (patch: Partial<PageNumbersForm>) => setForm((f) => ({ ...f, ...patch }));
  const check = checkPageNumbers(form, pageCount, current);
  const template = effectiveNumberTemplate(form);

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (!check.ok) warnings.push(t(`overlay.err.${check.field}`));
  if (form.writeLabels && form.startNumber < 1) warnings.push(t('overlay.err.labels'));
  if (!checkMargins(form.margins)) warnings.push(t('overlay.err.margins'));

  // Sample: the first page that gets a number, resolved with the number format.
  const firstIndex = nd30 || form.skipFirst ? 1 : 0;
  const pv = previewDocOf(
    doc,
    { prefix: '', suffix: '', digits: 6 },
    form.startNumber,
    form.dateFormat,
  );
  const rendered = renderTemplate(template, firstIndex, pv, form.numberFormat);
  const sample = rendered.ok ? rendered.text : '';
  const page = doc.info.pages[firstIndex] ?? doc.info.pages[0] ?? { width: 595, height: 842 };
  const fontCqw = `${((nd30 ? ND30_VALUES.fontSize : form.fontSize) / page.width) * 100}cqw`;

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'overlay.pageNumbers',
      pageNumbersParams(form, current, pageCount),
      t('overlay.pageNumbersJob', { name: doc.name }),
      { dialog: 'pageNumbers', value: form },
    );
    if (ok) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.numbers.title')}
      icon={<Hash size={18} />}
      description={t('overlay.numbers.description')}
      size="xl"
      sideWidth={400}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      workflowStep={{
        op: 'overlay.pageNumbers',
        params: pageNumbersParams(form, current, pageCount) as unknown as Record<string, unknown>,
        label: t('overlay.numbers.title'),
      }}
      canRun={
        check.ok &&
        !blocked &&
        checkMargins(form.margins) &&
        !(form.writeLabels && form.startNumber < 1)
      }
      warnings={warnings}
      preview={
        <>
          <PagePreview
            width={page.width}
            height={page.height}
            label={t('overlay.preview.firstPage', { page: firstIndex + 1 })}
          >
            <span
              className="ov-number"
              style={{
                ...placeStyle(form.position),
                fontSize: fontCqw,
                color: form.color,
                fontWeight: form.bold ? 700 : 400,
                opacity: form.opacity,
              }}
            >
              {sample}
            </span>
          </PagePreview>
          <p className="ov-sample" data-testid="overlay-number-sample">
            {t('overlay.numbers.sample', { text: sample || t('overlay.numbers.none') })}
          </p>
        </>
      }
      advanced={
        <>
          <div className="ov-row">
            <NumberField
              id="ov-num-top"
              label={t('overlay.margins.top')}
              value={form.margins.top}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, top: v } })}
            />
            <NumberField
              id="ov-num-bottom"
              label={t('overlay.margins.bottom')}
              value={form.margins.bottom}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, bottom: v } })}
            />
            <NumberField
              id="ov-num-left"
              label={t('overlay.margins.left')}
              value={form.margins.left}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, left: v } })}
            />
            <NumberField
              id="ov-num-right"
              label={t('overlay.margins.right')}
              value={form.margins.right}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, right: v } })}
            />
          </div>
          <div className="ov-row">
            <NumberField
              id="ov-num-size"
              label={t('overlay.look.fontSize')}
              value={form.fontSize}
              min={1}
              max={200}
              step={0.5}
              onChange={(fontSize) => set({ fontSize })}
            />
            <NumberField
              id="ov-num-opacity"
              label={t('overlay.look.opacity')}
              value={form.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(opacity) => set({ opacity })}
            />
            <ColorInput
              id="ov-num-color"
              label={t('overlay.look.color')}
              value={form.color}
              onChange={(color) => set({ color })}
            />
            <Checkbox
              checked={form.bold}
              onChange={(bold) => set({ bold })}
              label={t('overlay.look.bold')}
            />
          </div>
          <Field label={t('overlay.hf.dateFormat')} htmlFor="ov-num-date">
            <TextInput
              id="ov-num-date"
              value={form.dateFormat}
              onChange={(e) => set({ dateFormat: e.target.value })}
            />
          </Field>
        </>
      }
    >
      <div className="ov-preset">
        <Button
          variant={nd30 ? 'primary' : 'secondary'}
          aria-pressed={nd30}
          onClick={() => set({ preset: 'nd30' })}
        >
          {t('overlay.numbers.nd30Button')}
        </Button>
        {nd30 ? (
          <Button variant="ghost" onClick={() => set({ preset: 'custom' })}>
            {t('overlay.numbers.custom')}
          </Button>
        ) : null}
        {nd30 && (
          <p className="ov-preset__explain" data-testid="overlay-nd30-explain">
            {t('overlay.numbers.nd30Explain')}
          </p>
        )}
      </div>
      <div className="ov-row ov-row--top">
        <Field label={t('overlay.numbers.position')}>
          <PositionDiagram value={form.position} onChange={(position) => set({ position })} />
        </Field>
        <div className="ov-stack">
          <Field label={t('overlay.numbers.format')} htmlFor="ov-num-format">
            <Select<NumberFormat>
              id="ov-num-format"
              value={form.numberFormat}
              onChange={(numberFormat) => set({ numberFormat })}
              options={FORMATS.map((f) => ({ value: f, label: t(`overlay.format.${f}`) }))}
              aria-label={t('overlay.numbers.format')}
            />
          </Field>
          <Field
            label={t('overlay.numbers.template')}
            htmlFor="ov-num-template"
            hint={nd30 ? t('overlay.numbers.templateNd30') : undefined}
          >
            <TextInput
              id="ov-num-template"
              value={nd30 ? ND30_VALUES.template : form.template}
              disabled={nd30}
              invalid={!check.ok && check.field === 'template'}
              onChange={(e) => set({ template: e.target.value })}
            />
          </Field>
          {!nd30 && (
            <VariableChips onPick={(name) => set({ template: `${form.template}{${name}}` })} />
          )}
          <NumberField
            id="ov-num-start"
            label={t('overlay.numbers.start')}
            value={form.startNumber}
            min={0}
            step={1}
            onChange={(startNumber) => set({ startNumber })}
          />
          <Switch
            checked={form.skipFirst}
            onChange={(skipFirst) => set({ skipFirst })}
            label={t('overlay.numbers.skipFirst')}
          />
          <Checkbox
            checked={form.writeLabels}
            onChange={(writeLabels) => set({ writeLabels })}
            label={t('overlay.numbers.labels')}
            hint={t('overlay.numbers.labelsHint')}
          />
        </div>
      </div>
      <PagesField
        id="ov-num"
        value={form.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
    </TaskDialog>
  );
}
