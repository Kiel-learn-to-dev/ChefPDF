/**
 * Conversions (T5.05): "PDF → ảnh" (M2) for the open document, and "Ảnh → PDF" (M3) with the
 * image list (order, add, remove, clipboard image M4). Screen capture is not part of this build:
 * the clipboard image is the way to bring a screenshot in.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ClipboardPaste, FileImage, FileStack, Trash2 } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import {
  IMAGE_FILTERS,
  announceOutputs,
  pickFolder,
  pickSavePath,
  showError,
} from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox, Field, Select, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { formatPageRanges } from '../../lib/pageRange';
import { runOp } from '../../lib/rpc';
import { NumberField, PagesField, useCurrentPage } from '../overlay/OverlayControls';
import { DEFAULT_PAGES, selectedPages, type PagesSel } from '../overlay/overlayModel';
import {
  DEFAULT_IMAGES_TO_PDF,
  DEFAULT_PDF_TO_IMAGES,
  addImages,
  defaultPdfName,
  imagesToPdfIssues,
  imagesToPdfParams,
  moveItem,
  pdfToImagesIssues,
  pdfToImagesParams,
  type ColorMode,
  type ImageFormat,
  type ImagesToPdfForm,
  type PageSizeMode,
  type PdfToImagesForm,
} from './convertModel';
import './convert.css';

/** PDF → ảnh (M2). */
export function PdfToImagesDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useState<PdfToImagesForm>(DEFAULT_PDF_TO_IMAGES);
  // Opened from the page grid on a set of pages (menu C13): preset the page range to them.
  const [pages, setPages] = useState<PagesSel>(() => {
    const preset = useUi.getState().dialogData as { pages?: number[] } | undefined;
    return preset?.pages?.length
      ? { choice: 'range', range: formatPageRanges(preset.pages) }
      : DEFAULT_PAGES;
  });
  const [busy, setBusy] = useState(false);
  const current = useCurrentPage(doc?.id);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const issues = pdfToImagesIssues(form);
  const set = (patch: Partial<PdfToImagesForm>) => setForm((f) => ({ ...f, ...patch }));

  const chooseFolder = async () => {
    const dir = await pickFolder();
    if (dir) set({ outputDir: dir });
  };

  const run = async () => {
    if (issues.length > 0) return;
    const title = t('convert.pdfJob', { name: doc.name });
    const selected = selectedPages(pages, current, pageCount);
    const allPages = selected.length === pageCount;
    setBusy(true);
    try {
      const r = await runOp(
        'convert.pdfToImages',
        pdfToImagesParams(form, {
          path: doc.state.revisionPath,
          password: doc.password,
          pages: allPages ? undefined : selected,
          docName: doc.name,
        }),
        { title },
      );
      announceOutputs(title, r.outputs);
      toast.success(t('convert.title'), t('convert.pdfDone', { count: r.outputs.length }));
      close();
    } catch (e) {
      showError(e, t('errors.opFailed', { title }));
    } finally {
      setBusy(false);
    }
  };

  const formats: { value: ImageFormat; label: string }[] = [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPG' },
    { value: 'tiff', label: 'TIFF' },
    { value: 'webp', label: 'WebP' },
  ];
  const colors: { value: ColorMode; label: string }[] = [
    { value: 'color', label: t('convert.color.color') },
    { value: 'gray', label: t('convert.color.gray') },
    { value: 'bw', label: t('convert.color.bw') },
  ];

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={t('convert.pdfTitle')}
      icon={<FileImage size={18} />}
      description={t('convert.pdfDescription', { name: doc.name })}
      size="lg"
      runLabel={t('convert.run')}
      onRun={() => void run()}
      canRun={issues.length === 0 && !busy}
      running={busy}
      advanced={
        <Checkbox
          checked={form.multiPageTiff}
          onChange={(multiPageTiff) => set({ multiPageTiff })}
          label={t('convert.multiPageTiff')}
          hint={form.format === 'tiff' ? undefined : t('convert.multiPageTiffHint')}
          disabled={form.format !== 'tiff'}
        />
      }
    >
      <Field label={t('convert.format')} htmlFor="conv-format">
        <Select<ImageFormat>
          id="conv-format"
          value={form.format}
          onChange={(format) => set({ format })}
          options={formats}
        />
      </Field>
      <div className="field__row">
        <NumberField
          id="conv-dpi"
          label={t('convert.dpi')}
          value={form.dpi}
          min={36}
          max={600}
          step={1}
          invalid={issues.includes('dpi')}
          onChange={(dpi) => set({ dpi })}
        />
        <Field label={t('convert.colorMode')} htmlFor="conv-color">
          <Select<ColorMode>
            id="conv-color"
            value={form.color}
            onChange={(color) => set({ color })}
            options={colors}
          />
        </Field>
      </div>
      {(form.format === 'jpeg' || form.format === 'webp') && (
        <NumberField
          id="conv-quality"
          label={t('convert.quality')}
          value={form.jpegQuality}
          min={1}
          max={100}
          step={1}
          invalid={issues.includes('quality')}
          onChange={(jpegQuality) => set({ jpegQuality })}
        />
      )}
      <Field
        label={t('convert.outputDir')}
        htmlFor="conv-dir"
        error={issues.includes('outputDir') ? t('convert.needFolder') : undefined}
      >
        <div className="field__row">
          <TextInput id="conv-dir" value={form.outputDir} readOnly />
          <Button onClick={() => void chooseFolder()}>{t('common.browse')}</Button>
        </div>
      </Field>
      <Field
        label={t('convert.nameTemplate')}
        htmlFor="conv-name"
        hint={t('convert.nameTemplateHint')}
        error={issues.includes('nameTemplate') ? t('convert.badName') : undefined}
      >
        <TextInput
          id="conv-name"
          value={form.nameTemplate}
          onChange={(e) => set({ nameTemplate: e.target.value })}
        />
      </Field>
      <PagesField
        id="conv-pages"
        value={pages}
        onChange={setPages}
        pageCount={pageCount}
        currentPage={current + 1}
      />
    </TaskDialog>
  );
}

/** Ảnh → PDF (M3, M4). */
export function ImagesToPdfDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [images, setImages] = useState<string[]>([]);
  const [form, setForm] = useState<ImagesToPdfForm>(DEFAULT_IMAGES_TO_PDF);
  const [busy, setBusy] = useState(false);
  const issues = imagesToPdfIssues(form, images, 'x');
  const set = (patch: Partial<ImagesToPdfForm>) => setForm((f) => ({ ...f, ...patch }));

  const add = async () => {
    const picked = await chef().files.openDialog({ multiple: true, filters: IMAGE_FILTERS });
    setImages((list) => addImages(list, picked));
  };

  const clipboard = async () => {
    try {
      const path = await chef().clipboard.readImage();
      if (path) setImages((list) => addImages(list, [path]));
      else toast.info(t('convert.clipboardEmpty'));
    } catch (e) {
      showError(e);
    }
  };

  const run = async () => {
    if (imagesToPdfIssues(form, images, 'x').length > 0) return;
    const out = await pickSavePath(defaultPdfName(images));
    if (!out) return;
    const title = t('convert.imagesJob', { name: defaultPdfName(images) });
    setBusy(true);
    try {
      const r = await runOp('convert.imagesToPdf', imagesToPdfParams(form, images, out), { title });
      announceOutputs(title, r.outputs);
      close();
    } catch (e) {
      showError(e, t('errors.opFailed', { title }));
    } finally {
      setBusy(false);
    }
  };

  const sizes: { value: PageSizeMode; label: string }[] = [
    { value: 'a4', label: 'A4' },
    { value: 'letter', label: 'Letter' },
    { value: 'fit-image', label: t('convert.pageSize.image') },
    { value: 'custom', label: t('convert.pageSize.custom') },
  ];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={t('convert.imagesTitle')}
      icon={<FileStack size={18} />}
      description={t('convert.imagesDescription')}
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
            disabled={images.length === 0 || busy}
            loading={busy}
          >
            {t('convert.run')}
          </Button>
        </>
      }
    >
      <div className="convert">
        <div className="convert__toolbar">
          <Button onClick={() => void add()}>{t('convert.addImages')}</Button>
          <Button icon={<ClipboardPaste size={15} />} onClick={() => void clipboard()}>
            {t('convert.fromClipboard')}
          </Button>
        </div>
        {images.length === 0 ? (
          <p className="convert__empty">{t('convert.noImages')}</p>
        ) : (
          <ol className="convert__list">
            {images.map((p, i) => (
              <li key={p} className="convert__item">
                <span className="convert__name" title={p}>
                  {i + 1}. {p.split(/[\\/]/).pop()}
                </span>
                <IconButton
                  size="sm"
                  label={t('common.moveUp')}
                  icon={<ArrowUp size={14} />}
                  disabled={i === 0}
                  onClick={() => setImages((l) => moveItem(l, i, i - 1))}
                />
                <IconButton
                  size="sm"
                  label={t('common.moveDown')}
                  icon={<ArrowDown size={14} />}
                  disabled={i === images.length - 1}
                  onClick={() => setImages((l) => moveItem(l, i, i + 1))}
                />
                <IconButton
                  size="sm"
                  label={t('common.remove')}
                  icon={<Trash2 size={14} />}
                  onClick={() => setImages((l) => l.filter((x) => x !== p))}
                />
              </li>
            ))}
          </ol>
        )}
        <div className="field__row">
          <Select<PageSizeMode>
            id="img-size"
            aria-label={t('convert.pageSizeLabel')}
            value={form.pageSize}
            onChange={(pageSize) => set({ pageSize })}
            options={sizes}
          />
          <Select<ImagesToPdfForm['fit']>
            id="img-fit"
            aria-label={t('convert.fitLabel')}
            value={form.fit}
            onChange={(fit) => set({ fit })}
            options={[
              { value: 'fit', label: t('convert.fit.fit') },
              { value: 'fill', label: t('convert.fit.fill') },
              { value: 'center', label: t('convert.fit.center') },
            ]}
          />
        </div>
        {form.pageSize === 'custom' && (
          <div className="field__row">
            <NumberField
              id="img-w"
              label={t('convert.widthMm')}
              value={form.customWidthMm}
              min={1}
              max={2000}
              step={1}
              invalid={issues.includes('custom')}
              onChange={(customWidthMm) => set({ customWidthMm })}
            />
            <NumberField
              id="img-h"
              label={t('convert.heightMm')}
              value={form.customHeightMm}
              min={1}
              max={2000}
              step={1}
              invalid={issues.includes('custom')}
              onChange={(customHeightMm) => set({ customHeightMm })}
            />
          </div>
        )}
        <NumberField
          id="img-margin"
          label={t('convert.marginMm')}
          value={form.marginMm}
          min={0}
          max={100}
          step={1}
          invalid={issues.includes('margin')}
          onChange={(marginMm) => set({ marginMm })}
        />
      </div>
    </Dialog>
  );
}
