/**
 * "Xóa trang trắng" (C8; T5.09): page.findBlank lists the candidates with thumbnails and flags;
 * the pages flagged blank start checked; the selected pages are deleted (page.removeBlank when the
 * selection is exactly the candidates, otherwise page.delete). Sensitivity re-runs the detection.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { errorMessage, runDocOp } from '../../app/actions';
import { runOp } from '../../lib/rpc';
import { Checkbox } from '../../components/Form';
import { Slider } from '../../components/Slider';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { usePdfDocument } from '../viewer/pdfCache';
import { useThumbnail } from '../viewer/thumbnails';
import type { DocTab } from '../../app/state/documents';
import type { PDFDocumentProxy } from '../viewer/pdfjs';
import {
  DEFAULT_BLANK_FORM,
  blankParams,
  defaultBlankSelection,
  readBlankRows,
  removalPlan,
  type BlankForm,
  type BlankRow,
} from './blankModel';
import './pagetools.css';

function BlankThumb({
  doc,
  pdf,
  index,
}: {
  doc: DocTab;
  pdf: PDFDocumentProxy | undefined;
  index: number;
}) {
  const url = useThumbnail(doc, pdf, index, 120, true);
  return url ? <img src={url} alt="" /> : <span className="pt-hint">…</span>;
}

/** Xóa trang trắng (C8). */
export function BlankReviewDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const { pdf } = usePdfDocument(doc);
  const [form, setForm] = useState<BlankForm>(DEFAULT_BLANK_FORM);
  const [rows, setRows] = useState<BlankRow[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  // Starts true: the first detection runs as the dialog mounts.
  const [busy, setBusy] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docId = doc?.id;
  const docName = doc?.name ?? '';

  // Detection runs again whenever the sensitivity or the annotation rule changes.
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    runOp('page.findBlank', blankParams(form), {
      sessionId: docId,
      title: docName,
      silent: true,
    })
      .then((r) => {
        if (!alive) return;
        const next = readBlankRows(r.data);
        setRows(next);
        setSelected(defaultBlankSelection(next));
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params are the two primitives below
  }, [docId, form.sensitivity, form.keepIfAnnotations]);

  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const signed = doc.state.signed;
  const plan = removalPlan(rows, selected, pageCount, blankParams(form));
  const toggle = (index: number) =>
    setSelected((s) =>
      s.includes(index) ? s.filter((x) => x !== index) : [...s, index].sort((a, b) => a - b),
    );

  const run = async () => {
    if (!plan || signed) return;
    setDeleting(true);
    const title = t('pageTools.blank.jobTitle', { name: doc.name });
    const r =
      plan.opId === 'page.removeBlank'
        ? await runDocOp(doc.id, 'page.removeBlank', plan.params, title)
        : await runDocOp(doc.id, 'page.delete', plan.params, title);
    setDeleting(false);
    if (r) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      size="lg"
      title={t('pageTools.blank.title')}
      icon={<ScanSearch size={18} />}
      description={t('pageTools.blank.description', { name: doc.name })}
      runLabel={t('pageTools.blank.run', { count: selected.length })}
      onRun={() => void run()}
      canRun={!!plan && !signed && !busy && !deleting}
      running={deleting}
      warnings={[...(signed ? [t('pageTools.signedBlocked')] : []), ...(error ? [error] : [])]}
      sideWidth={300}
      preview={
        <Slider
          value={Math.round(form.sensitivity * 100)}
          min={0}
          max={100}
          step={5}
          label={t('pageTools.blank.sensitivity')}
          onChange={(v) => setForm((f) => ({ ...f, sensitivity: v / 100 }))}
        />
      }
      advanced={
        <Checkbox
          checked={form.keepIfAnnotations}
          onChange={(keepIfAnnotations) => setForm((f) => ({ ...f, keepIfAnnotations }))}
          label={t('pageTools.blank.keepAnnotations')}
          hint={t('pageTools.blank.keepAnnotationsHint')}
        />
      }
    >
      {busy && <Spinner label={t('pageTools.blank.detecting')} />}
      {!busy && rows.length === 0 && !error && (
        <p className="pt-hint">{t('pageTools.blank.none')}</p>
      )}
      <p className="pt-hint">{t('pageTools.blank.explain')}</p>
      <div className="pt-grid" role="group" aria-label={t('pageTools.blank.list')}>
        {rows.map((r) => {
          const flags = [
            `${t('pageTools.blank.ink', { percent: (r.inkRatio * 100).toFixed(2) })}`,
            r.hasText ? t('pageTools.blank.flagText') : null,
            r.hasAnnotations ? t('pageTools.blank.flagAnnotations') : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div key={r.index} className="pt-card">
              <BlankThumb doc={doc} pdf={pdf} index={r.index} />
              <Checkbox
                checked={selected.includes(r.index)}
                onChange={() => toggle(r.index)}
                label={t('pageTools.pageN', { page: r.index + 1 })}
                hint={flags}
              />
            </div>
          );
        })}
      </div>
    </TaskDialog>
  );
}
