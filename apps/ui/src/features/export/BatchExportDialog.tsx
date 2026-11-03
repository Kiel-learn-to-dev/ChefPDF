import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileOutput } from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Checkbox, Field, Select, TextInput } from '../../components/Form';
import { ProgressBar } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { cancelJob, runOp } from '../../lib/rpc';
import { useJobStore } from '../jobs/jobStore';
import { FORMATS, type ExportFormat } from './exportModel';

interface BatchRow {
  path: string;
  status: 'done' | 'failed' | 'skipped';
  outputPath: string | null;
  message: string | null;
  warnings: string[];
}

export function BatchExportDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [files, setFiles] = useState<string[]>([]);
  const [format, setFormat] = useState<ExportFormat>('docx');
  const [mode, setMode] = useState<'editable' | 'layout'>('editable');
  const [includeImages, setIncludeImages] = useState(true);
  const [folder, setFolder] = useState('');
  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJobStore((s) => s.jobs.find((j) => j.id === jobId));

  const addFiles = async () => {
    const picked = await chef().files.openDialog({
      multiple: true,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    setFiles((current) => [...new Set([...current, ...picked])].slice(0, 1000));
  };
  const pickFolder = async () => {
    const [picked] = await chef().files.openDialog({ directory: true });
    if (picked) setFolder(picked);
  };
  const run = async () => {
    if (!files.length || !folder) return;
    setRunning(true);
    setRows(null);
    setError(null);
    try {
      const result = await runOp(
        'export.batch',
        {
          files: files.map((path) => ({ path })),
          format,
          options: { mode, includeImages },
          output: { mode: 'folder', folder },
        },
        { title: t('documentExport.batchTitle'), onStarted: setJobId },
      );
      const data = result.data as { files?: BatchRow[] } | undefined;
      if (!Array.isArray(data?.files)) throw new Error(t('documentExport.badResult'));
      setRows(data.files);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
      setJobId(null);
    }
  };

  return (
    <Dialog
      open
      modalLock={running}
      onOpenChange={(o) => !o && !running && close()}
      title={t('documentExport.batchTitle')}
      description={t('documentExport.batchDescription')}
      icon={<FileOutput size={18} />}
      size="lg"
      footer={
        <>
          {running && job && (
            <ProgressBar
              value={job.total ? job.done / job.total : null}
              label={t('documentExport.progress')}
            />
          )}
          <DialogSpacer />
          {running ? (
            <Button
              variant="danger"
              disabled={!jobId}
              onClick={() => jobId && void cancelJob(jobId)}
            >
              {t('common.cancel')}
            </Button>
          ) : (
            <>
              <Button onClick={close}>{t('common.close')}</Button>
              <Button
                variant="primary"
                disabled={!files.length || !folder}
                onClick={() => void run()}
              >
                {t('documentExport.runBatch')}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="field__row">
        <Button disabled={running} onClick={() => void addFiles()}>
          {t('documentExport.addFiles')}
        </Button>
        <span>{t('documentExport.fileCount', { count: files.length })}</span>
      </div>
      {files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file}>
              {file}{' '}
              <button
                type="button"
                disabled={running}
                onClick={() => setFiles((list) => list.filter((p) => p !== file))}
                aria-label={t('documentExport.removeFile', { file })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Field label={t('documentExport.format')} htmlFor="batch-export-format">
        <Select<ExportFormat>
          id="batch-export-format"
          value={format}
          onChange={setFormat}
          options={FORMATS.map((value) => ({
            value,
            label: value === 'pdf' ? t('documentExport.refresh') : value.toUpperCase(),
          }))}
        />
      </Field>
      {format === 'docx' && (
        <Field label={t('documentExport.mode')} htmlFor="batch-export-mode">
          <Select<'editable' | 'layout'>
            id="batch-export-mode"
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
        disabled={running}
        label={t('documentExport.images')}
      />
      <Field label={t('documentExport.folder')} htmlFor="batch-export-folder">
        <div className="field__row">
          <TextInput id="batch-export-folder" value={folder} readOnly />
          <Button disabled={running} onClick={() => void pickFolder()}>
            {t('common.browse')}
          </Button>
        </div>
      </Field>
      {error && <p role="alert">{error}</p>}
      {rows && (
        <section aria-label={t('documentExport.results')}>
          <h3>{t('documentExport.results')}</h3>
          <ul>
            {rows.map((row, i) => (
              <li key={`${row.path}-${i}`}>
                <strong>{t(`documentExport.status.${row.status}`)}</strong> {row.path}
                {row.outputPath && (
                  <>
                    {' '}
                    → {row.outputPath}{' '}
                    <Button onClick={() => void chef().files.showInFolder(row.outputPath!)}>
                      {t('outputs.showInFolder')}
                    </Button>
                  </>
                )}
                {row.message && <div>{row.message}</div>}
                {row.warnings.map((warning, n) => (
                  <div key={n}>{warning}</div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}
