/**
 * "Ký hàng loạt" (T3.13): many PDFs, one signer and one set of options, run as one job with
 * progress and cancel, then a results table with verification badges and per-file actions.
 */
import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  FilePlus2,
  FolderOpen,
  Layers,
  Trash2,
} from 'lucide-react';
import type { SignTemplateEntry, SignatureTemplate } from '@chef/contracts';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { askPassword } from '../../app/prompts';
import { errorMessage, probePdf } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Checkbox, Field, Segmented, Select, TextInput } from '../../components/Form';
import { Badge, ProgressBar } from '../../components/Misc';
import { toast } from '../../components/Toast';
import { chef, pathsForDroppedFiles } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { cancelJob, runOp } from '../../lib/rpc';
import { useJobStore } from '../jobs/jobStore';
import { boundTemplate } from '../signTemplate/templateList';
import {
  DEFAULT_ANCHOR_FORM,
  DEFAULT_FIXED_FORM,
  type AnchorForm,
  type FixedForm,
} from './anchorModel';
import {
  DEFAULT_SUFFIX,
  addBatchPaths,
  batchErrorKey,
  retryPaths,
  suffixOutputName,
  suffixProblem,
  summarize,
  verificationTone,
  type BatchItem,
  type BatchRow,
} from './batchModel';
import {
  batchProblem,
  buildBatchParams,
  type BatchForm,
  type BatchPlacement,
  type OutputMode,
} from './batchParams';
import { materializeTemplate, type MaterializedTemplate } from './signActions';
import { SignerSection, type SignerHandle, type SignerReady } from './SignerSection';
import type { CertifyMode, DigestName, SignLevel } from './signRequest';
import { cleanTsaUrls } from './tsa';
import './sign.css';

const LEVELS: readonly SignLevel[] = ['B-B', 'B-T', 'B-LT', 'B-LTA'];

interface BatchData {
  results: BatchItem[];
  signed: number;
  failed: number;
  skipped: number;
  openFolder: string | null;
  stoppedBy: string | null;
}

export function BatchSignDialog() {
  const close = useUi((s) => s.closeDialog);
  return <BatchInner onClose={close} />;
}

function BatchInner({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const templates = useSettings((s) => s.settings.signTemplates);
  const tsaSettings = useSettings((s) => s.settings.tsaUrls);
  const signerRef = useRef<SignerHandle>(null);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [ready, setReady] = useState<SignerReady>({
    choice: null,
    fingerprint: null,
    finalTry: false,
    label: '',
  });
  const [templateId, setTemplateId] = useState<string | null | undefined>(undefined);
  const [level, setLevel] = useState<SignLevel>('B-B');
  const [digest, setDigest] = useState<DigestName>('sha256');
  const [certify, setCertify] = useState<CertifyMode>('none');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [placementMode, setPlacementMode] = useState<BatchPlacement['mode']>('invisible');
  const [anchorForm, setAnchorForm] = useState<AnchorForm>(DEFAULT_ANCHOR_FORM);
  const [fixedForm, setFixedForm] = useState<FixedForm>(DEFAULT_FIXED_FORM);
  const [rect, setRect] = useState({ page: 1, x1: 50, y1: 50, x2: 250, y2: 100 });
  const [outputMode, setOutputMode] = useState<OutputMode>('suffix');
  const [suffix, setSuffix] = useState(DEFAULT_SUFFIX);
  const [folder, setFolder] = useState<string | null>(null);
  const [overwriteOk, setOverwriteOk] = useState(false);
  const [stopOnError, setStopOnError] = useState(false);
  const [verifyAfter, setVerifyAfter] = useState(true);
  const [results, setResults] = useState<BatchItem[] | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const job = useJobStore((s) => s.jobs.find((j) => j.id === jobId));

  const bound = boundTemplate(templates, ready.fingerprint);
  const chosenTemplate = templateId === undefined ? (bound?.id ?? null) : templateId;
  const tsa = cleanTsaUrls(tsaSettings).urls;

  // ---------- files ----------

  /** Adds paths; encrypted files get their password asked now (one prompt per file). */
  async function addPaths(paths: string[]) {
    const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
    const { rows: next, duplicates, overLimit } = addBatchPaths(rows, pdfs);
    const fresh = next.slice(rows.length);
    if (duplicates > 0) toast.info(t('signBatch.duplicates', { count: duplicates }));
    if (overLimit) toast.warning(t('signBatch.overLimit'));
    setRows(next);
    const kept = new Map<string, string | undefined>();
    for (const r of fresh) {
      try {
        const probed = await probePdf(r.path);
        if (probed === null) kept.set(r.path, undefined);
        else kept.set(r.path, probed.password);
      } catch (e) {
        toast.error(t('signBatch.probeFailed', { name: r.name }), errorMessage(e));
        kept.set(r.path, undefined);
      }
    }
    // Files the user cancelled at the password prompt are not added.
    setRows((cur) =>
      cur.flatMap((r) => {
        if (!fresh.some((f) => f.path === r.path)) return [r];
        if (!kept.has(r.path)) return [r];
        const pw = kept.get(r.path);
        return [{ ...r, ...(pw ? { password: pw } : {}) }];
      }),
    );
  }

  const pickFiles = async () => {
    const picked = await chef().files.openDialog({
      multiple: true,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    await addPaths(picked);
  };

  const pickFolder = async () => {
    const [dir] = await chef().files.openDialog({ directory: true });
    if (!dir) return;
    try {
      await addPaths(await chef().files.listPdfs(dir));
    } catch (e) {
      setProblem(errorMessage(e));
    }
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const paths = await pathsForDroppedFiles(files);
    await addPaths(paths);
  };

  // ---------- run ----------

  function formNow(): BatchForm | null {
    if (!ready.choice) return null;
    const placement: BatchPlacement =
      placementMode === 'anchor'
        ? { mode: 'anchor', form: anchorForm }
        : placementMode === 'fixed'
          ? { mode: 'fixed', form: fixedForm }
          : placementMode === 'rect'
            ? { mode: 'rect', page: rect.page - 1, rect: [rect.x1, rect.y1, rect.x2, rect.y2] }
            : { mode: 'invisible' };
    return {
      signer: ready.choice,
      level,
      digest,
      tsaUrls: tsa,
      reason,
      location,
      contact,
      certify,
      placement,
      outputMode,
      suffix,
      folder,
      stopOnError,
      verifyAfter,
      overwriteConfirmed: overwriteOk,
    };
  }

  async function run(toRun: BatchRow[]) {
    const form = formNow();
    if (!form) return setProblem(t('signBatch.noSigner'));
    const problemKey = batchProblem(toRun, form);
    if (problemKey) return setProblem(t(`signBatch.problem.${problemKey}`));
    const err = outputMode === 'suffix' ? suffixProblem(suffix) : null;
    if (err) return setProblem(t(`signBatch.suffix.${err}`));

    let materialized: MaterializedTemplate | null = null;
    setProblem(null);
    setRunning(true);
    try {
      const entry: SignTemplateEntry | undefined = templates.find((x) => x.id === chosenTemplate);
      if (entry) materialized = await materializeTemplate(entry);
      const params = buildBatchParams(toRun, {
        ...form,
        ...(materialized ? { template: materialized.template as SignatureTemplate } : {}),
      });
      const result = await runOp('sign.batch', params, {
        title: t('signBatch.job'),
        onStarted: (id) => setJobId(id),
      });
      const data = result.data as BatchData;
      setResults((prev) => mergeResults(prev, data.results));
      setOpenFolder(data.openFolder);
      signerRef.current?.clearSecrets();
      const s = summarize(data.results);
      toast.success(t('signBatch.doneTitle'), t('signBatch.summary', { ...s }));
    } catch (e) {
      const c = toChefError(e);
      if (c.kind === 'CANCELLED') setProblem(t('signBatch.cancelled'));
      else setProblem(errorMessage(c));
      signerRef.current?.clearSecrets();
    } finally {
      setRunning(false);
      setJobId(null);
      await materialized?.release();
    }
  }

  /** Failed files again: a file that needs its password is asked first. */
  async function retry() {
    if (!results) return;
    const failed = new Set(retryPaths(results));
    const toRun: BatchRow[] = [];
    for (const r of rows.filter((x) => failed.has(x.path))) {
      const item = results.find((x) => x.path === r.path);
      if (item?.errorKind === 'PASSWORD_REQUIRED' || item?.errorKind === 'PASSWORD_INVALID') {
        const answer = await askPassword(r.name, item.errorKind === 'PASSWORD_INVALID');
        if (answer === null) continue;
        toRun.push({ ...r, password: answer });
      } else {
        toRun.push(r);
      }
    }
    if (toRun.length === 0) return;
    await run(toRun);
  }

  const summary = results ? summarize(results) : null;
  const canRun = !running && rows.length > 0 && !!ready.choice;

  return (
    <Dialog
      open
      modalLock={running}
      onOpenChange={(o) => {
        if (!o && !running) onClose();
      }}
      icon={<Layers size={18} />}
      title={t('signBatch.title')}
      description={t('signBatch.description')}
      size="xl"
      footer={
        <>
          {running && job && (
            <div className="sign-row" style={{ flex: 1 }}>
              <ProgressBar
                value={job.total > 0 ? job.done / job.total : null}
                label={t('signBatch.progress')}
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
              {t('signBatch.cancelJob')}
            </Button>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.close')}</Button>
              {results && retryPaths(results).length > 0 && (
                <Button onClick={() => void retry()}>{t('signBatch.retry')}</Button>
              )}
              <Button variant="primary" disabled={!canRun} onClick={() => void run(rows)}>
                {t('signBatch.run', { count: rows.length })}
              </Button>
            </>
          )}
        </>
      }
    >
      <section className="sign-section" aria-labelledby="batch-files-title">
        <h3 id="batch-files-title" className="sign-section__title">
          {t('signBatch.files')}
        </h3>
        <div className="sign-row">
          <Button
            icon={<FilePlus2 size={15} />}
            onClick={() => void pickFiles()}
            disabled={running}
          >
            {t('signBatch.addFiles')}
          </Button>
          <Button
            icon={<FolderOpen size={15} />}
            onClick={() => void pickFolder()}
            disabled={running}
          >
            {t('signBatch.addFolder')}
          </Button>
          {rows.length > 0 && (
            <Button variant="ghost" onClick={() => setRows([])} disabled={running}>
              {t('signBatch.clear')}
            </Button>
          )}
          <span className="sign-note">{t('signBatch.count', { count: rows.length })}</span>
        </div>
        <div
          className={`sign-drop${dragOver ? ' is-over' : ''}`}
          role="region"
          aria-label={t('signBatch.dropHint')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onDrop(e)}
        >
          {rows.length === 0 ? (
            <p className="sign-note">{t('signBatch.dropHint')}</p>
          ) : (
            <ul className="sign-file-list">
              {rows.map((r) => (
                <li key={r.path}>
                  <span className="sign-file-list__name" title={r.path}>
                    {r.name}
                  </span>
                  {r.password && <Badge>{t('signBatch.hasPassword')}</Badge>}
                  <IconButton
                    label={t('signBatch.remove')}
                    icon={<Trash2 size={14} />}
                    disabled={running}
                    onClick={() => setRows((cur) => cur.filter((x) => x.path !== r.path))}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="sign-section" aria-labelledby="batch-signer-title">
        <SignerSection ref={signerRef} onReady={setReady} onProblem={setProblem} />
      </section>

      <section className="sign-section" aria-labelledby="batch-options-title">
        <h3 id="batch-options-title" className="sign-section__title">
          {t('signBatch.options')}
        </h3>
        <div className="sign-grid">
          <Field label={t('sign.template.title')}>
            <Select
              aria-label={t('sign.template.title')}
              value={chosenTemplate ?? ''}
              options={[
                { value: '', label: t('sign.template.none') },
                ...templates.map((e) => ({ value: e.id, label: e.name })),
              ]}
              onChange={(v) => setTemplateId(v || null)}
            />
          </Field>
          <Field label={t('sign.level.title')}>
            <Select
              aria-label={t('sign.level.title')}
              value={level}
              options={LEVELS.map((lv) => ({ value: lv, label: lv }))}
              onChange={(v) => setLevel(v)}
            />
          </Field>
          <Field label={t('sign.level.digest')}>
            <Select
              aria-label={t('sign.level.digest')}
              value={digest}
              options={[
                { value: 'sha256', label: 'SHA-256' },
                { value: 'sha384', label: 'SHA-384' },
                { value: 'sha512', label: 'SHA-512' },
              ]}
              onChange={(v) => setDigest(v)}
            />
          </Field>
          <Field label={t('sign.certify.title')}>
            <Select
              aria-label={t('sign.certify.title')}
              value={certify}
              options={[
                { value: 'none', label: t('sign.certify.none') },
                { value: 'no-changes', label: t('sign.certify.noChanges') },
                { value: 'form-fill', label: t('sign.certify.formFill') },
                { value: 'annotate', label: t('sign.certify.annotate') },
              ]}
              onChange={(v) => setCertify(v)}
            />
          </Field>
          <Field label={t('sign.level.reason')}>
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label={t('sign.level.location')}>
            <TextInput value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label={t('sign.level.contact')}>
            <TextInput value={contact} onChange={(e) => setContact(e.target.value)} />
          </Field>
        </div>
        {level !== 'B-B' && tsa.length === 0 && (
          <p className="sign-note sign-note--warn">{t('sign.level.needTsa')}</p>
        )}
        {certify !== 'none' && (
          <p className="sign-note sign-note--warn">{t('sign.certify.warning')}</p>
        )}
      </section>

      <section className="sign-section" aria-labelledby="batch-place-title">
        <h3 id="batch-place-title" className="sign-section__title">
          {t('sign.place.sectionTitle')}
        </h3>
        <Segmented<BatchPlacement['mode']>
          aria-label={t('sign.place.sectionTitle')}
          value={placementMode}
          onChange={setPlacementMode}
          options={(['invisible', 'anchor', 'fixed', 'rect'] as const).map((m) => ({
            value: m,
            label: t(`signBatch.place.${m}`),
          }))}
        />
        {placementMode === 'anchor' && (
          <div className="sign-grid">
            <Field label={t('sign.anchor.text')}>
              <TextInput
                value={anchorForm.text}
                placeholder={t('sign.anchor.placeholder')}
                onChange={(e) => setAnchorForm({ ...anchorForm, text: e.target.value })}
              />
            </Field>
            <Field label={t('sign.anchor.position')}>
              <Select
                aria-label={t('sign.anchor.position')}
                value={anchorForm.position}
                options={(['below', 'above', 'left', 'right', 'over'] as const).map((p) => ({
                  value: p,
                  label: t(`sign.anchor.pos.${p}`),
                }))}
                onChange={(v) => setAnchorForm({ ...anchorForm, position: v })}
              />
            </Field>
            <Field label={t('sign.anchor.which')}>
              <Select
                aria-label={t('sign.anchor.which')}
                value={anchorForm.whichMatch}
                options={[
                  { value: 'first', label: t('sign.anchor.w.first') },
                  { value: 'last', label: t('sign.anchor.w.last') },
                  { value: 'all', label: t('sign.anchor.w.all') },
                ]}
                onChange={(v) => setAnchorForm({ ...anchorForm, whichMatch: v })}
              />
            </Field>
            <Field label={t('sign.anchor.onMissing')}>
              <Select
                aria-label={t('sign.anchor.onMissing')}
                value={anchorForm.onMissing}
                options={[
                  { value: 'skip', label: t('sign.anchor.m.skip') },
                  { value: 'fail', label: t('sign.anchor.m.fail') },
                  { value: 'fallback-fixed', label: t('sign.anchor.m.fallback') },
                ]}
                onChange={(v) => setAnchorForm({ ...anchorForm, onMissing: v })}
              />
            </Field>
            <Field label={t('sign.anchor.widthMm')}>
              <TextInput
                type="number"
                value={anchorForm.widthMm}
                onChange={(e) => setAnchorForm({ ...anchorForm, widthMm: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('sign.anchor.heightMm')}>
              <TextInput
                type="number"
                value={anchorForm.heightMm}
                onChange={(e) => setAnchorForm({ ...anchorForm, heightMm: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
        {placementMode === 'fixed' && (
          <div className="sign-grid">
            <Field label={t('sign.fixed.corner')}>
              <Select
                aria-label={t('sign.fixed.corner')}
                value={fixedForm.corner}
                options={(['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const).map(
                  (c) => ({
                    value: c,
                    label: t(`sign.fixed.c.${c}`),
                  }),
                )}
                onChange={(v) => setFixedForm({ ...fixedForm, corner: v })}
              />
            </Field>
            <Field label={t('sign.fixed.page')}>
              <Select
                aria-label={t('sign.fixed.page')}
                value={fixedForm.page === 'first' ? 'first' : 'last'}
                options={[
                  { value: 'first', label: t('sign.fixed.p.first') },
                  { value: 'last', label: t('sign.fixed.p.last') },
                ]}
                onChange={(v) =>
                  setFixedForm({ ...fixedForm, page: v === 'first' ? 'first' : 'last' })
                }
              />
            </Field>
            <Field label={t('sign.anchor.widthMm')}>
              <TextInput
                type="number"
                value={fixedForm.widthMm}
                onChange={(e) => setFixedForm({ ...fixedForm, widthMm: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('sign.anchor.heightMm')}>
              <TextInput
                type="number"
                value={fixedForm.heightMm}
                onChange={(e) => setFixedForm({ ...fixedForm, heightMm: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('sign.fixed.margin')}>
              <TextInput
                type="number"
                value={fixedForm.marginPt}
                onChange={(e) => setFixedForm({ ...fixedForm, marginPt: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
        {placementMode === 'rect' && (
          <div className="sign-grid">
            <Field label={t('signBatch.rect.page')}>
              <TextInput
                type="number"
                min={1}
                value={rect.page}
                onChange={(e) => setRect({ ...rect, page: Number(e.target.value) })}
              />
            </Field>
            {(['x1', 'y1', 'x2', 'y2'] as const).map((k) => (
              <Field key={k} label={t(`signBatch.rect.${k}`)}>
                <TextInput
                  type="number"
                  value={rect[k]}
                  onChange={(e) => setRect({ ...rect, [k]: Number(e.target.value) })}
                />
              </Field>
            ))}
          </div>
        )}
        {placementMode === 'rect' && <p className="sign-note">{t('signBatch.rect.note')}</p>}
      </section>

      <section className="sign-section" aria-labelledby="batch-output-title">
        <h3 id="batch-output-title" className="sign-section__title">
          {t('signBatch.output')}
        </h3>
        <Segmented<OutputMode>
          aria-label={t('signBatch.output')}
          value={outputMode}
          onChange={setOutputMode}
          options={[
            { value: 'suffix', label: t('signBatch.out.suffix') },
            { value: 'folder', label: t('signBatch.out.folder') },
            { value: 'overwrite', label: t('signBatch.out.overwrite') },
          ]}
        />
        {outputMode === 'suffix' && (
          <div className="sign-row">
            <Field label={t('signBatch.out.suffixLabel')}>
              <TextInput value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            </Field>
            {rows[0] && (
              <span className="sign-note">
                {t('signBatch.out.example', {
                  name: suffixOutputName(rows[0].path, suffix || DEFAULT_SUFFIX),
                })}
              </span>
            )}
          </div>
        )}
        {outputMode === 'folder' && (
          <div className="sign-row">
            <Button
              icon={<FolderOpen size={15} />}
              onClick={() =>
                void chef()
                  .files.openDialog({ directory: true })
                  .then((p) => p[0] && setFolder(p[0]))
              }
            >
              {t('signBatch.out.pickFolder')}
            </Button>
            <span className="sign-note">{folder ?? t('signBatch.out.noFolder')}</span>
          </div>
        )}
        {outputMode === 'overwrite' && (
          <>
            <p className="sign-note sign-note--danger" role="alert">
              <CircleAlert size={14} aria-hidden /> {t('signBatch.out.overwriteWarning')}
            </p>
            <Checkbox
              checked={overwriteOk}
              onChange={setOverwriteOk}
              label={t('signBatch.out.overwriteConfirm')}
            />
          </>
        )}
        <div className="sign-row">
          <Checkbox
            checked={stopOnError}
            onChange={setStopOnError}
            label={t('signBatch.stopOnError')}
          />
          <Checkbox
            checked={verifyAfter}
            onChange={setVerifyAfter}
            label={t('signBatch.verifyAfter')}
          />
        </div>
      </section>

      {problem && (
        <p className="sign-note sign-note--danger" role="alert">
          {problem}
        </p>
      )}

      {results && summary && (
        <section className="sign-section" aria-labelledby="batch-results-title">
          <h3 id="batch-results-title" className="sign-section__title">
            {t('signBatch.results')}
          </h3>
          <p className="sign-note" data-testid="batch-summary">
            {t('signBatch.summary', { ...summary })}
          </p>
          {openFolder && (
            <div className="sign-row">
              <Button
                icon={<FolderOpen size={14} />}
                onClick={() => void chef().files.showInFolder(openFolder)}
              >
                {t('signBatch.openFolder')}
              </Button>
            </div>
          )}
          <div className="sign-results__scroll">
            <table className="sign-results" data-testid="batch-results">
              <thead>
                <tr>
                  <th>{t('signBatch.col.status')}</th>
                  <th>{t('signBatch.col.file')}</th>
                  <th>{t('signBatch.col.check')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {results.map((item) => (
                  <ResultRow key={item.path} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Dialog>
  );
}

/** Results of a retry replace the failed rows; the rest keep their result. */
function mergeResults(prev: BatchItem[] | null, next: BatchItem[]): BatchItem[] {
  if (!prev) return next;
  const byPath = new Map(next.map((r) => [r.path, r]));
  const merged = prev.map((r) => byPath.get(r.path) ?? r);
  for (const r of next) if (!prev.some((p) => p.path === r.path)) merged.push(r);
  return merged;
}

function ResultRow({ item }: { item: BatchItem }) {
  const { t } = useTranslation();
  const tone = verificationTone(item.verification);
  const Icon =
    item.status === 'signed' ? CircleCheck : item.status === 'failed' ? CircleX : CircleMinus;
  const iconClass =
    item.status === 'signed'
      ? 'sign-badge-ok'
      : item.status === 'failed'
        ? 'sign-results__err'
        : 'sign-note';
  const name = item.path.split(/[/\\]/).pop() ?? item.path;
  return (
    <tr data-status={item.status}>
      <td>
        <span className={iconClass}>
          <Icon size={15} aria-hidden />
        </span>{' '}
        {t(`signBatch.status.${item.status}`)}
      </td>
      <td title={item.path}>{name}</td>
      <td>
        {item.status === 'signed' && item.verification ? (
          <span className={`sign-badge-${tone === 'none' ? 'warn' : tone}`}>
            {t(`signBatch.verify.${item.verification.status}`)}
          </span>
        ) : item.status === 'signed' ? (
          <span className="sign-note">{t('signBatch.verify.none')}</span>
        ) : (
          <span className="sign-results__err">
            {item.status === 'skipped'
              ? t('signBatch.skippedNote')
              : t(batchErrorKey(item.errorKind))}
          </span>
        )}
      </td>
      <td>
        {item.status === 'signed' && item.outputPath && (
          <Button variant="ghost" onClick={() => void chef().files.showInFolder(item.outputPath!)}>
            {t('signBatch.showFile')}
          </Button>
        )}
      </td>
    </tr>
  );
}

export function openBatchSignFlow(): void {
  useUi.getState().openDialog('batchSign');
}
