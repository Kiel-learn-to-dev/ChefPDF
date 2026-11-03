/**
 * Watermark (F1): text or picture, faint and rotated by default, one copy in the middle or tiled
 * with spacing. Built-in looks (BẢN SAO, MẬT, DRAFT, ĐÃ DUYỆT) and the user's own looks are presets
 * (settings.overlayPresets). The preview is the current page rendered by pdf.js, with the mark
 * drawn over it in CSS (approximate).
 */
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Droplets, Save, Trash2 } from 'lucide-react';
import { useActiveDoc, type DocTab } from '../../app/state/documents';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { IconButton, Button } from '../../components/Button';
import { Checkbox, Field, Segmented, Switch, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { showError } from '../../app/actions';
import { usePdfDocument } from '../viewer/pdfCache';
import { useThumbnail } from '../viewer/thumbnails';
import { ColorInput } from './ColorInput';
import { applyOverlay, pickImage, prefsOf } from './overlayActions';
import { NumberField, PagePreview, PagesField, useCurrentPage } from './OverlayControls';
import {
  BUILTIN_WATERMARKS,
  DEFAULT_WATERMARK_FORM,
  checkWatermark,
  lookOf,
  presetLook,
  validatePresetName,
  watermarkParams,
  type WatermarkForm,
  type WatermarkLook,
} from './overlayModel';
import { useDraft } from './overlayState';
import { i18n } from '../../i18n';
import './overlay.css';

const ENUMS = {
  kind: ['text', 'image'],
  mode: ['center', 'tiled'],
  choice: ['current', 'all', 'range', 'odd', 'even'],
};
const CUSTOM = 'custom';

/** Where the mark sits on the preview: one centre copy, or a grid of copies for tiles. */
function WatermarkPreview({ doc, form, page }: { doc: DocTab; form: WatermarkForm; page: number }) {
  const { pdf } = usePdfDocument(doc);
  const thumb = useThumbnail(doc, pdf, page, 260, true);
  const info = doc.info.pages[page] ?? { width: 595, height: 842 };
  const size = `${(form.fontSize / info.width) * 100}cqw`;
  const mark = (key: string, style: CSSProperties) => (
    <span key={key} className="ov-wm" style={style}>
      {form.kind === 'text' ? form.text : form.path.split(/[\\/]/).pop() || ''}
    </span>
  );
  const base: CSSProperties = {
    color: form.color,
    opacity: form.opacity,
    fontSize: size,
    fontWeight: form.bold ? 700 : 400,
    transform: `translate(-50%, -50%) rotate(${-form.rotation}deg)`,
  };
  const cells =
    form.mode === 'tiled'
      ? [0.2, 0.5, 0.8].flatMap((y) => [0.2, 0.5, 0.8].map((x) => ({ x, y })))
      : [{ x: 0.5, y: 0.5 }];
  return (
    <PagePreview width={info.width} height={info.height} imageUrl={thumb}>
      {cells.map((c, i) => mark(`${i}`, { ...base, left: `${c.x * 100}%`, top: `${c.y * 100}%` }))}
    </PagePreview>
  );
}

/** Watermark dialog (F1). */
export function WatermarkDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const userPresets = useSettings((s) => s.settings.overlayPresets);
  const updateSettings = useSettings((s) => s.update);
  const [form, setForm] = useDraft<WatermarkForm>('watermark', () =>
    prefsOf('watermark', DEFAULT_WATERMARK_FORM, ENUMS),
  );
  const [presetKey, setPresetKey] = useState(CUSTOM);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [nameIssue, setNameIssue] = useState<string | null>(null);
  const current = useCurrentPage(doc?.id);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const check = checkWatermark(form, pageCount, current);
  const blocked = doc.state.signed;
  const set = (patch: Partial<WatermarkForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPresetKey(CUSTOM);
  };

  const builtinOptions = BUILTIN_WATERMARKS.map((b) => ({
    value: `builtin:${b.key}`,
    label: `${t('overlay.wm.builtin')}: ${t(b.textKey)}`,
  }));
  const userOptions = userPresets.map((p) => ({ value: `user:${p.name}`, label: p.name }));
  const options = [
    { value: CUSTOM, label: t('overlay.wm.custom') },
    ...builtinOptions,
    ...userOptions,
  ];

  const applyPreset = (key: string) => {
    setPresetKey(key);
    if (key === CUSTOM) return;
    if (key.startsWith('builtin:')) {
      const b = BUILTIN_WATERMARKS.find((x) => `builtin:${x.key}` === key);
      if (!b) return;
      setForm((f) => ({ ...f, kind: 'text', text: i18n.t(b.textKey), ...b.look }));
      return;
    }
    const p = userPresets.find((x) => `user:${x.name}` === key);
    if (!p) return;
    setForm((f) => ({ ...f, ...presetLook(p.params, lookOf(f)) }));
  };

  const savePreset = () => {
    const check2 = validatePresetName(presetName, [
      ...BUILTIN_WATERMARKS.map((b) => i18n.t(b.textKey)),
      ...userPresets.map((p) => p.name),
    ]);
    if (!check2.ok) {
      setNameIssue(check2.issue);
      return;
    }
    const look: WatermarkLook = lookOf(form);
    updateSettings({
      overlayPresets: [
        ...userPresets,
        { name: check2.name, kind: 'watermark', params: { ...look } },
      ],
    })
      .then(() => {
        setSaving(false);
        setPresetName('');
        setNameIssue(null);
        setPresetKey(`user:${check2.name}`);
      })
      .catch((e: unknown) => showError(e));
  };

  const deletePreset = () => {
    const name = presetKey.replace(/^user:/, '');
    setPresetKey(CUSTOM);
    updateSettings({ overlayPresets: userPresets.filter((p) => p.name !== name) }).catch(
      (e: unknown) => showError(e),
    );
  };

  const pick = async () => {
    const path = await pickImage();
    if (path) set({ path, kind: 'image' });
  };

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (!check.ok) warnings.push(t(`overlay.err.${check.field}`));

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'overlay.watermark',
      watermarkParams(form, current, pageCount),
      t('overlay.watermarkJob', { name: doc.name }),
      { dialog: 'watermark', value: form },
    );
    if (ok) close();
  };

  const selectedUser = presetKey.startsWith('user:');

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.watermark.title')}
      icon={<Droplets size={18} />}
      description={t('overlay.watermark.description')}
      size="xl"
      sideWidth={400}
      preset={{
        value: presetKey,
        onChange: applyPreset,
        options,
        actions: (
          <>
            <IconButton
              label={t('overlay.wm.savePreset')}
              icon={<Save size={15} />}
              onClick={() => {
                setSaving((s) => !s);
                setNameIssue(null);
              }}
            />
            {selectedUser && (
              <IconButton
                label={t('overlay.wm.deletePreset')}
                icon={<Trash2 size={15} />}
                onClick={deletePreset}
              />
            )}
          </>
        ),
      }}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      workflowStep={{
        op: 'overlay.watermark',
        params: watermarkParams(form, current, pageCount) as unknown as Record<string, unknown>,
        label: t('overlay.watermark.title'),
      }}
      canRun={check.ok && !blocked}
      warnings={warnings}
      preview={doc ? <WatermarkPreview doc={doc} form={form} page={current} /> : undefined}
      advanced={
        <>
          <NumberField
            id="ov-wm-rotation"
            label={t('overlay.look.rotation')}
            value={form.rotation}
            min={-360}
            max={360}
            step={1}
            onChange={(rotation) => set({ rotation })}
          />
          <NumberField
            id="ov-wm-opacity"
            label={t('overlay.look.opacity')}
            value={form.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => set({ opacity })}
          />
          <NumberField
            id="ov-wm-spacing"
            label={t('overlay.wm.spacing')}
            hint={t('overlay.wm.spacingHint')}
            value={form.spacing}
            min={0}
            step={1}
            onChange={(spacing) => set({ spacing })}
          />
          <Checkbox
            checked={form.bold}
            onChange={(bold) => set({ bold })}
            label={t('overlay.look.bold')}
          />
          <Switch
            checked={form.under}
            onChange={(under) => set({ under })}
            label={t('overlay.look.under')}
          />
        </>
      }
    >
      {saving && (
        <Field
          label={t('overlay.wm.presetName')}
          htmlFor="ov-wm-preset-name"
          error={nameIssue ? t(`overlay.presetIssue.${nameIssue}`) : undefined}
        >
          <div className="field__row">
            <TextInput
              id="ov-wm-preset-name"
              value={presetName}
              invalid={nameIssue !== null}
              autoFocus
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && savePreset()}
            />
            <Button variant="primary" onClick={savePreset}>
              {t('overlay.wm.savePresetConfirm')}
            </Button>
          </div>
        </Field>
      )}
      <Field label={t('overlay.wm.kind')}>
        <Segmented<'text' | 'image'>
          aria-label={t('overlay.wm.kind')}
          value={form.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: 'text', label: t('overlay.wm.kindText') },
            { value: 'image', label: t('overlay.wm.kindImage') },
          ]}
        />
      </Field>
      {form.kind === 'text' ? (
        <>
          <Field
            label={t('overlay.wm.text')}
            htmlFor="ov-wm-text"
            error={!check.ok && check.field === 'text' ? t('overlay.err.text') : undefined}
          >
            <TextInput
              id="ov-wm-text"
              value={form.text}
              onChange={(e) => set({ text: e.target.value })}
            />
          </Field>
          <div className="ov-row">
            <NumberField
              id="ov-wm-size"
              label={t('overlay.look.fontSize')}
              value={form.fontSize}
              min={1}
              max={400}
              step={1}
              onChange={(fontSize) => set({ fontSize })}
            />
            <ColorInput
              id="ov-wm-color"
              label={t('overlay.look.color')}
              value={form.color}
              onChange={(color) => set({ color })}
            />
          </div>
        </>
      ) : (
        <Field label={t('overlay.image.file')} hint={t('overlay.image.fileHint')}>
          <div className="field__row">
            <TextInput readOnly value={form.path} placeholder={t('overlay.image.noFile')} />
            <Button onClick={() => void pick()}>{t('overlay.image.choose')}</Button>
          </div>
        </Field>
      )}
      <Field label={t('overlay.wm.layout')}>
        <Segmented<'center' | 'tiled'>
          aria-label={t('overlay.wm.layout')}
          value={form.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'center', label: t('overlay.wm.center') },
            { value: 'tiled', label: t('overlay.wm.tiled') },
          ]}
        />
      </Field>
      <PagesField
        id="ov-wm"
        value={form.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
    </TaskDialog>
  );
}
