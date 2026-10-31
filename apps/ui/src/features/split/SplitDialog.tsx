import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, FolderOpen, Split } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useActiveDoc } from '../../app/state/documents';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { PDF_FILTERS, pickFolder, showError } from '../../app/actions';
import { TaskDialog, type ApplyTo } from '../../components/TaskDialog';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Button } from '../../components/Button';
import { Field, RadioGroup, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { call, cancelJob, runOp } from '../../lib/rpc';
import type { OpParams, SplitMode } from '../../lib/ops';
import { basename, dirname, stripExt } from '../../lib/path';
import { usePdfDocument } from '../viewer/pdfCache';
import { jobProgress, useJobStore } from '../jobs/jobStore';
import {
  DEFAULT_NAME_TEMPLATE,
  TEMPLATE_VARIABLES,
  planSplit,
  previewNames,
  unknownVariables,
} from './nameTemplate';
import './SplitDialog.css';

type Preset = 'custom' | 'single' | 'halves' | 'oddEven' | 'bookmarks';

/** 1-based start pages of the top-level outline entries. */
async function bookmarkStarts(pdf: PDFDocumentProxy): Promise<number[]> {
  const outline = (await pdf.getOutline()) ?? [];
  const starts: number[] = [];
  for (const item of outline) {
    try {
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      const ref = dest?.[0];
      if (ref === undefined || ref === null) continue;
      const index =
        typeof ref === 'number'
          ? ref
          : await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
      starts.push(index + 1);
    } catch {
      /* skip broken destinations */
    }
  }
  return starts;
}

/** C5: split the current document (file.split). */
export function SplitDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const defaultDir = useSettings((s) => s.settings.defaultSaveDir);
  const { pdf } = usePdfDocument(doc);
  const pageCount = doc?.info.pageCount ?? 0;
  const [preset, setPreset] = useState<Preset>('custom');
  const [mode, setMode] = useState<SplitMode>('ranges');
  const [ranges, setRanges] = useState(() =>
    pageCount > 1
      ? `1-${Math.ceil(pageCount / 2)},${Math.ceil(pageCount / 2) + 1}-${pageCount}`
      : '1',
  );
  const [n, setN] = useState(1);
  const [maxMb, setMaxMb] = useState(5);
  const [outputDir, setOutputDir] = useState(
    () => defaultDir ?? (doc?.state.sourcePath ? dirname(doc.state.sourcePath) : ''),
  );
  const [template, setTemplate] = useState(DEFAULT_NAME_TEMPLATE);
  const [starts, setStarts] = useState<number[] | null>(null);
  const [applyTo, setApplyTo] = useState<ApplyTo>('this');
  const [extraFiles, setExtraFiles] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<string[] | null>(null);
  const job = useJobStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined));

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void bookmarkStarts(pdf).then((s) => !cancelled && setStarts(s));
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p === 'single') {
      setMode('everyN');
      setN(1);
    } else if (p === 'halves') {
      setMode('ranges');
      const h = Math.ceil(pageCount / 2);
      setRanges(pageCount > 1 ? `1-${h},${h + 1}-${pageCount}` : '1');
    } else if (p === 'oddEven') setMode('oddEven');
    else if (p === 'bookmarks') setMode('bookmarks');
  };

  const plan = useMemo(
    () => planSplit({ mode, pageCount, ranges, n, bookmarkStarts: starts ?? [] }),
    [mode, pageCount, ranges, n, starts],
  );
  const sourceName = stripExt(doc?.name ?? 'document');
  const names = plan ? previewNames(template, sourceName, plan, 6) : [];
  const unknown = unknownVariables(template);

  if (!doc) return null;

  const warnings: string[] = [];
  if (unknown.length)
    warnings.push(t('split.unknownVars', { vars: unknown.map((v) => `{${v}}`).join(', ') }));
  if (mode === 'bookmarks' && starts && starts.length === 0) warnings.push(t('split.noBookmarks'));
  if (doc.state.dirty && applyTo === 'this') warnings.push(t('split.usesCurrentRevision'));
  const rangesInvalid = mode === 'ranges' && !plan;

  const params = (): OpParams['file.split'] => ({
    mode,
    ...(mode === 'ranges' ? { ranges } : {}),
    ...(mode === 'everyN' ? { n } : {}),
    ...(mode === 'maxSize' ? { maxBytes: Math.round(maxMb * 1024 * 1024) } : {}),
    outputDir,
    nameTemplate: template.trim() || DEFAULT_NAME_TEMPLATE,
  });

  const run = async () => {
    const all: string[] = [];
    try {
      if (applyTo === 'this') {
        const r = await runOp('file.split', params(), {
          sessionId: doc.id,
          title: t('split.jobTitle', { name: doc.name }),
          onStarted: setJobId,
        });
        all.push(...r.outputs);
      } else {
        for (const path of extraFiles) {
          const { state } = await call('session.open', { path });
          try {
            const r = await runOp('file.split', params(), {
              sessionId: state.sessionId,
              title: t('split.jobTitle', { name: basename(path) }),
              onStarted: setJobId,
            });
            all.push(...r.outputs);
          } finally {
            void call('session.close', { sessionId: state.sessionId }).catch(() => undefined);
          }
        }
      }
      setOutputs(all);
    } catch (e) {
      showError(e, t('split.failed'));
    } finally {
      setJobId(null);
    }
  };

  if (outputs) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && close()}
        icon={<CircleCheck size={18} />}
        title={t('split.doneTitle')}
        description={t('split.doneText', { count: outputs.length })}
        footer={
          <>
            <DialogSpacer />
            <Button onClick={close}>{t('common.close')}</Button>
            <Button
              variant="primary"
              icon={<FolderOpen size={15} />}
              disabled={!outputs[0]}
              onClick={() => outputs[0] && void chef().files.showInFolder(outputs[0])}
            >
              {t('outputs.showInFolder')}
            </Button>
          </>
        }
      >
        <ul className="split__outputs">
          {outputs.map((o) => (
            <li key={o}>
              <span title={o}>{basename(o)}</span>
              <Button size="sm" variant="ghost" onClick={() => void chef().files.showInFolder(o)}>
                {t('outputs.reveal')}
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>
    );
  }

  const modeOptions = [
    { value: 'ranges' as const, label: t('split.mode.ranges') },
    { value: 'everyN' as const, label: t('split.mode.everyN') },
    {
      value: 'bookmarks' as const,
      label: t('split.mode.bookmarks'),
      hint: starts ? t('split.bookmarkCount', { count: starts.length }) : undefined,
    },
    { value: 'maxSize' as const, label: t('split.mode.maxSize') },
    { value: 'oddEven' as const, label: t('split.mode.oddEven') },
  ];

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('split.title')}
      icon={<Split size={18} />}
      description={t('split.description', { name: doc.name, count: pageCount })}
      preset={{
        value: preset,
        onChange: (v) => applyPreset(v as Preset),
        options: [
          { value: 'custom', label: t('split.preset.custom') },
          { value: 'single', label: t('split.preset.single') },
          { value: 'halves', label: t('split.preset.halves') },
          { value: 'oddEven', label: t('split.preset.oddEven') },
          { value: 'bookmarks', label: t('split.preset.bookmarks') },
        ],
      }}
      runLabel={t('split.run')}
      onRun={() => void run()}
      canRun={
        !!outputDir &&
        !rangesInvalid &&
        (applyTo === 'this' || extraFiles.length > 0) &&
        !(mode === 'bookmarks' && starts?.length === 0)
      }
      running={!!jobId}
      progress={job ? jobProgress(job) : null}
      onCancelRun={jobId ? () => void cancelJob(jobId) : undefined}
      warnings={warnings}
      applyTo={{
        value: applyTo,
        onChange: setApplyTo,
        files: extraFiles,
        onAddFiles: () =>
          void chef()
            .files.openDialog({ multiple: true, filters: PDF_FILTERS })
            .then((p) => setExtraFiles((prev) => [...new Set([...prev, ...p])])),
        onRemoveFile: (p) => setExtraFiles((prev) => prev.filter((x) => x !== p)),
      }}
      preview={
        mode === 'maxSize' ? (
          <p className="muted">{t('split.maxSizePreview')}</p>
        ) : plan ? (
          <ol className="split__preview">
            {names.map((name, i) => (
              <li key={name + i}>
                <span className="split__preview-name">{name}</span>
                <span className="muted">
                  {plan[i]!.start === plan[i]!.end
                    ? t('split.pageN', { page: plan[i]!.start })
                    : t('split.pageRange', { start: plan[i]!.start, end: plan[i]!.end })}
                </span>
              </li>
            ))}
            {plan.length > names.length && (
              <li className="muted">{t('split.andMore', { count: plan.length - names.length })}</li>
            )}
          </ol>
        ) : (
          <p className="muted">{t('split.previewUnavailable')}</p>
        )
      }
      estimate={plan ? t('split.fileCount', { count: plan.length }) : '–'}
      advanced={
        <Field
          label={t('split.nameTemplate')}
          htmlFor="split-template"
          hint={
            <span className="split__vars">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="split__var"
                  onClick={() => setTemplate((s) => `${s}{${v}}`)}
                  title={t(`split.var.${v}`)}
                >
                  {`{${v}}`}
                </button>
              ))}
            </span>
          }
        >
          <TextInput
            id="split-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </Field>
      }
    >
      <Field label={t('split.modeLabel')}>
        <RadioGroup<SplitMode>
          value={mode}
          onChange={(m) => {
            setMode(m);
            setPreset('custom');
          }}
          options={modeOptions}
          aria-label={t('split.modeLabel')}
        />
      </Field>
      {mode === 'ranges' && (
        <Field
          label={t('split.ranges')}
          htmlFor="split-ranges"
          hint={t('split.rangesHint')}
          error={rangesInvalid ? t('split.rangesInvalid', { count: pageCount }) : undefined}
        >
          <TextInput
            id="split-ranges"
            value={ranges}
            invalid={rangesInvalid}
            onChange={(e) => setRanges(e.target.value)}
          />
        </Field>
      )}
      {mode === 'everyN' && (
        <Field label={t('split.everyN')} htmlFor="split-n">
          <TextInput
            id="split-n"
            type="number"
            min={1}
            max={Math.max(1, pageCount)}
            value={n}
            onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
      )}
      {mode === 'maxSize' && (
        <Field label={t('split.maxSize')} htmlFor="split-max" hint={t('split.maxSizeHint')}>
          <div className="field__row">
            <TextInput
              id="split-max"
              type="number"
              min={0.1}
              step={0.5}
              value={maxMb}
              onChange={(e) => setMaxMb(Math.max(0.1, Number(e.target.value) || 1))}
            />
            <span className="muted">MB</span>
          </div>
        </Field>
      )}
      <Field label={t('split.outputDir')} htmlFor="split-dir">
        <div className="field__row">
          <TextInput
            id="split-dir"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder={t('split.outputDirPlaceholder')}
          />
          <Button
            icon={<FolderOpen size={15} />}
            onClick={() => void pickFolder().then((d) => d && setOutputDir(d))}
          >
            {t('common.browse')}
          </Button>
        </div>
      </Field>
    </TaskDialog>
  );
}
