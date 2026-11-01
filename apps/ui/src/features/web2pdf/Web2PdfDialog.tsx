/**
 * "Trang web / Markdown → PDF" (T5.06): a web page address, or a Markdown / HTML file the user
 * picks, is printed to a PDF by the main process (`chef.convert.toPdf`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { announceOutputs, pickSavePath, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox, Field, Select, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { NumberField } from '../overlay/OverlayControls';
import {
  DEFAULT_WEB2PDF_FORM,
  MARGIN_RANGE,
  defaultPdfName,
  web2pdfIssues,
  web2pdfRequest,
  type Web2PdfForm,
  type Web2PdfSourceKind,
} from './web2pdfModel';
import './web2pdf.css';

const WEB_FILE_FILTERS = [
  { name: 'Markdown / HTML', extensions: ['md', 'markdown', 'html', 'htm'] },
];

export function Web2PdfDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useState<Web2PdfForm>(DEFAULT_WEB2PDF_FORM);
  const [outputPath, setOutputPath] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<Web2PdfForm>) => setForm((f) => ({ ...f, ...patch }));
  const issues = web2pdfIssues(form, outputPath);

  const chooseFile = async () => {
    const [picked] = await chef().files.openDialog({ multiple: false, filters: WEB_FILE_FILTERS });
    if (picked) set({ source: picked });
  };

  const chooseOutput = async () => {
    const suggested = defaultPdfName(form.source);
    const out = await pickSavePath(suggested, form.kind === 'file' ? form.source : null);
    if (out) setOutputPath(out.toLowerCase().endsWith('.pdf') ? out : `${out}.pdf`);
  };

  const run = async () => {
    if (issues.length > 0) return;
    setBusy(true);
    try {
      const r = await chef().convert.toPdf(web2pdfRequest(form, outputPath));
      announceOutputs(t('web2pdf.done'), [r.outputPath]);
      close();
    } catch (e) {
      showError(e, t('web2pdf.failed'));
    } finally {
      setBusy(false);
    }
  };

  const kinds: { value: Web2PdfSourceKind; label: string }[] = [
    { value: 'url', label: t('web2pdf.kindUrl') },
    { value: 'file', label: t('web2pdf.kindFile') },
  ];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={t('web2pdf.title')}
      icon={<Globe size={18} />}
      description={t('web2pdf.description')}
      size="lg"
      modalLock={busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => close()} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void run()}
            disabled={issues.length > 0 || busy}
            loading={busy}
          >
            {busy ? t('web2pdf.running') : t('web2pdf.run')}
          </Button>
        </>
      }
    >
      <div className="web2pdf">
        <Field label={t('web2pdf.kind')} htmlFor="w2p-kind">
          <Select<Web2PdfSourceKind>
            id="w2p-kind"
            value={form.kind}
            onChange={(kind) => set({ kind, source: '', confirmed: false })}
            options={kinds}
          />
        </Field>

        {form.kind === 'url' ? (
          <Field
            label={t('web2pdf.url')}
            htmlFor="w2p-url"
            hint={t('web2pdf.urlHint')}
            error={issues.includes('source') ? t('web2pdf.needSource') : undefined}
          >
            <TextInput
              id="w2p-url"
              value={form.source}
              placeholder="https://"
              onChange={(e) => set({ source: e.target.value, confirmed: false })}
            />
          </Field>
        ) : (
          <Field
            label={t('web2pdf.file')}
            htmlFor="w2p-file"
            hint={t('web2pdf.mdNote')}
            error={issues.includes('source') ? t('web2pdf.needSource') : undefined}
          >
            <div className="field__row">
              <TextInput id="w2p-file" value={form.source} readOnly />
              <Button onClick={() => void chooseFile()}>{t('web2pdf.pickFile')}</Button>
            </div>
          </Field>
        )}

        {form.kind === 'url' && (
          <Checkbox
            checked={form.confirmed}
            onChange={(confirmed) => set({ confirmed })}
            label={t('web2pdf.confirm')}
          />
        )}

        <Field
          label={t('web2pdf.output')}
          htmlFor="w2p-out"
          error={issues.includes('output') ? t('web2pdf.needOutput') : undefined}
        >
          <div className="field__row">
            <TextInput id="w2p-out" value={outputPath} readOnly />
            <Button onClick={() => void chooseOutput()}>{t('web2pdf.chooseOutput')}</Button>
          </div>
        </Field>

        <div className="field__row">
          <Field label={t('web2pdf.pageSize')} htmlFor="w2p-size">
            <Select<Web2PdfForm['pageSize']>
              id="w2p-size"
              value={form.pageSize}
              onChange={(pageSize) => set({ pageSize })}
              options={[
                { value: 'A4', label: 'A4' },
                { value: 'Letter', label: 'Letter' },
              ]}
            />
          </Field>
          <NumberField
            id="w2p-margin"
            label={t('web2pdf.margin')}
            value={form.marginMm}
            min={MARGIN_RANGE.min}
            max={MARGIN_RANGE.max}
            step={1}
            invalid={issues.includes('margin')}
            onChange={(marginMm) => set({ marginMm })}
          />
        </div>

        <Checkbox
          checked={form.landscape}
          onChange={(landscape) => set({ landscape })}
          label={t('web2pdf.landscape')}
        />
        <Checkbox
          checked={form.printBackground}
          onChange={(printBackground) => set({ printBackground })}
          label={t('web2pdf.printBackground')}
        />
        <Checkbox
          checked={form.headerFooter}
          onChange={(headerFooter) => set({ headerFooter })}
          label={t('web2pdf.headerFooter')}
        />
      </div>
    </Dialog>
  );
}
