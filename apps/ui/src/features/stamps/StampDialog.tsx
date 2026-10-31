/**
 * Stamp dialog (F2, F3, F5): a text stamp (built-in presets, editable text with {date} {time}
 * {user} chips, colour, border, rotation, opacity) or an image stamp (a library stamp or a file,
 * multiply on by default). Placed by a click on the page (overlay placement layer), on the chosen
 * pages. Removable in the overlay manager (kind stamp).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stamp as StampIcon } from 'lucide-react';
import type { LibraryItem } from '@chef/contracts';
import { useActiveDoc } from '../../app/state/documents';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Checkbox, Field, Segmented, Select, Switch } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { ColorInput } from '../overlay/ColorInput';
import { ANCHOR_GRID, fromPt } from '../overlay/overlayModel';
import { applyOverlay, pickImage, prefsOf } from '../overlay/overlayActions';
import {
  NumberField,
  PagePreview,
  PagesField,
  PositionFields,
  useCurrentPage,
} from '../overlay/OverlayControls';
import { useDraft, useOverlayState } from '../overlay/overlayState';
import '../overlay/overlay.css';
import {
  DEFAULT_IMAGE_STAMP_FORM,
  DEFAULT_TEXT_STAMP_FORM,
  STAMP_CHIPS,
  checkImageStamp,
  checkTextStamp,
  imageStampParams,
  presetForm,
  readStampPresets,
  resolveStampText,
  textStampParams,
  withChip,
  type ImageStampForm,
  type StampChip,
  type StampPreset,
  type TextStampForm,
} from './stampModel';

type Kind = 'text' | 'image';

interface StampDraft {
  kind: Kind;
  text: TextStampForm;
  image: ImageStampForm;
}

const DEFAULT_DRAFT: StampDraft = {
  kind: 'text',
  text: DEFAULT_TEXT_STAMP_FORM,
  image: DEFAULT_IMAGE_STAMP_FORM,
};
const ENUMS = {
  kind: ['text', 'image'],
  unit: ['pt', 'mm'],
  anchor: ANCHOR_GRID.flat(),
  choice: ['current', 'all', 'range', 'odd', 'even'],
};
const CUSTOM = 'custom';

/** Stamp dialog (F2, F3, F5). */
export function StampDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const userName = useSettings((s) => s.settings.userName);
  const [draft, setDraft] = useDraft<StampDraft>('stamp', () =>
    prefsOf('stamp', DEFAULT_DRAFT, ENUMS),
  );
  const [presets, setPresets] = useState<StampPreset[]>([]);
  const [presetKey, setPresetKey] = useState(CUSTOM);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [materialized, setMaterialized] = useState<string | null>(null);
  const current = useCurrentPage(doc?.id);

  useEffect(() => {
    void runOp('stamp.presets', {}, { title: t('stamp.presetsJob'), silent: true })
      .then((r) => setPresets(readStampPresets(r.data)))
      .catch(() => undefined);
    void chef()
      .library.list()
      .then((items) => setLibrary(items.filter((i) => i.kind === 'stamp')))
      .catch(() => undefined);
    // Back from the placement on the page: take the box once.
    const r = useOverlayState.getState().takeResult('stamp');
    if (r) {
      setDraft((d) => {
        const pages = { choice: 'range' as const, range: String(r.pageIndex + 1) };
        return {
          ...d,
          text: {
            ...d.text,
            x: fromPt(r.x, d.text.unit),
            y: fromPt(r.y, d.text.unit),
            pages,
          },
          image: {
            ...d.image,
            x: fromPt(r.x, d.image.unit),
            y: fromPt(r.y, d.image.unit),
            pages,
          },
        };
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const blocked = doc.state.signed;
  const isText = draft.kind === 'text';
  const pos = isText ? draft.text : draft.image;
  const check = isText
    ? checkTextStamp(draft.text, pageCount, current)
    : checkImageStamp(draft.image, pageCount, current);

  const setText = (patch: Partial<TextStampForm>) => {
    setDraft((d) => ({ ...d, text: { ...d.text, ...patch } }));
    setPresetKey(CUSTOM);
  };
  const setImage = (patch: Partial<ImageStampForm>) => {
    setDraft((d) => ({ ...d, image: { ...d.image, ...patch } }));
  };
  /** Sets a field of the active form (text or image). */
  const setPos = (patch: Partial<TextStampForm & ImageStampForm>) =>
    isText ? setText(patch) : setImage(patch);

  const presetOptions = [
    { value: CUSTOM, label: t('stamp.preset.custom') },
    ...presets.map((p) => ({ value: p.id, label: p.title })),
  ];
  const applyPreset = (key: string) => {
    setPresetKey(key);
    const p = presets.find((x) => x.id === key);
    if (p) setDraft((d) => ({ ...d, text: presetForm(d.text, p) }));
  };

  const insertChip = (chip: StampChip) => setText({ text: withChip(draft.text.text, chip) });

  const materializeLibraryItem = async (id: string) => {
    if (!id) return;
    try {
      const path = await chef().library.materialize(id);
      setMaterialized(path);
      setImage({ path });
    } catch {
      // The library refused: nothing to show, the picker stays as it was.
    }
  };
  const pickFile = async () => {
    const path = await pickImage();
    if (path) {
      setMaterialized(null);
      setImage({ path });
    }
  };

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (!check.ok) warnings.push(t(`stamp.err.${check.field}`));

  const run = async () => {
    const title = t(isText ? 'stamp.textJob' : 'stamp.imageJob', { name: doc.name });
    const prefs = { dialog: 'stamp', value: draft };
    const ok = isText
      ? await applyOverlay(
          doc.id,
          'stamp.text',
          textStampParams(draft.text, current, pageCount, userName),
          title,
          prefs,
        )
      : await applyOverlay(
          doc.id,
          'stamp.image',
          imageStampParams(draft.image, current, pageCount),
          title,
          prefs,
        );
    if (materialized) {
      void chef()
        .library.release(materialized)
        .catch(() => undefined);
      setMaterialized(null);
      setImage({ path: '' });
    }
    if (ok) close();
  };

  const onPlace = () => {
    if (blocked) return;
    useOverlayState.getState().start({ docId: doc.id, mode: 'point', returnTo: 'stamp' });
  };

  const previewText = resolveStampText(draft.text.text, new Date(), userName);
  const preview = (
    <PagePreview width={595} height={842} label={t('stamp.previewLabel')}>
      {isText ? (
        <span
          className="ov-wm"
          style={{
            left: '50%',
            top: '50%',
            color: draft.text.color,
            opacity: draft.text.opacity,
            border: `${draft.text.borderWidth}px solid ${draft.text.color}`,
            padding: '2px 6px',
            fontWeight: draft.text.bold ? 700 : 400,
            fontSize: '12px',
            whiteSpace: 'pre',
            transform: `translate(-50%, -50%) rotate(${-draft.text.rotation}deg)`,
          }}
        >
          {previewText}
        </span>
      ) : (
        <span className="ov-wm" style={{ left: '50%', top: '50%', opacity: draft.image.opacity }}>
          {draft.image.path ? draft.image.path.split(/[\\/]/).pop() : t('stamp.image.none')}
        </span>
      )}
    </PagePreview>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('stamp.title')}
      icon={<StampIcon size={18} />}
      description={t('stamp.description')}
      size="xl"
      sideWidth={360}
      preset={
        isText ? { value: presetKey, onChange: applyPreset, options: presetOptions } : undefined
      }
      runLabel={t('stamp.run')}
      onRun={() => void run()}
      canRun={check.ok && !blocked}
      warnings={warnings}
      preview={preview}
      advanced={
        <>
          <NumberField
            id="stamp-rotation"
            label={t('stamp.rotation')}
            value={pos.rotation}
            min={-360}
            max={360}
            step={1}
            onChange={(rotation) => setPos({ rotation })}
          />
          <NumberField
            id="stamp-opacity"
            label={t('stamp.opacity')}
            value={pos.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => setPos({ opacity })}
          />
          {isText && (
            <Switch
              checked={draft.text.bold}
              onChange={(bold) => setText({ bold })}
              label={t('stamp.bold')}
            />
          )}
          <Checkbox
            checked={pos.blendMultiply}
            onChange={(blendMultiply) => setPos({ blendMultiply })}
            label={t('stamp.multiply')}
            hint={t('stamp.multiplyHint')}
          />
        </>
      }
    >
      <Segmented<Kind>
        aria-label={t('stamp.kind.label')}
        value={draft.kind}
        onChange={(kind) => setDraft((d) => ({ ...d, kind }))}
        options={[
          { value: 'text', label: t('stamp.kind.text') },
          { value: 'image', label: t('stamp.kind.image') },
        ]}
      />
      {isText ? (
        <>
          <Field
            label={t('stamp.text.label')}
            htmlFor="stamp-text"
            hint={t('stamp.text.hint')}
            error={!check.ok && check.field === 'text' ? t('stamp.err.text') : undefined}
          >
            <textarea
              id="stamp-text"
              className="input stamp-text"
              rows={2}
              maxLength={200}
              value={draft.text.text}
              onChange={(e) => setText({ text: e.target.value })}
            />
          </Field>
          <div className="ov-chips" aria-label={t('stamp.chips.label')}>
            {STAMP_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                className="ov-chip"
                onClick={() => insertChip(c)}
                title={t(`stamp.chips.${c}`)}
              >
                {`{${c}}`}
              </button>
            ))}
          </div>
          <div className="field__row">
            <ColorInput
              id="stamp-color"
              label={t('stamp.color')}
              value={draft.text.color}
              onChange={(color) => setText({ color })}
            />
            <NumberField
              id="stamp-size"
              label={t('stamp.fontSize')}
              value={draft.text.fontSize}
              min={4}
              max={120}
              step={1}
              onChange={(fontSize) => setText({ fontSize })}
            />
            <NumberField
              id="stamp-border"
              label={t('stamp.border')}
              value={draft.text.borderWidth}
              min={0}
              max={20}
              step={0.5}
              onChange={(borderWidth) => setText({ borderWidth })}
            />
          </div>
        </>
      ) : (
        <>
          <Field label={t('stamp.image.library')} htmlFor="stamp-library">
            <div className="field__row">
              <Select<string>
                id="stamp-library"
                value=""
                onChange={(id) => void materializeLibraryItem(id)}
                options={[
                  { value: '', label: t('stamp.image.choose') },
                  ...library.map((i) => ({ value: i.id, label: i.name })),
                ]}
                aria-label={t('stamp.image.library')}
              />
              <Button onClick={() => void pickFile()}>{t('stamp.image.file')}</Button>
            </div>
          </Field>
          <NumberField
            id="stamp-width"
            label={t('stamp.image.width', { unit: t(`overlay.unit.${draft.image.unit}`) })}
            value={draft.image.width}
            min={1}
            max={2000}
            step={1}
            invalid={!check.ok && check.field === 'width'}
            onChange={(width) => setImage({ width })}
          />
        </>
      )}
      <PositionFields
        idPrefix="stamp"
        x={pos.x}
        y={pos.y}
        unit={pos.unit}
        onChange={setPos}
        onPlace={onPlace}
        placeDisabled={blocked}
        invalid={!check.ok && check.field === 'position'}
      />
      <PagesField
        id="stamp"
        value={pos.pages}
        onChange={(pages) => setPos({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
    </TaskDialog>
  );
}
