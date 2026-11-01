/**
 * Dấu giáp lai (F4): one seal image cut into equal vertical strips, one strip on the edge of each
 * page of a set. The preview draws the slices of the first set and the page count. The result
 * lists the strips the core placed. Removable in the overlay manager (kind stamp).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stamp as StampIcon } from 'lucide-react';
import type { LibraryItem } from '@chef/contracts';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { chef } from '../../lib/bridge';
import { pickImage, prefsOf, savePrefs } from '../overlay/overlayActions';
import { selectedPages } from '../overlay/overlayModel';
import { NumberField, PagePreview, PagesField, useCurrentPage } from '../overlay/OverlayControls';
import { useDraft } from '../overlay/overlayState';
import '../overlay/overlay.css';
import {
  DEFAULT_SEAM_FORM,
  checkSeamForm,
  seamParams,
  seamPlan,
  seamSliceCount,
  summarizeSeam,
  type SeamForm,
  type SeamSide,
  type SeamVertical,
} from './seamModel';

const ENUMS = {
  side: ['right', 'left'],
  vertical: ['center', 'top', 'bottom', 'mm'],
  choice: ['current', 'all', 'range', 'odd', 'even'],
};

interface StripResult {
  page: number;
  strip: number;
  of: number;
}

/** Dấu giáp lai (F4). */
export function SeamDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [draft, setDraft] = useDraft<SeamForm>('seam', () =>
    prefsOf('seam', DEFAULT_SEAM_FORM, ENUMS),
  );
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [result, setResult] = useState<StripResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const current = useCurrentPage(doc?.id);

  // The library seal is copied to a temp file for the core: released when the dialog closes.
  const materialized = useRef<string | null>(null);
  useEffect(() => {
    void chef()
      .library.list()
      .then((items) => setLibrary(items.filter((i) => i.kind === 'stamp')))
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
  const check = checkSeamForm(draft, pageCount, current);
  const pages = selectedPages(draft.pages, current, pageCount);
  const plan = seamPlan(pages, draft.groupSize, draft.cutFirstPage);
  const slices = seamSliceCount(plan);

  const set = (patch: Partial<SeamForm>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setResult(null);
  };

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
  if (!check.ok) warnings.push(t(`seam.err.${check.field}`));

  const run = async () => {
    setRunning(true);
    try {
      const r = await runDocOp(
        doc.id,
        'stamp.seam',
        seamParams(draft, current, pageCount),
        t('seam.job', { name: doc.name }),
      );
      if (!r) return;
      savePrefs('seam', draft);
      // The result stays on screen so the user can check every strip before closing.
      setResult((r.data as { strips?: StripResult[] } | null)?.strips ?? []);
    } finally {
      setRunning(false);
    }
  };

  const summary = result ? summarizeSeam(result) : null;
  const sides: SeamSide[] = ['right', 'left'];
  const verticals: SeamVertical[] = ['center', 'top', 'bottom', 'mm'];

  const preview = (
    <PagePreview width={595} height={842} label={t('seam.previewLabel')}>
      <div className="seam-diagram" aria-label={t('seam.diagram.label')}>
        {Array.from({ length: Math.min(slices, 24) }, (_, k) => (
          <span key={k} className="seam-diagram__slice" data-strip={k + 1}>
            {k + 1}
          </span>
        ))}
      </div>
      <span className="seam-diagram__count">
        {t('seam.diagram.slices', { count: slices })} ·{' '}
        {t('seam.diagram.pages', { count: pages.length })}
      </span>
    </PagePreview>
  );

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('seam.title')}
      icon={<StampIcon size={18} />}
      description={t('seam.description')}
      size="xl"
      sideWidth={360}
      runLabel={t('seam.run')}
      onRun={() => void run()}
      canRun={check.ok && !blocked && !running}
      running={running}
      warnings={warnings}
      preview={preview}
      advanced={
        <>
          <NumberField
            id="seam-overlap"
            label={t('seam.overlap')}
            value={draft.overlapMm}
            min={0}
            max={50}
            step={0.5}
            invalid={!check.ok && check.field === 'overlapMm'}
            onChange={(overlapMm) => set({ overlapMm })}
          />
          <NumberField
            id="seam-opacity"
            label={t('seam.opacity')}
            value={draft.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => set({ opacity })}
          />
          <Checkbox
            checked={draft.blendMultiply}
            onChange={(blendMultiply) => set({ blendMultiply })}
            label={t('seam.multiply')}
            hint={t('seam.multiplyHint')}
          />
        </>
      }
    >
      <Field
        label={t('seam.image.label')}
        htmlFor="seam-library"
        error={!check.ok && check.field === 'path' ? t('seam.err.path') : undefined}
      >
        <div className="field__row">
          <Select<string>
            id="seam-library"
            value=""
            onChange={(id) => void pickLibrary(id)}
            options={[
              { value: '', label: t('seam.image.choose') },
              ...library.map((i) => ({ value: i.id, label: i.name })),
            ]}
            aria-label={t('seam.image.library')}
          />
          <Button onClick={() => void pickFile()}>{t('seam.image.file')}</Button>
        </div>
        <span className="field__hint">
          {draft.path ? draft.path.split(/[\\/]/).pop() : t('seam.image.none')}
        </span>
      </Field>
      <div className="field__row">
        <Field label={t('seam.side.label')} htmlFor="seam-side">
          <Select<SeamSide>
            id="seam-side"
            value={draft.side}
            onChange={(side) => set({ side })}
            options={sides.map((s) => ({ value: s, label: t(`seam.side.${s}`) }))}
          />
        </Field>
        <NumberField
          id="seam-group"
          label={t('seam.groupSize')}
          value={draft.groupSize}
          min={0}
          max={10000}
          step={1}
          invalid={!check.ok && check.field === 'groupSize'}
          onChange={(groupSize) => set({ groupSize: Math.round(groupSize) })}
        />
        <NumberField
          id="seam-scale"
          label={t('seam.scaleWidth')}
          value={draft.scaleWidthMm}
          min={0}
          max={1000}
          step={1}
          invalid={!check.ok && check.field === 'scaleWidthMm'}
          onChange={(scaleWidthMm) => set({ scaleWidthMm })}
        />
      </div>
      <div className="field__row">
        <Field label={t('seam.vertical.label')} htmlFor="seam-vertical">
          <Select<SeamVertical>
            id="seam-vertical"
            value={draft.vertical}
            onChange={(vertical) => set({ vertical })}
            options={verticals.map((v) => ({ value: v, label: t(`seam.vertical.${v}`) }))}
          />
        </Field>
        {draft.vertical === 'mm' && (
          <NumberField
            id="seam-vertical-mm"
            label={t('seam.verticalMm')}
            value={draft.verticalMm}
            min={0}
            max={10000}
            step={1}
            invalid={!check.ok && check.field === 'verticalMm'}
            onChange={(verticalMm) => set({ verticalMm })}
          />
        )}
      </div>
      <Checkbox
        checked={draft.cutFirstPage}
        onChange={(cutFirstPage) => set({ cutFirstPage })}
        label={t('seam.cutFirstPage')}
      />
      <PagesField
        id="seam"
        value={draft.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
        invalid={!check.ok && check.field === 'pages'}
      />
      {summary && (
        <div className="seam-result" role="status">
          <strong>{t('seam.result.title')}</strong>
          <p>
            {t('seam.result.summary', {
              strips: summary.strips,
              pages: summary.pages,
              sets: summary.sets,
            })}
          </p>
          <ul>
            {(result ?? []).map((s) => (
              <li key={`${s.page}-${s.strip}`}>
                {t('seam.result.line', { page: s.page + 1, strip: s.strip, of: s.of })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </TaskDialog>
  );
}
