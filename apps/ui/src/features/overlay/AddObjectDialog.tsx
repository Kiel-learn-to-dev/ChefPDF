/**
 * "Thêm chữ" (D1) and "Thêm ảnh" (D2): the object's content and look, its position (numbers in mm
 * or pt, or placed by drag on the page), and the pages it goes on. The preview is an approximate
 * CSS drawing of the current page.
 */
import { useEffect, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, Type } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Checkbox, Field, Segmented, Switch, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { ColorInput } from './ColorInput';
import { applyOverlay, pickImage, prefsOf } from './overlayActions';
import {
  AnchorPicker,
  NumberField,
  PagePreview,
  PagesField,
  PositionFields,
  useCurrentPage,
} from './OverlayControls';
import {
  DEFAULT_IMAGE_FORM,
  DEFAULT_TEXT_FORM,
  addImageParams,
  addTextParams,
  checkImage,
  checkText,
  estimateTextBox,
  fromPt,
  previewBox,
  toPt,
  type Align,
  type ImageForm,
  type TextForm,
  type Unit,
} from './overlayModel';
import { useDraft, useOverlayState } from './overlayState';
import './overlay.css';

const ALIGNS: Align[] = ['left', 'center', 'right'];
const UNITS: Unit[] = ['mm', 'pt'];
const ENUMS = { align: ALIGNS, unit: UNITS, choice: ['current', 'all', 'range', 'odd', 'even'] };

/** Places the object on the page: the dialog closes until a box is drawn. */
function placeOnPage(docId: string, mode: 'point' | 'box', dialog: 'overlayText' | 'overlayImage') {
  useOverlayState.getState().start({ docId, mode, returnTo: dialog });
}

/** Text box (D1). */
export function AddTextDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useDraft<TextForm>('text', () =>
    prefsOf('text', DEFAULT_TEXT_FORM, ENUMS),
  );
  const current = useCurrentPage(doc?.id);

  // Back from a placement: take the box drawn on the page, once.
  useEffect(() => {
    const r = useOverlayState.getState().takeResult('overlayText');
    if (!r) return;
    setForm((f) => ({
      ...f,
      x: fromPt(r.x, f.unit),
      y: fromPt(r.y, f.unit),
      pages: { choice: 'range', range: String(r.pageIndex + 1) },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const check = checkText(form, pageCount, current);
  const blocked = doc.state.signed;
  const set = (patch: Partial<TextForm>) => setForm((f) => ({ ...f, ...patch }));

  const page = doc.info.pages[current] ?? { width: 595, height: 842 };
  const widthPt = form.width > 0 ? toPt(form.width, form.unit) : 0;
  const est = estimateTextBox(form.text, toPt(form.fontSize, 'pt'), widthPt);
  const box = previewBox(
    toPt(form.x, form.unit),
    toPt(form.y, form.unit),
    est.w,
    est.h,
    form.anchor,
    page,
  );
  const textStyle: CSSProperties = {
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: widthPt > 0 ? `${box.width}%` : 'auto',
    fontSize: `${(form.fontSize / page.width) * 100}cqw`,
    color: form.color,
    fontWeight: form.bold ? 700 : 400,
    opacity: form.opacity,
    textAlign: form.align,
    transform: `rotate(${-form.rotation}deg)`,
  };

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (!check.ok) warnings.push(t(`overlay.err.${check.field}`));

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'overlay.addText',
      addTextParams(form, current, pageCount),
      t('overlay.addTextJob', { name: doc.name }),
      { dialog: 'text', value: form },
    );
    if (ok) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.text.title')}
      icon={<Type size={18} />}
      description={t('overlay.text.description')}
      size="xl"
      sideWidth={400}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      canRun={check.ok && !blocked}
      warnings={warnings}
      preview={
        <PagePreview
          width={page.width}
          height={page.height}
          label={t('overlay.preview.page', { page: current + 1 })}
        >
          <div className="ov-text-preview" style={textStyle} data-testid="overlay-text-preview">
            {form.text}
          </div>
        </PagePreview>
      }
      advanced={
        <>
          <Field label={t('overlay.look.align')}>
            <Segmented<Align>
              aria-label={t('overlay.look.align')}
              value={form.align}
              onChange={(align) => set({ align })}
              options={ALIGNS.map((a) => ({ value: a, label: t(`overlay.align.${a}`) }))}
            />
          </Field>
          <NumberField
            id="ov-text-rotation"
            label={t('overlay.look.rotation')}
            value={form.rotation}
            min={-360}
            max={360}
            step={1}
            onChange={(rotation) => set({ rotation })}
          />
          <NumberField
            id="ov-text-opacity"
            label={t('overlay.look.opacity')}
            value={form.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => set({ opacity })}
          />
          <NumberField
            id="ov-text-width"
            label={t('overlay.text.width')}
            hint={t('overlay.text.widthHint')}
            value={form.width}
            min={0}
            step={0.5}
            onChange={(width) => set({ width })}
          />
          <Field label={t('overlay.anchor.label')}>
            <AnchorPicker value={form.anchor} onChange={(anchor) => set({ anchor })} />
          </Field>
          <Switch
            checked={form.under}
            onChange={(under) => set({ under })}
            label={t('overlay.look.under')}
          />
        </>
      }
    >
      <Field
        label={t('overlay.text.content')}
        htmlFor="ov-text-content"
        hint={t('overlay.text.contentHint')}
      >
        <textarea
          id="ov-text-content"
          className="input ov-textarea"
          rows={3}
          value={form.text}
          aria-invalid={!check.ok && check.field === 'text' ? true : undefined}
          onChange={(e) => set({ text: e.target.value })}
        />
      </Field>
      <div className="ov-row">
        <NumberField
          id="ov-text-size"
          label={t('overlay.look.fontSize')}
          value={form.fontSize}
          min={1}
          max={200}
          step={0.5}
          onChange={(fontSize) => set({ fontSize })}
        />
        <ColorInput
          id="ov-text-color"
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
      <PositionFields
        idPrefix="ov-text"
        x={form.x}
        y={form.y}
        unit={form.unit}
        onChange={(p) => {
          if (p.unit && p.unit !== form.unit) {
            // Keep the same place when the unit changes.
            set({
              unit: p.unit,
              x: fromPt(toPt(form.x, form.unit), p.unit),
              y: fromPt(toPt(form.y, form.unit), p.unit),
            });
            return;
          }
          set(p);
        }}
        onPlace={blocked ? undefined : () => placeOnPage(doc.id, 'point', 'overlayText')}
        placeDisabled={blocked}
      />
      <PagesField
        id="ov-text"
        value={form.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
    </TaskDialog>
  );
}

/** Picture (D2): a PNG or JPEG placed by a box, sized by width or height. */
export function AddImageDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useDraft<ImageForm>('image', () =>
    prefsOf('image', DEFAULT_IMAGE_FORM, ENUMS),
  );
  const current = useCurrentPage(doc?.id);

  useEffect(() => {
    const r = useOverlayState.getState().takeResult('overlayImage');
    if (!r) return;
    setForm((f) => ({
      ...f,
      x: fromPt(r.x, f.unit),
      y: fromPt(r.y, f.unit),
      width: r.width > 0 ? fromPt(r.width, f.unit) : f.width,
      height: r.height > 0 ? fromPt(r.height, f.unit) : 0,
      pages: { choice: 'range', range: String(r.pageIndex + 1) },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const check = checkImage(form, pageCount, current);
  const blocked = doc.state.signed;
  const set = (patch: Partial<ImageForm>) => setForm((f) => ({ ...f, ...patch }));
  const page = doc.info.pages[current] ?? { width: 595, height: 842 };
  const w = form.width > 0 ? toPt(form.width, form.unit) : 150;
  const h = form.height > 0 ? toPt(form.height, form.unit) : w * 0.75;
  const box = previewBox(toPt(form.x, form.unit), toPt(form.y, form.unit), w, h, form.anchor, page);

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (!check.ok) warnings.push(t(`overlay.err.${check.field}`));

  const pick = async () => {
    const path = await pickImage();
    if (path) set({ path });
  };

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'overlay.addImage',
      addImageParams(form, current, pageCount),
      t('overlay.addImageJob', { name: doc.name }),
      { dialog: 'image', value: form },
    );
    if (ok) close();
  };

  const fileName = form.path ? form.path.split(/[\\/]/).pop() : '';

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.image.title')}
      icon={<ImageIcon size={18} />}
      description={t('overlay.image.description')}
      size="xl"
      sideWidth={400}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      canRun={check.ok && !blocked}
      warnings={warnings}
      preview={
        <PagePreview
          width={page.width}
          height={page.height}
          label={t('overlay.preview.page', { page: current + 1 })}
        >
          <div
            className="ov-image-preview"
            style={{
              left: `${box.left}%`,
              top: `${box.top}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
              opacity: form.opacity,
              transform: `rotate(${-form.rotation}deg)`,
            }}
          >
            {fileName || t('overlay.image.placeholder')}
          </div>
        </PagePreview>
      }
      advanced={
        <>
          <NumberField
            id="ov-image-rotation"
            label={t('overlay.look.rotation')}
            value={form.rotation}
            min={-360}
            max={360}
            step={1}
            onChange={(rotation) => set({ rotation })}
          />
          <NumberField
            id="ov-image-opacity"
            label={t('overlay.look.opacity')}
            value={form.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => set({ opacity })}
          />
          <Field label={t('overlay.anchor.label')}>
            <AnchorPicker value={form.anchor} onChange={(anchor) => set({ anchor })} />
          </Field>
          <Switch
            checked={form.under}
            onChange={(under) => set({ under })}
            label={t('overlay.look.under')}
          />
        </>
      }
    >
      <Field
        label={t('overlay.image.file')}
        htmlFor="ov-image-file"
        hint={t('overlay.image.fileHint')}
      >
        <div className="field__row">
          <TextInput
            id="ov-image-file"
            readOnly
            value={form.path}
            placeholder={t('overlay.image.noFile')}
            aria-invalid={!check.ok && check.field === 'path' ? true : undefined}
          />
          <Button onClick={() => void pick()}>{t('overlay.image.choose')}</Button>
        </div>
      </Field>
      <div className="ov-row">
        <NumberField
          id="ov-image-width"
          label={t('overlay.image.width', { unit: t(`overlay.unit.${form.unit}`) })}
          value={form.width}
          min={0}
          step={0.5}
          onChange={(width) => set({ width })}
          hint={t('overlay.image.sizeHint')}
        />
        <NumberField
          id="ov-image-height"
          label={t('overlay.image.height', { unit: t(`overlay.unit.${form.unit}`) })}
          value={form.height}
          min={0}
          step={0.5}
          onChange={(height) => set({ height })}
        />
      </div>
      <PositionFields
        idPrefix="ov-image"
        x={form.x}
        y={form.y}
        unit={form.unit}
        onChange={(p) => {
          if (p.unit && p.unit !== form.unit) {
            set({
              unit: p.unit,
              x: fromPt(toPt(form.x, form.unit), p.unit),
              y: fromPt(toPt(form.y, form.unit), p.unit),
            });
            return;
          }
          set(p);
        }}
        onPlace={blocked ? undefined : () => placeOnPage(doc.id, 'box', 'overlayImage')}
        placeDisabled={blocked}
      />
      <PagesField
        id="ov-image"
        value={form.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
    </TaskDialog>
  );
}
