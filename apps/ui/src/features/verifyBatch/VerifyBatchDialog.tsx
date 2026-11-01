/**
 * "Kiểm tra chữ ký hàng loạt" (I36): many PDFs or one folder, one job with progress and cancel,
 * then a summary by status and a report file (CSV or Excel) that can be opened in its folder.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleCheck,
  FilePlus2,
  FolderOpen,
  FolderSearch,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Checkbox, Field, Segmented, Select, TextInput } from '../../components/Form';
import { Badge, ProgressBar } from '../../components/Misc';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { cancelJob, runOp } from '../../lib/rpc';
import { useJobStore } from '../jobs/jobStore';
import { addBatchPaths } from '../sign/batchModel';
import '../sign/sign.css';
import './verifyBatch.css';
import {
  DEFAULT_VERIFY_FORM,
  REPORT_FORMATS,
  STATUS_ORDER,
  TRUST_ROOT_FILTERS,
  countsByStatus,
  parseVerifyResult,
  verifyBatchParams,
  verifyProblem,
  withFormat,
  type ReportFormat,
  type Revocation,
  type VerifyForm,
  type VerifyResult,
  type VerifyScope,
} from './verifyBatchModel';

const PDF_FILTER = [{ name: 'PDF', extensions: ['pdf'] }];

/** i18n key of a status name; statuses the UI does not know share one label. */
function statusKey(status: string): string {
  return (STATUS_ORDER as readonly string[]).includes(status)
    ? `verifyBatch.status.${status}`
    : 'verifyBatch.status.other';
}

export function VerifyBatchDialog() {
  const close = useUi((s) => s.closeDialog);
  return <VerifyInner onClose={close} />;
}

function VerifyInner({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<VerifyForm>(DEFAULT_VERIFY_FORM);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJobStore((s) => s.jobs.find((j) => j.id === jobId));

  const patch = (p: Partial<VerifyForm>) => setForm((f) => ({ ...f, ...p }));

  const addFiles = (paths: string[]) => {
    const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
    const { rows, duplicates, overLimit } = addBatchPaths(
      form.files.map((path) => ({ path, name: path })),
      pdfs,
    );
    if (duplicates > 0) toast.info(t('verifyBatch.duplicates', { count: duplicates }));
    if (overLimit) toast.warning(t('verifyBatch.overLimit'));
    patch({ files: rows.map((r) => r.path) });
  };

  const pickFiles = async () => {
    addFiles(await chef().files.openDialog({ multiple: true, filters: PDF_FILTER }));
  };

  const pickFolder = async () => {
    const [dir] = await chef().files.openDialog({ directory: true });
    if (dir) patch({ folder: dir });
  };

  const pickTrustRoots = async () => {
    const picked = await chef().files.openDialog({
      multiple: true,
      filters: [{ name: t('verifyBatch.trustFilter'), extensions: TRUST_ROOT_FILTERS }],
    });
    const next = [...new Set([...form.trustRoots, ...picked])];
    patch({ trustRoots: next });
  };

  const pickReport = async () => {
    const path = await chef().files.saveDialog({
      defaultPath: form.reportPath ?? `kiem-tra-chu-ky.${form.format}`,
      filters: [{ name: form.format.toUpperCase(), extensions: [form.format] }],
    });
    if (path) patch({ reportPath: withFormat(path, form.format) });
  };

  const changeFormat = (format: ReportFormat) =>
    patch({ format, reportPath: withFormat(form.reportPath, format) });

  const run = async () => {
    const key = verifyProblem(form);
    if (key) return setProblem(t(`verifyBatch.problem.${key}`));
    setProblem(null);
    setRunning(true);
    setResult(null);
    try {
      const res = await runOp('sign.verifyBatch', verifyBatchParams(form), {
        title: t('verifyBatch.job'),
        onStarted: (id) => setJobId(id),
      });
      const parsed = parseVerifyResult(res.data);
      if (!parsed) throw new Error(t('verifyBatch.badResult'));
      setResult(parsed);
      toast.success(t('verifyBatch.doneTitle'), t('verifyBatch.doneText', { files: parsed.files }));
    } catch (e) {
      const c = toChefError(e);
      if (c.kind === 'CANCELLED') setProblem(t('verifyBatch.cancelled'));
      else setProblem(errorMessage(c));
    } finally {
      setRunning(false);
      setJobId(null);
    }
  };

  const canRun = !running && verifyProblem(form) === null;
  const summary = result ? countsByStatus(result.byStatus) : [];

  return (
    <Dialog
      open
      modalLock={running}
      onOpenChange={(o) => {
        if (!o && !running) onClose();
      }}
      icon={<ShieldCheck size={18} />}
      title={t('verifyBatch.title')}
      description={t('verifyBatch.description')}
      size="xl"
      footer={
        <>
          {running && job && (
            <div className="sign-row" style={{ flex: 1 }}>
              <ProgressBar
                value={job.total > 0 ? job.done / job.total : null}
                label={t('verifyBatch.progress')}
              />
            </div>
          )}
          <DialogSpacer />
          {running ? (
            <Button
              variant="danger"
              disabled={!jobId}
              onClick={() => jobId && void cancelJob(jobId)}
            >
              {t('verifyBatch.cancelJob')}
            </Button>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.close')}</Button>
              <Button variant="primary" disabled={!canRun} onClick={() => void run()}>
                {t('verifyBatch.run')}
              </Button>
            </>
          )}
        </>
      }
    >
      <section className="sign-section" aria-labelledby="verify-source-title">
        <h3 id="verify-source-title" className="sign-section__title">
          {t('verifyBatch.source')}
        </h3>
        <Segmented<VerifyScope>
          aria-label={t('verifyBatch.source')}
          value={form.scope}
          onChange={(scope) => patch({ scope })}
          options={[
            { value: 'files', label: t('verifyBatch.scopeFiles') },
            { value: 'folder', label: t('verifyBatch.scopeFolder') },
          ]}
        />

        {form.scope === 'files' ? (
          <>
            <div className="sign-row">
              <Button
                icon={<FilePlus2 size={15} />}
                disabled={running}
                onClick={() => void pickFiles()}
              >
                {t('verifyBatch.addFiles')}
              </Button>
              {form.files.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running}
                  onClick={() => patch({ files: [] })}
                >
                  {t('verifyBatch.clear')}
                </Button>
              )}
              <span className="sign-note">{t('verifyBatch.count', { n: form.files.length })}</span>
            </div>
            {form.files.length > 0 && (
              <ul className="sign-file-list">
                {form.files.map((path) => (
                  <li key={path}>
                    <span className="sign-file-list__name" title={path}>
                      {path.split(/[\\/]/).pop()}
                    </span>
                    <IconButton
                      size="sm"
                      label={t('verifyBatch.remove')}
                      icon={<Trash2 size={14} />}
                      disabled={running}
                      onClick={() => patch({ files: form.files.filter((x) => x !== path) })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="sign-row">
            <Button
              icon={<FolderOpen size={15} />}
              disabled={running}
              onClick={() => void pickFolder()}
            >
              {t('verifyBatch.pickFolder')}
            </Button>
            <span className="sign-note" title={form.folder ?? undefined}>
              {form.folder ?? t('verifyBatch.noFolder')}
            </span>
            <Checkbox
              checked={form.recursive}
              onChange={(recursive) => patch({ recursive })}
              label={t('verifyBatch.recursive')}
            />
          </div>
        )}
      </section>

      <section className="sign-section" aria-labelledby="verify-options-title">
        <h3 id="verify-options-title" className="sign-section__title">
          {t('verifyBatch.options')}
        </h3>
        <div className="sign-grid">
          <Field label={t('verifyBatch.revocation')}>
            <Select<Revocation>
              aria-label={t('verifyBatch.revocation')}
              value={form.revocation}
              options={[
                { value: 'none', label: t('verifyBatch.rev.none') },
                { value: 'soft', label: t('verifyBatch.rev.soft') },
                { value: 'hard', label: t('verifyBatch.rev.hard') },
              ]}
              onChange={(revocation) => patch({ revocation })}
            />
          </Field>
        </div>
        <p className="sign-note">{t('verifyBatch.trustDefaults')}</p>
        <div className="sign-row">
          <Button size="sm" disabled={running} onClick={() => void pickTrustRoots()}>
            {t('verifyBatch.addTrust')}
          </Button>
          {form.trustRoots.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={running}
              onClick={() => patch({ trustRoots: [] })}
            >
              {t('verifyBatch.clearTrust')}
            </Button>
          )}
          <span className="sign-note">
            {t('verifyBatch.trustCount', { n: form.trustRoots.length })}
          </span>
        </div>
      </section>

      <section className="sign-section" aria-labelledby="verify-report-title">
        <h3 id="verify-report-title" className="sign-section__title">
          {t('verifyBatch.report')}
        </h3>
        <div className="sign-grid">
          <Field label={t('verifyBatch.format')}>
            <Select<ReportFormat>
              aria-label={t('verifyBatch.format')}
              value={form.format}
              options={REPORT_FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
              onChange={changeFormat}
            />
          </Field>
          <Field label={t('verifyBatch.reportPath')}>
            <TextInput
              size="sm"
              readOnly
              value={form.reportPath ?? ''}
              placeholder={t('verifyBatch.noReport')}
            />
          </Field>
        </div>
        <div className="sign-row">
          <Button size="sm" disabled={running} onClick={() => void pickReport()}>
            {t('verifyBatch.chooseReport')}
          </Button>
        </div>
      </section>

      {problem && (
        <p className="sign-note sign-note--warn" role="alert">
          {problem}
        </p>
      )}

      {result && (
        <section className="sign-section verify-result" aria-labelledby="verify-result-title">
          <h3 id="verify-result-title" className="sign-section__title">
            <CircleCheck size={15} aria-hidden /> {t('verifyBatch.summary')}
          </h3>
          <p className="sign-note">
            {t('verifyBatch.totals', { files: result.files, signatures: result.signatures })}
          </p>
          <ul className="verify-result__counts" aria-label={t('verifyBatch.summary')}>
            {summary.map((s) => (
              <li
                key={s.status}
                className={`verify-result__count verify-result__count--${s.status}`}
              >
                <Badge>{t(statusKey(s.status))}</Badge>
                <span>{s.count}</span>
              </li>
            ))}
          </ul>
          <div className="sign-row">
            <Button
              size="sm"
              icon={<FolderSearch size={15} />}
              onClick={() => void chef().files.showInFolder(result.reportPath)}
            >
              {t('verifyBatch.openReport')}
            </Button>
          </div>
        </section>
      )}
    </Dialog>
  );
}
