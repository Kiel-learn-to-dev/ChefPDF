/**
 * Bates numbering (F9): one running code over many PDFs, in list order. It does not need an open
 * document: the core runs it as a standalone job (overlay.bates). The results table shows each
 * file's first and last number and its status.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, FilePlus, FolderOpen, Hash, ScanLine, X } from 'lucide-react';
import { useJobStore, jobProgress } from '../jobs/jobStore';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Select, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { basename } from '../../lib/path';
import { chef } from '../../lib/bridge';
import { cancelJob, runOp } from '../../lib/rpc';
import { pickFolder, showError } from '../../app/actions';
import { useUi } from '../../app/state/ui';
import { pickPdfs, prefsOf, savePrefs } from './overlayActions';
import { NumberField } from './OverlayControls';
import {
  BATES_POSITIONS,
  DEFAULT_BATES_FORM,
  batesCode,
  batesParams,
  checkBates,
  readBatesRows,
  type BatesForm,
  type BatesPosition,
  type BatesRow,
} from './overlayModel';
import { useDraft } from './overlayState';
import { i18n } from '../../i18n';
import './overlay.css';

type OutputMode = BatesForm['outputMode'];
const ENUMS = { position: BATES_POSITIONS, outputMode: ['suffix', 'folder', 'overwrite'] };

/** Numbering run as a job; the rows of the result once it is done. */
export function BatesDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useDraft<BatesForm>('bates', () =>
    // Files are never kept between sessions: only the choices are.
    ({ ...prefsOf('bates', DEFAULT_BATES_FORM, ENUMS), files: [] }),
  );
  const [jobId, setJobId] = useState<string | null>(null);
  const [rows, setRows] = useState<BatesRow[] | null>(null);
  const [outputs, setOutputs] = useState<string[]>([]);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));

  const set = (patch: Partial<BatesForm>) => setForm((f) => ({ ...f, ...patch }));
  const check = checkBates(form);
  const first = batesCode(form, form.startNumber);

  const addFiles = async () => {
    try {
      const picked = await pickPdfs(true);
      if (picked.length === 0) return;
      setForm((f) => ({
        ...f,
        files: [...f.files, ...picked.filter((p) => !f.files.includes(p))],
      }));
    } catch (e) {
      showError(e);
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    setForm((f) => {
      const next = [...f.files];
      const to = index + dir;
      if (to < 0 || to >= next.length) return f;
      [next[index], next[to]] = [next[to]!, next[index]!];
      return { ...f, files: next };
    });
  };

  const chooseFolder = async () => {
    const dir = await pickFolder();
    if (dir) set({ folder: dir, outputMode: 'folder' });
  };

  const run = async () => {
    const title = i18n.t('overlay.bates.job', { count: form.files.length });
    savePrefs('bates', { ...form, files: [] });
    try {
      const r = await runOp('overlay.bates', batesParams(form), {
        title,
        onStarted: setJobId,
      });
      setRows(readBatesRows(r.data));
      setOutputs(r.outputs);
    } catch (e) {
      showError(e, t('overlay.bates.failed'));
    } finally {
      setJobId(null);
    }
  };

  const doneRows = rows;
  if (doneRows) {
    const done = doneRows.filter((r) => r.status === 'done');
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && close()}
        icon={<Hash size={18} />}
        title={t('overlay.bates.doneTitle')}
        description={t('overlay.bates.doneText', { done: done.length, total: doneRows.length })}
        size="lg"
        footer={
          <>
            {outputs.length > 0 && (
              <Button
                icon={<FolderOpen size={15} />}
                onClick={() => void chef().files.showInFolder(outputs[0]!)}
              >
                {t('overlay.bates.openFolder')}
              </Button>
            )}
            <DialogSpacer />
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        <ResultTable rows={doneRows} />
      </Dialog>
    );
  }

  const warnings: string[] = [];
  if (form.outputMode === 'overwrite') warnings.push(t('overlay.bates.overwriteWarning'));
  if (!check.ok) warnings.push(t(`overlay.bates.err.${check.field}`));

  const progress = job ? jobProgress(job) : null;

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.bates.title')}
      icon={<ScanLine size={18} />}
      description={t('overlay.bates.description')}
      size="lg"
      runLabel={t('overlay.bates.run')}
      onRun={() => void run()}
      canRun={check.ok}
      running={!!jobId}
      progress={progress}
      onCancelRun={jobId ? () => void cancelJob(jobId) : undefined}
      warnings={warnings}
      estimate={
        <span data-testid="bates-preview">
          {t('overlay.bates.preview', {
            first,
            last: batesCode(form, form.startNumber + Math.max(0, form.files.length - 1)),
          })}
        </span>
      }
    >
      <div className="ov-files">
        <div className="field__label">{t('overlay.bates.files')}</div>
        {form.files.length === 0 && <div className="field__hint">{t('task.noFiles')}</div>}
        <ol className="ov-files__list" aria-label={t('overlay.bates.files')}>
          {form.files.map((f, i) => (
            <li key={f} data-testid="bates-file">
              <span className="ov-files__index">{i + 1}</span>
              <span className="ov-files__name" title={f}>
                {basename(f)}
              </span>
              <IconButton
                label={t('common.moveUp')}
                icon={<ArrowUp size={14} />}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              />
              <IconButton
                label={t('common.moveDown')}
                icon={<ArrowDown size={14} />}
                disabled={i === form.files.length - 1}
                onClick={() => move(i, 1)}
              />
              <IconButton
                label={t('common.remove')}
                icon={<X size={14} />}
                onClick={() => set({ files: form.files.filter((x) => x !== f) })}
              />
            </li>
          ))}
        </ol>
        <Button icon={<FilePlus size={14} />} onClick={() => void addFiles()}>
          {t('overlay.bates.addFiles')}
        </Button>
      </div>
      <div className="ov-row">
        <Field label={t('overlay.bates.prefix')} htmlFor="ov-bates-prefix">
          <TextInput
            id="ov-bates-prefix"
            value={form.prefix}
            onChange={(e) => set({ prefix: e.target.value })}
          />
        </Field>
        <Field label={t('overlay.bates.suffix')} htmlFor="ov-bates-suffix">
          <TextInput
            id="ov-bates-suffix"
            value={form.suffix}
            onChange={(e) => set({ suffix: e.target.value })}
          />
        </Field>
        <NumberField
          id="ov-bates-start"
          label={t('overlay.bates.start')}
          value={form.startNumber}
          min={0}
          step={1}
          invalid={!check.ok && check.field === 'start'}
          onChange={(startNumber) => set({ startNumber })}
        />
        <NumberField
          id="ov-bates-digits"
          label={t('overlay.bates.digits')}
          value={form.digits}
          min={1}
          max={12}
          step={1}
          invalid={!check.ok && check.field === 'digits'}
          onChange={(digits) => set({ digits })}
        />
      </div>
      <div className="ov-row">
        <Field label={t('overlay.bates.position')} htmlFor="ov-bates-position">
          <Select<BatesPosition>
            id="ov-bates-position"
            value={form.position}
            onChange={(position) => set({ position })}
            options={BATES_POSITIONS.map((p) => ({ value: p, label: t(`overlay.numberPos.${p}`) }))}
            aria-label={t('overlay.bates.position')}
          />
        </Field>
        <NumberField
          id="ov-bates-size"
          label={t('overlay.look.fontSize')}
          value={form.fontSize}
          min={1}
          max={72}
          step={0.5}
          onChange={(fontSize) => set({ fontSize })}
        />
      </div>
      <Field label={t('overlay.bates.output')}>
        <RadioGroup<OutputMode>
          aria-label={t('overlay.bates.output')}
          value={form.outputMode}
          onChange={(outputMode) => set({ outputMode })}
          options={[
            { value: 'suffix', label: t('overlay.bates.outSuffix') },
            { value: 'folder', label: t('overlay.bates.outFolder') },
            { value: 'overwrite', label: t('overlay.bates.outOverwrite') },
          ]}
        />
      </Field>
      {form.outputMode === 'suffix' && (
        <Field label={t('overlay.bates.outSuffixLabel')} htmlFor="ov-bates-outsuffix">
          <TextInput
            id="ov-bates-outsuffix"
            value={form.outputSuffix}
            onChange={(e) => set({ outputSuffix: e.target.value })}
          />
        </Field>
      )}
      {form.outputMode === 'folder' && (
        <Field
          label={t('overlay.bates.folder')}
          htmlFor="ov-bates-folder"
          error={!check.ok && check.field === 'folder' ? t('overlay.bates.err.folder') : undefined}
        >
          <div className="field__row">
            <TextInput
              id="ov-bates-folder"
              readOnly
              value={form.folder}
              placeholder={t('overlay.bates.noFolder')}
            />
            <Button onClick={() => void chooseFolder()}>{t('common.browse')}</Button>
          </div>
        </Field>
      )}
      <Checkbox
        checked={form.stopOnError}
        onChange={(stopOnError) => set({ stopOnError })}
        label={t('overlay.bates.stopOnError')}
      />
    </TaskDialog>
  );
}

/** Per-file results: status, first and last number, pages, and the message for failed files. */
function ResultTable({ rows }: { rows: BatesRow[] }) {
  const { t } = useTranslation();
  return (
    <table className="ov-results" data-testid="bates-results">
      <thead>
        <tr>
          <th>{t('overlay.bates.col.file')}</th>
          <th>{t('overlay.bates.col.status')}</th>
          <th>{t('overlay.bates.col.first')}</th>
          <th>{t('overlay.bates.col.last')}</th>
          <th>{t('overlay.bates.col.pages')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.path} data-status={r.status}>
            <td title={r.path}>{basename(r.path)}</td>
            <td>
              {t(`overlay.bates.status.${r.status}`)}
              {r.message && <span className="ov-results__msg"> — {r.message}</span>}
            </td>
            <td>{r.firstNumber ?? '–'}</td>
            <td>{r.lastNumber ?? '–'}</td>
            <td>{r.pages ?? '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
