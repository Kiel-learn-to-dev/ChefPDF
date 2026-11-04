import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { toast } from '../../components/Toast';
import { runOp } from '../../lib/rpc';
import { PagesField, useCurrentPage } from '../overlay/OverlayControls';
import { selectedPages, type PagesSel } from '../overlay/overlayModel';

type Paper = 'auto' | 'A4' | 'A5' | 'Letter';
interface Row {
  pageIndex: number;
  status: 'done' | 'skipped';
  confidence?: number;
  method?: string;
  reason?: string;
  paperSize?: string | null;
}
const MIN_CONFIDENCE = 0.6;

export function BatchCropDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const open = useUi((s) => s.openDialog);
  const currentPage = useCurrentPage(doc?.id);
  const [pages, setPages] = useState<PagesSel>({ choice: 'all', range: '' });
  const [paper, setPaper] = useState<Paper>('auto');
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<{ key: string; rows: Row[] } | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  if (!doc) return null;
  const selected = selectedPages(pages, currentPage, doc.info.pageCount);
  const key = `${doc.state.revisionPath}:${selected.join(',')}`;
  const rows = scan?.key === key ? scan.rows : [];
  const workflowPages = rows.length ? checked : selected;
  // Quick review: the pages that are not ticked, in page order, and that were detected at all.
  const reviewQueue = rows
    .filter((r) => r.status === 'done' && !checked.includes(r.pageIndex))
    .map((r) => r.pageIndex);
  const detect = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const result = await runOp(
        'pageimg.detectQuad',
        { pages: selected },
        { sessionId: doc.id, title: t('batchCrop.detect') },
      );
      const resultRows = (result.data as { pages?: Row[] } | undefined)?.pages;
      if (!Array.isArray(resultRows)) throw new Error(t('cropReview.badResult'));
      setScan({ key, rows: resultRows });
      setChecked(
        resultRows
          .filter((r) => r.status === 'done' && (r.confidence ?? 0) >= MIN_CONFIDENCE)
          .map((r) => r.pageIndex),
      );
    } catch (e) {
      showError(e, t('batchCrop.title'));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!checked.length || !rows.length || doc.state.signed) return;
    setBusy(true);
    try {
      const result = await runDocOp(
        doc.id,
        'pageimg.autoCrop',
        { pages: checked, minConfidence: MIN_CONFIDENCE, paperSize: paper },
        t('batchCrop.title'),
        { toastWarnings: true },
      );
      if (result) {
        const needsReview =
          (result.data as { needsReview?: number[] } | undefined)?.needsReview ?? [];
        if (needsReview.length)
          toast.warning(
            t('batchCrop.title'),
            t('batchCrop.reviewAfter', { pages: needsReview.map((n) => n + 1).join(', ') }),
          );
        else toast.success(t('batchCrop.done'));
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('batchCrop.title')}
      icon={<ScanSearch size={18} />}
      description={t('batchCrop.description')}
      warnings={[t('cropReview.warning')]}
      size="xl"
      running={busy}
      onRun={() => void apply()}
      runLabel={t('batchCrop.apply')}
      canRun={!busy && !doc.state.signed && !!rows.length && !!checked.length}
      workflowStep={
        workflowPages.length
          ? {
              op: 'pageimg.autoCrop',
              params: {
                ...(workflowPages.length === doc.info.pageCount ? {} : { pages: workflowPages }),
                minConfidence: MIN_CONFIDENCE,
                paperSize: paper,
              },
              label: t('batchCrop.title'),
            }
          : undefined
      }
      preview={
        <div>
          <h3>{t('batchCrop.results')}</h3>
          {rows.length > 0 && reviewQueue.length > 0 && (
            <Button
              disabled={busy}
              onClick={() =>
                open('cropReview', { page: reviewQueue[0]! + 1, queue: reviewQueue.slice(1) })
              }
            >
              {t('batchCrop.quickReview', { count: reviewQueue.length })}
            </Button>
          )}
          {!rows.length ? (
            <p>{t('batchCrop.hint')}</p>
          ) : (
            <ul className="batch-crop__list">
              {rows.map((row) => {
                const eligible = row.status === 'done' && (row.confidence ?? 0) >= MIN_CONFIDENCE;
                return (
                  <li key={row.pageIndex}>
                    <Checkbox
                      checked={checked.includes(row.pageIndex)}
                      disabled={!eligible || busy}
                      onChange={(on) =>
                        setChecked((old) =>
                          on ? [...old, row.pageIndex] : old.filter((p) => p !== row.pageIndex),
                        )
                      }
                      label={t('batchCrop.row', {
                        page: row.pageIndex + 1,
                        confidence: Math.round((row.confidence ?? 0) * 100),
                      })}
                    />
                    <span>{eligible ? t('batchCrop.ready') : t('batchCrop.review')}</span>
                    {row.paperSize && (
                      <span>{t('batchCrop.detectedPaper', { paper: row.paperSize })}</span>
                    )}
                    {row.status === 'done' && (
                      <Button
                        disabled={busy}
                        onClick={() => open('cropReview', { page: row.pageIndex + 1 })}
                      >
                        {t('batchCrop.manual')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      }
    >
      <PagesField
        id="batch-crop-pages"
        value={pages}
        onChange={setPages}
        pageCount={doc.info.pageCount}
        currentPage={currentPage + 1}
      />
      <Field label={t('batchCrop.paper')} htmlFor="batch-crop-paper">
        <Select<Paper>
          id="batch-crop-paper"
          value={paper}
          onChange={setPaper}
          options={[
            { value: 'auto', label: t('batchCrop.auto') },
            { value: 'A4', label: 'A4' },
            { value: 'A5', label: 'A5' },
            { value: 'Letter', label: 'Letter' },
          ]}
        />
      </Field>
      <Button disabled={!selected.length || busy} onClick={() => void detect()}>
        {t('batchCrop.detect')}
      </Button>
    </TaskDialog>
  );
}
