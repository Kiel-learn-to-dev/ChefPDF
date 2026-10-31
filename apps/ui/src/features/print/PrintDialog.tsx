import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useView } from '../../app/state/viewer';
import { showError } from '../../app/actions';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Button } from '../../components/Button';
import { Field, RadioGroup, Select, TextInput } from '../../components/Form';
import { ProgressBar } from '../../components/Misc';
import { allPages, formatPageRanges, parsePageRanges } from '../../lib/pageRange';
import { whenPdfLoaded } from '../viewer/pdfCache';
import { useSelection } from '../pages/pageStore';
import { printPages } from './print';

type Range = 'all' | 'current' | 'selection' | 'custom';

/** A7: print selected pages through the OS print dialog. */
export function PrintDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const view = useView(doc?.id);
  const selection = useSelection(doc?.id);
  const close = useUi((s) => s.closeDialog);
  const [range, setRange] = useState<Range>(selection.selected.length > 1 ? 'selection' : 'all');
  const [custom, setCustom] = useState('');
  const [dpi, setDpi] = useState<'150' | '300'>('150');
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  if (!doc) return null;
  const count = doc.info.pageCount;
  const parsed = range === 'custom' ? parsePageRanges(custom, count) : null;
  const pages =
    range === 'all'
      ? allPages(count)
      : range === 'current'
        ? [view.page - 1]
        : range === 'selection'
          ? selection.selected
          : parsed?.ok
            ? parsed.pages
            : [];
  const customError =
    range === 'custom' && custom.trim() && parsed && !parsed.ok
      ? t(`range.${parsed.error}`)
      : undefined;
  const running = progress !== null;

  const run = async () => {
    abort.current = new AbortController();
    setProgress(0);
    try {
      const pdf = await whenPdfLoaded(doc);
      await printPages(
        pdf,
        pages,
        Number(dpi),
        (d, total) => setProgress(d / total),
        abort.current.signal,
      );
      if (!abort.current.signal.aborted) close();
    } catch (e) {
      showError(e, t('print.failed'));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          abort.current?.abort();
          close();
        }
      }}
      size="sm"
      icon={<Printer size={18} />}
      title={t('print.title')}
      description={t('print.description', { name: doc.name })}
      footer={
        <>
          <span className="muted">{t('print.pageCount', { count: pages.length })}</span>
          <DialogSpacer />
          <Button
            onClick={() => {
              abort.current?.abort();
              close();
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Printer size={15} />}
            loading={running}
            disabled={pages.length === 0}
            onClick={() => void run()}
          >
            {t('print.print')}
          </Button>
        </>
      }
    >
      <Field label={t('print.pages')}>
        <RadioGroup<Range>
          value={range}
          onChange={setRange}
          aria-label={t('print.pages')}
          options={[
            { value: 'all', label: t('print.all', { count }) },
            { value: 'current', label: t('print.current', { page: view.page }) },
            ...(selection.selected.length > 0
              ? [
                  {
                    value: 'selection' as const,
                    label: t('print.selection', { ranges: formatPageRanges(selection.selected) }),
                  },
                ]
              : []),
            { value: 'custom', label: t('print.custom') },
          ]}
        />
      </Field>
      {range === 'custom' && (
        <Field htmlFor="print-range" hint={t('range.hint')} error={customError}>
          <TextInput
            id="print-range"
            autoFocus
            value={custom}
            placeholder="1-3, 5"
            invalid={!!customError}
            onChange={(e) => setCustom(e.target.value)}
          />
        </Field>
      )}
      <Field label={t('print.quality')}>
        <Select<'150' | '300'>
          value={dpi}
          onChange={setDpi}
          aria-label={t('print.quality')}
          options={[
            { value: '150', label: t('print.standard') },
            { value: '300', label: t('print.high') },
          ]}
        />
      </Field>
      {running && (
        <div style={{ marginTop: 16 }}>
          <ProgressBar value={progress} label={t('print.preparing')} />
          <div className="field__hint" style={{ marginTop: 6 }}>
            {t('print.preparing')}
          </div>
        </div>
      )}
    </Dialog>
  );
}
