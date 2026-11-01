/**
 * Chữ ký nháy (F6): the initials (text or image) on a corner, an edge or the centre of the chosen
 * pages. Removable in the overlay manager (kind stamp).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PenLine } from 'lucide-react';
import type { LibraryItem } from '@chef/contracts';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select, Switch } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { chef } from '../../lib/bridge';
import { ColorInput } from '../overlay/ColorInput';
import { applyOverlay, pickImage, prefsOf } from '../overlay/overlayActions';
import { NumberField, PagePreview, PagesField, useCurrentPage } from '../overlay/OverlayControls';
import { useDraft } from '../overlay/overlayState';
import '../overlay/overlay.css';
import './stamps.css';
import {
  DEFAULT_INITIALS_FORM,
  INITIALS_POSITIONS,
  checkInitials,
  initialsParams,
  positionFraction,
  type InitialsForm,
  type InitialsKind,
  type InitialsPosition,
} from './initialsModel';

const ENUMS = {
  kind: ['text', 'image'],
  position: INITIALS_POSITIONS,
  choice: ['current', 'all', 'range', 'odd', 'even'],
};

/** Chữ ký nháy (F6). */
export function InitialsDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [draft, setDraft] = useDraft<InitialsForm>('initials', () =>
    prefsOf('initials', DEFAULT_INITIALS_FORM, ENUMS),
  );
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const current = useCurrentPage(doc?.id);

  // The library image is copied to a temp file for the core: released when the dialog closes.
  const materialized = useRef<string | null>(null);
  useEffect(() => {
    void chef()
      .library.list()
      .then((items) =>
        setLibrary(items.filter((i) => i.kind === 'initials' || i.kind === 'signature')),
      )
      .catch(() => undefined);
    return () => {
      if (materialized.current)
        void chef()
          .library.release(materialized.current)
          .catch(() => undefined);
    };
  }, []);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const blocked = doc.state.signed;
  const check = checkInitials(draft, pageCount, current);
  const set = (patch: Partial<InitialsForm>) => setDraft((d) => ({ ...d, ...patch }));

  const pickFile = async () => {
    const path = await pickImage();
    if (path) set({ path });
  };
  const pickLibrary = async (id: string) => {
    if (!id) return;
    try {
      const path = await chef().library.materialize(id);
      if (materialized.current)
        void chef()
          .library.release(materialized.current)
          .catch(() => undefined);
      materialized.current = path;
      set({ path });
    } catch {
      // The library refused: the picker stays as it was.
    }
  };

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (!check.ok) warnings.push(t(`initials.err.${check.field}`));

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'stamp.initials',
      initialsParams(draft, current, pageCount),
      t('initials.job', { name: doc.name }),
      { dialog: 'initials', value: draft },
    );
    if (ok) close();
  };

  const at = positionFraction(draft.position);
  const preview = (
    <PagePreview width={595} height={842} label={t('initials.previewLabel')}>
      <span
        className="initials-mark"
        style={{
          left: `${at.x * 100}%`,
          top: `${at.y * 100}%`,
          color: draft.color,
          opacity: draft.opacity,
          fontWeight: draft.bold ? 700 : 400,
        }}
      >
        {draft.kind === 'text'
          ? draft.text || t('initials.text.empty')
          : draft.path
            ? (draft.path.split(/[\\/]/).pop() ?? '')
            : t('initials.none')}
      </span>
    </PagePreview>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('initials.title')}
      icon={<PenLine size={18} />}
      description={t('initials.description')}
      size="xl"
      sideWidth={360}
      runLabel={t('initials.run')}
      onRun={() => void run()}
      canRun={check.ok && !blocked}
      warnings={warnings}
      preview={preview}
      advanced={
        <>
          <NumberField
            id="initials-opacity"
            label={t('initials.opacity')}
            value={draft.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => set({ opacity })}
          />
          <Switch
            checked={draft.bold}
            onChange={(bold) => set({ bold })}
            label={t('initials.bold')}
          />
          <Checkbox
            checked={draft.blendMultiply}
            onChange={(blendMultiply) => set({ blendMultiply })}
            label={t('initials.multiply')}
            hint={t('initials.multiplyHint')}
          />
        </>
      }
    >
      <Field label={t('initials.kind.label')} htmlFor="initials-kind">
        <Select<InitialsKind>
          id="initials-kind"
          value={draft.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: 'text', label: t('initials.kind.text') },
            { value: 'image', label: t('initials.kind.image') },
          ]}
        />
      </Field>
      {draft.kind === 'text' ? (
        <div className="field__row">
          <Field
            label={t('initials.text.label')}
            htmlFor="initials-text"
            error={!check.ok && check.field === 'text' ? t('initials.err.text') : undefined}
          >
            <input
              id="initials-text"
              className="input"
              maxLength={40}
              value={draft.text}
              onChange={(e) => set({ text: e.target.value })}
            />
          </Field>
          <ColorInput
            id="initials-color"
            label={t('initials.color')}
            value={draft.color}
            onChange={(color) => set({ color })}
          />
          <NumberField
            id="initials-size"
            label={t('initials.fontSize')}
            value={draft.fontSize}
            min={4}
            max={120}
            step={1}
            onChange={(fontSize) => set({ fontSize })}
          />
        </div>
      ) : (
        <Field
          label={t('initials.image.label')}
          htmlFor="initials-library"
          error={!check.ok && check.field === 'path' ? t('initials.err.path') : undefined}
        >
          <div className="field__row">
            <Select<string>
              id="initials-library"
              value=""
              onChange={(id) => void pickLibrary(id)}
              options={[
                { value: '', label: t('initials.image.choose') },
                ...library.map((i) => ({ value: i.id, label: i.name })),
              ]}
              aria-label={t('initials.image.library')}
            />
            <Button onClick={() => void pickFile()}>{t('initials.image.file')}</Button>
          </div>
          <span className="field__hint">
            {draft.path ? draft.path.split(/[\\/]/).pop() : t('initials.none')}
          </span>
          <NumberField
            id="initials-width"
            label={t('initials.width')}
            value={draft.widthMm}
            min={1}
            max={500}
            step={1}
            invalid={!check.ok && check.field === 'widthMm'}
            onChange={(widthMm) => set({ widthMm })}
          />
        </Field>
      )}
      <div className="field__row">
        <Field label={t('initials.position')} htmlFor="initials-position">
          <Select<InitialsPosition>
            id="initials-position"
            value={draft.position}
            onChange={(position) => set({ position })}
            options={INITIALS_POSITIONS.map((p) => ({ value: p, label: t(`initials.pos.${p}`) }))}
          />
        </Field>
        <NumberField
          id="initials-margin"
          label={t('initials.margin')}
          value={draft.marginMm}
          min={0}
          max={100}
          step={1}
          invalid={!check.ok && check.field === 'marginMm'}
          onChange={(marginMm) => set({ marginMm })}
        />
      </div>
      <PagesField
        id="initials"
        value={draft.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
    </TaskDialog>
  );
}
