/**
 * Header and footer (F7): a 3 x 2 grid of templates (left, centre, right; header and footer), with
 * variable chips for the field that has the focus. The preview shows the resolved text of the first
 * page (the variables are expanded by the TS port of the core rules; the core writes the file).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelTop } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Checkbox, Field, Switch, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { ColorInput } from './ColorInput';
import { applyOverlay, prefsOf } from './overlayActions';
import {
  NumberField,
  PagePreview,
  PagesField,
  VariableChips,
  previewDocOf,
  useCurrentPage,
} from './OverlayControls';
import {
  DEFAULT_HEADER_FOOTER_FORM,
  ZONE_KEYS,
  checkMargins,
  headerFooterParams,
  zonesProblem,
  type HeaderFooterForm,
  type Zones,
} from './overlayModel';
import { useDraft } from './overlayState';
import { renderTemplate } from './variables';
import './overlay.css';

const ENUMS = { choice: ['current', 'all', 'range', 'odd', 'even'] };

type Band = 'header' | 'footer';
type FocusKey = `${Band}.${keyof Zones}`;

export function HeaderFooterDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useDraft<HeaderFooterForm>('headerFooter', () =>
    prefsOf('headerFooter', DEFAULT_HEADER_FOOTER_FORM, ENUMS),
  );
  const [focus, setFocus] = useState<FocusKey>('footer.right');
  const current = useCurrentPage(doc?.id);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const blocked = doc.state.signed;
  const set = (patch: Partial<HeaderFooterForm>) => setForm((f) => ({ ...f, ...patch }));
  const setZone = (band: Band, zone: keyof Zones, value: string) =>
    setForm((f) => ({ ...f, [band]: { ...f[band], [zone]: value } }));
  const zoneValue = (band: Band, zone: keyof Zones) => form[band][zone];

  const problem = zonesProblem(form.header) ?? zonesProblem(form.footer);
  const marginsOk = checkMargins(form.margins);
  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (problem) warnings.push(t('overlay.err.zone', { zone: t(`overlay.zone.${problem.field}`) }));
  if (!marginsOk) warnings.push(t('overlay.err.margins'));

  const pickChip = (name: string) => {
    const [band, zone] = focus.split('.') as [Band, keyof Zones];
    setZone(band, zone, `${zoneValue(band, zone)}{${name}}`);
  };

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'overlay.headerFooter',
      headerFooterParams(form, current, pageCount),
      t('overlay.headerFooterJob', { name: doc.name }),
      { dialog: 'headerFooter', value: form },
    );
    if (ok) close();
  };

  // Preview: the first page (or the first page that gets the text), resolved.
  const firstIndex = form.skipFirst ? 1 : 0;
  const pv = previewDocOf(
    doc,
    { prefix: form.batesPrefix, suffix: form.batesSuffix, digits: form.batesDigits },
    form.startNumber,
    form.dateFormat,
  );
  const resolve = (tmpl: string): string => {
    const r = renderTemplate(tmpl, firstIndex, pv);
    return r.ok ? r.text : '';
  };
  const page = doc.info.pages[firstIndex] ?? doc.info.pages[0] ?? { width: 595, height: 842 };
  const fontCqw = `${(form.fontSize / page.width) * 100}cqw`;
  const bandRow = (band: Band, vertical: 'top' | 'bottom') => (
    <div
      className={`ov-band ov-band--${vertical}`}
      style={{
        fontSize: fontCqw,
        opacity: form.opacity,
        color: form.color,
        fontWeight: form.bold ? 700 : 400,
      }}
    >
      {ZONE_KEYS.map((z) => (
        <span key={z} className={`ov-band__zone ov-band__zone--${z}`}>
          {resolve(form[band][z])}
        </span>
      ))}
    </div>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.hf.title')}
      icon={<PanelTop size={18} />}
      description={t('overlay.hf.description')}
      size="xl"
      sideWidth={400}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      workflowStep={{
        op: 'overlay.headerFooter',
        params: headerFooterParams(form, current, pageCount) as unknown as Record<string, unknown>,
        label: t('overlay.hf.title'),
      }}
      canRun={!problem && marginsOk && !blocked && !!doc}
      warnings={warnings}
      preview={
        <PagePreview
          width={page.width}
          height={page.height}
          label={t('overlay.preview.firstPage', { page: firstIndex + 1 })}
        >
          {bandRow('header', 'top')}
          {bandRow('footer', 'bottom')}
        </PagePreview>
      }
      advanced={
        <>
          <div className="ov-row">
            <NumberField
              id="ov-hf-top"
              label={t('overlay.margins.top')}
              value={form.margins.top}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, top: v } })}
            />
            <NumberField
              id="ov-hf-bottom"
              label={t('overlay.margins.bottom')}
              value={form.margins.bottom}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, bottom: v } })}
            />
            <NumberField
              id="ov-hf-left"
              label={t('overlay.margins.left')}
              value={form.margins.left}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => set({ margins: { ...form.margins, left: v } })}
            />
            <NumberField
              id="ov-hf-right"
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
              id="ov-hf-size"
              label={t('overlay.look.fontSize')}
              value={form.fontSize}
              min={1}
              max={200}
              step={0.5}
              onChange={(fontSize) => set({ fontSize })}
            />
            <NumberField
              id="ov-hf-opacity"
              label={t('overlay.look.opacity')}
              value={form.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(opacity) => set({ opacity })}
            />
            <NumberField
              id="ov-hf-start"
              label={t('overlay.numbers.start')}
              value={form.startNumber}
              min={0}
              step={1}
              onChange={(startNumber) => set({ startNumber })}
            />
            <ColorInput
              id="ov-hf-color"
              label={t('overlay.look.color')}
              value={form.color}
              onChange={(color) => set({ color })}
            />
          </div>
          <Field
            label={t('overlay.hf.dateFormat')}
            htmlFor="ov-hf-date"
            hint={t('overlay.hf.dateHint')}
          >
            <TextInput
              id="ov-hf-date"
              value={form.dateFormat}
              onChange={(e) => set({ dateFormat: e.target.value })}
            />
          </Field>
          <Field label={t('overlay.hf.bates')} hint={t('overlay.hf.batesHint')}>
            <div className="ov-row">
              <TextInput
                aria-label={t('overlay.hf.batesPrefix')}
                placeholder={t('overlay.hf.batesPrefix')}
                value={form.batesPrefix}
                onChange={(e) => set({ batesPrefix: e.target.value })}
              />
              <TextInput
                aria-label={t('overlay.hf.batesSuffix')}
                placeholder={t('overlay.hf.batesSuffix')}
                value={form.batesSuffix}
                onChange={(e) => set({ batesSuffix: e.target.value })}
              />
              <NumberField
                id="ov-hf-digits"
                label={t('overlay.hf.batesDigits')}
                value={form.batesDigits}
                min={1}
                max={12}
                step={1}
                onChange={(batesDigits) => set({ batesDigits })}
              />
            </div>
          </Field>
          <Checkbox
            checked={form.skipFirst}
            onChange={(skipFirst) => set({ skipFirst })}
            label={t('overlay.hf.skipFirst')}
          />
          <Checkbox
            checked={form.mirrorOddEven}
            onChange={(mirrorOddEven) => set({ mirrorOddEven })}
            label={t('overlay.hf.mirror')}
            hint={t('overlay.hf.mirrorHint')}
          />
          <Switch
            checked={form.bold}
            onChange={(bold) => set({ bold })}
            label={t('overlay.look.bold')}
          />
        </>
      }
    >
      <div className="ov-zones" role="group" aria-label={t('overlay.hf.grid')}>
        <span />
        {ZONE_KEYS.map((z) => (
          <span key={z} className="ov-zones__head">
            {t(`overlay.zone.${z}`)}
          </span>
        ))}
        {(['header', 'footer'] as Band[]).map((band) => (
          <div key={band} className="ov-zones__row">
            <span className="ov-zones__band">{t(`overlay.band.${band}`)}</span>
            {ZONE_KEYS.map((z) => {
              const key = `${band}.${z}` as FocusKey;
              const bad = zonesProblem(form[band])?.field === z;
              return (
                <TextInput
                  key={key}
                  aria-label={`${t(`overlay.band.${band}`)} – ${t(`overlay.zone.${z}`)}`}
                  value={form[band][z]}
                  invalid={bad}
                  onFocus={() => setFocus(key)}
                  onChange={(e) => setZone(band, z, e.target.value)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <VariableChips
        onPick={pickChip}
        focusLabel={t('overlay.hf.focusHint', {
          zone: t(`overlay.zone.${focus.split('.')[1]}`),
          band: t(`overlay.band.${focus.split('.')[0]}`),
        })}
      />
      <PagesField
        id="ov-hf"
        value={form.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
      />
    </TaskDialog>
  );
}
