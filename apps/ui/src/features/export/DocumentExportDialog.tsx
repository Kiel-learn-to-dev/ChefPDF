import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileOutput } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { dirname, join } from '../../lib/path';
import { runOp } from '../../lib/rpc';
import { PagesField, useCurrentPage } from '../overlay/OverlayControls';
import { selectedPages, type PagesSel } from '../overlay/overlayModel';
import { exportParams, FORMATS, outputName, type ExportFormat } from './exportModel';

export function DocumentExportDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const open = useUi((s) => s.openDialog);
  const dialogData = useUi((s) => s.dialogData) as
    { modelPath?: string; docId?: string; revisionPath?: string } | undefined;
  const current = useCurrentPage(doc?.id);
  const [format, setFormat] = useState<ExportFormat>('docx');
  const [mode, setMode] = useState<'editable' | 'layout'>('editable');
  const [includeImages, setIncludeImages] = useState(true);
  const [pages, setPages] = useState<PagesSel>({ choice: 'all', range: '' });
  const [busy, setBusy] = useState(false);
  if (!doc) return null;
  const reviewedPath =
    dialogData?.docId === doc.id && dialogData.revisionPath === doc.state.revisionPath
      ? dialogData.modelPath
      : undefined;
  const selected = selectedPages(pages, current, doc.info.pageCount);

  const run = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const name = outputName(doc.name, format);
      const dir = doc.state.sourcePath ? dirname(doc.state.sourcePath) : '';
      const outputPath = await chef().files.saveDialog({
        defaultPath: dir ? join(dir, name) : name,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!outputPath) return;
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      if (
        [doc.state.sourcePath, doc.state.revisionPath].some(
          (path) => path && normalize(outputPath) === normalize(path),
        )
      ) {
        toast.warning(t('documentExport.title'), t('documentExport.sameFile'));
        return;
      }
      const options = { sessionId: doc.id, title: t('documentExport.title') };
      const result =
        format === 'pdf'
          ? await runOp(
              'export.refresh',
              {
                outputPath,
                replaceExisting: true,
                pages: selected,
                options: { includeImages },
                ...(reviewedPath ? { modelPath: reviewedPath } : {}),
              },
              options,
            )
          : await runOp(
              'export.document',
              {
                ...exportParams(format, outputPath, selected, mode, includeImages),
                ...(reviewedPath ? { modelPath: reviewedPath } : {}),
              },
              options,
            );
      if (result.warnings?.length)
        toast.warning(t('documentExport.title'), result.warnings.join('\n'));
      toast.success(t('documentExport.done'), outputPath, [
        {
          label: t('outputs.showInFolder'),
          onClick: () => void chef().files.showInFolder(outputPath),
        },
      ]);
      close();
    } catch (e) {
      showError(e, t('documentExport.title'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('documentExport.title')}
      icon={<FileOutput size={18} />}
      description={t('documentExport.description')}
      onRun={() => void run()}
      canRun={selected.length > 0 && !busy}
      running={busy}
      runLabel={t('documentExport.run')}
      workflowStep={{
        op: 'export.document',
        params: { format, options: { mode, includeImages } } as unknown as Record<string, unknown>,
        label: t('documentExport.title'),
      }}
    >
      <Field label={t('documentExport.format')} htmlFor="document-export-format">
        <Select<ExportFormat>
          id="document-export-format"
          value={format}
          onChange={setFormat}
          options={FORMATS.map((value) => ({
            value,
            label: value === 'pdf' ? t('documentExport.refresh') : value.toUpperCase(),
          }))}
        />
      </Field>
      {format === 'docx' && (
        <Field label={t('documentExport.mode')} htmlFor="document-export-mode">
          <Select<'editable' | 'layout'>
            id="document-export-mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'editable', label: t('documentExport.editable') },
              { value: 'layout', label: t('documentExport.layout') },
            ]}
          />
        </Field>
      )}
      <Checkbox
        checked={includeImages}
        onChange={setIncludeImages}
        label={t('documentExport.images')}
      />
      <p>{reviewedPath ? t('layoutReview.usingReviewed') : t('layoutReview.notReviewed')}</p>
      <Button onClick={() => open('layoutReview')}>{t('layoutReview.title')}</Button>
      <PagesField
        id="document-export-pages"
        value={pages}
        onChange={setPages}
        pageCount={doc.info.pageCount}
        currentPage={current + 1}
      />
    </TaskDialog>
  );
}
