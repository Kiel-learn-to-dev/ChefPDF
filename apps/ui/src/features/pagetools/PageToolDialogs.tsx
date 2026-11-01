/**
 * Page tools of the Trang tab (C6, C7, C9, C10; T5.09): replace pages from another file, crop
 * margins or resize the page size, split pages into a grid, and split one file at smart
 * boundaries. The blank-page review (C8) lives in BlankReviewDialog.tsx.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crop, Repeat, Scissors, Split } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { PDF_FILTERS, pickFolder, probePdf, runDocOp, showError } from '../../app/actions';
import { runOp } from '../../lib/rpc';
import { chef } from '../../lib/bridge';
import { Button } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Segmented, Select, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { NumberField } from '../overlay/OverlayControls';
import { formatPageRanges, parsePageRanges } from '../../lib/pageRange';
import { basename } from '../../lib/path';
import { targetPages } from '../pages/pageActions';
import { renderName } from '../split/nameTemplate';
import { useSourceThumbs } from './sourceThumbs';
import { replaceIssues, replaceParams, type ReplaceForm } from './replaceModel';
import {
  DEFAULT_CROP_FORM,
  DEFAULT_RESIZE_FORM,
  cropIssues,
  cropParams,
  resizeIssues,
  resizeParams,
  type CropForm,
  type CropMethod,
  type ResizeForm,
  type ResizeSize,
} from './cropModel';
import {
  DEFAULT_PAGE_SPLIT_FORM,
  pageSplitIssues,
  pageSplitParams,
  type PageSplitForm,
} from './pageSplitModel';
import {
  DEFAULT_SMART_SPLIT_FORM,
  readSmartSplitResult,
  smartSplitIssues,
  smartSplitParams,
  type SmartMode,
  type SmartSplitForm,
  type SmartSplitResult,
} from './smartSplitModel';
import type { ToolScope } from './pageScope';
import './pagetools.css';

type ScopeChoice = ToolScope;

/** Scope choice (all / odd / even / page list) with the page field when needed. */
function ScopeFields({
  idPrefix,
  scope,
  pagesText,
  allowed,
  invalid,
  onChange,
}: {
  idPrefix: string;
  scope: ScopeChoice;
  pagesText: string;
  allowed: readonly ScopeChoice[];
  invalid: boolean;
  onChange(v: { scope?: ScopeChoice; pagesText?: string }): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('pageTools.scope.label')}>
        <RadioGroup<ScopeChoice>
          value={scope}
          onChange={(s) => onChange({ scope: s })}
          aria-label={t('pageTools.scope.label')}
          options={allowed.map((s) => ({ value: s, label: t(`pageTools.scope.${s}`) }))}
        />
      </Field>
      {scope === 'pages' && (
        <Field
          label={t('pageTools.scope.pages')}
          htmlFor={`${idPrefix}-pages`}
          hint={t('range.hint')}
          error={invalid ? t('pageTools.issue.pages') : undefined}
        >
          <TextInput
            id={`${idPrefix}-pages`}
            value={pagesText}
            invalid={invalid}
            onChange={(e) => onChange({ pagesText: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

const ALL_SCOPES: readonly ScopeChoice[] = ['all', 'odd', 'even', 'pages'];

/** Thay trang (C6): page.replace with pages of another PDF (thumbnails from pdf.js). */
export function ReplaceDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [targetText, setTargetText] = useState(() =>
    doc ? formatPageRanges(targetPages(doc.id)) : '',
  );
  const [src, setSrc] = useState<{ path: string; pageCount: number; password?: string } | null>(
    null,
  );
  const [sourceText, setSourceText] = useState('');
  const [running, setRunning] = useState(false);
  const thumbs = useSourceThumbs(src?.path ?? null, src?.password);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const signed = doc.state.signed;
  const form: ReplaceForm = {
    targetText,
    sourcePath: src?.path ?? '',
    sourcePassword: src?.password,
    sourceCount: src?.pageCount ?? 0,
    sourceText,
  };
  const issues = replaceIssues(form, pageCount);
  const picked = new Set<number>();
  if (src) {
    const p = parsePageRanges(sourceText, src.pageCount);
    if (p.ok) p.pages.forEach((i) => picked.add(i));
  }

  const pick = async () => {
    const [path] = await chef().files.openDialog({ multiple: false, filters: PDF_FILTERS });
    if (!path) return;
    try {
      const probed = await probePdf(path);
      if (probed) {
        setSrc(probed);
        setSourceText('');
      }
    } catch (e) {
      showError(e);
    }
  };

  const toggle = (index: number) => {
    const next = new Set(picked);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setSourceText(formatPageRanges([...next]));
  };

  const run = async () => {
    if (issues.length > 0 || signed) return;
    setRunning(true);
    const r = await runDocOp(
      doc.id,
      'page.replace',
      replaceParams(form, pageCount),
      t('pageTools.replace.jobTitle', { name: doc.name }),
    );
    setRunning(false);
    if (r) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('pageTools.replace.title')}
      icon={<Repeat size={18} />}
      description={t('pageTools.replace.description', { name: doc.name })}
      runLabel={t('pageTools.replace.run')}
      onRun={() => void run()}
      canRun={issues.length === 0 && !signed}
      running={running}
      warnings={
        signed ? [t('pageTools.signedBlocked')] : issues.map((i) => t(`pageTools.issue.${i}`))
      }
    >
      <Field
        label={t('pageTools.replace.target')}
        htmlFor="replace-target"
        hint={t('range.hint')}
        error={issues.includes('target') ? t('pageTools.issue.target') : undefined}
      >
        <TextInput
          id="replace-target"
          value={targetText}
          invalid={issues.includes('target')}
          onChange={(e) => setTargetText(e.target.value)}
        />
      </Field>
      <Field
        label={t('pageTools.replace.source')}
        hint={src ? t('pageTools.replace.sourceCount', { count: src.pageCount }) : undefined}
      >
        <div className="field__row">
          <TextInput
            readOnly
            value={src ? basename(src.path) : ''}
            placeholder={t('pageTools.replace.noSource')}
            aria-label={t('pageTools.replace.source')}
          />
          <Button onClick={() => void pick()}>{t('common.browse')}</Button>
        </div>
      </Field>
      {src && (
        <Field
          label={t('pageTools.replace.sourcePages')}
          htmlFor="replace-source-range"
          hint={t('pageTools.replace.sourcePagesHint')}
          error={issues.includes('sourcePages') ? t('pageTools.issue.sourcePages') : undefined}
        >
          <TextInput
            id="replace-source-range"
            value={sourceText}
            invalid={issues.includes('sourcePages')}
            onChange={(e) => setSourceText(e.target.value)}
          />
        </Field>
      )}
      {src && thumbs.loading && <Spinner label={t('pageTools.replace.loading')} />}
      {src && thumbs.error && <p className="pt-hint">{thumbs.error}</p>}
      {src && thumbs.urls.length > 0 && (
        <div className="pt-thumbs" role="group" aria-label={t('pageTools.replace.sourceThumbs')}>
          {thumbs.urls.map((url, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={picked.has(i)}
              aria-label={t('pageTools.pageN', { page: i + 1 })}
              onClick={() => toggle(i)}
            >
              <img src={url} alt="" />
              <span className="pt-hint">{i + 1}</span>
            </button>
          ))}
        </div>
      )}
    </TaskDialog>
  );
}

/** Cắt lề / đổi khổ (C7): page.crop or page.resize, chosen with the preset switch. */
export function CropResizeDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [kind, setKind] = useState<'crop' | 'resize'>('crop');
  const [crop, setCrop] = useState<CropForm>(DEFAULT_CROP_FORM);
  const [resize, setResize] = useState<ResizeForm>(DEFAULT_RESIZE_FORM);
  const [running, setRunning] = useState(false);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const signed = doc.state.signed;
  const issues: string[] =
    kind === 'crop' ? cropIssues(crop, pageCount) : resizeIssues(resize, pageCount);

  const run = async () => {
    if (issues.length > 0 || signed) return;
    setRunning(true);
    const title = t(`pageTools.${kind}.jobTitle`, { name: doc.name });
    const r =
      kind === 'crop'
        ? await runDocOp(doc.id, 'page.crop', cropParams(crop, pageCount), title)
        : await runDocOp(doc.id, 'page.resize', resizeParams(resize, pageCount), title);
    setRunning(false);
    if (r) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('pageTools.crop.title')}
      icon={<Crop size={18} />}
      description={t('pageTools.crop.description', { name: doc.name })}
      runLabel={t(`pageTools.${kind}.run`)}
      onRun={() => void run()}
      canRun={issues.length === 0 && !signed}
      running={running}
      warnings={
        signed ? [t('pageTools.signedBlocked')] : issues.map((i) => t(`pageTools.issue.${i}`))
      }
      preset={{
        value: kind,
        onChange: (v) => setKind(v as 'crop' | 'resize'),
        options: [
          { value: 'crop', label: t('pageTools.crop.kind') },
          { value: 'resize', label: t('pageTools.resize.kind') },
        ],
      }}
    >
      {kind === 'crop' ? (
        <>
          <Field label={t('pageTools.crop.method')}>
            <Segmented<CropMethod>
              aria-label={t('pageTools.crop.method')}
              value={crop.method}
              onChange={(method) => setCrop((c) => ({ ...c, method }))}
              options={(['margins', 'box', 'autoTrim'] as const).map((m) => ({
                value: m,
                label: t(`pageTools.crop.m.${m}`),
              }))}
            />
          </Field>
          {crop.method === 'margins' && (
            <div className="pt-row">
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <NumberField
                  key={side}
                  id={`crop-${side}`}
                  label={t(`pageTools.crop.side.${side}`)}
                  value={crop.margins[side]}
                  min={0}
                  max={500}
                  step={0.5}
                  hint={t('pageTools.crop.mm')}
                  invalid={crop.margins[side] < 0}
                  onChange={(v) => setCrop((c) => ({ ...c, margins: { ...c.margins, [side]: v } }))}
                />
              ))}
            </div>
          )}
          {crop.method === 'box' && (
            <div className="pt-row">
              {(['x0', 'y0', 'x1', 'y1'] as const).map((name, i) => (
                <NumberField
                  key={name}
                  id={`crop-${name}`}
                  label={t(`pageTools.crop.box.${name}`)}
                  value={crop.box[i] ?? 0}
                  min={-10000}
                  max={10000}
                  step={1}
                  hint={t('pageTools.crop.pt')}
                  invalid={issues.includes('box')}
                  onChange={(v) =>
                    setCrop((c) => ({ ...c, box: c.box.map((x, j) => (j === i ? v : x)) }))
                  }
                />
              ))}
            </div>
          )}
          {crop.method === 'autoTrim' && (
            <NumberField
              id="crop-padding"
              label={t('pageTools.crop.padding')}
              value={crop.paddingMm}
              min={0}
              max={50}
              step={0.5}
              hint={t('pageTools.crop.mm')}
              invalid={issues.includes('padding')}
              onChange={(paddingMm) => setCrop((c) => ({ ...c, paddingMm }))}
            />
          )}
          <ScopeFields
            idPrefix="crop"
            scope={crop.scope}
            pagesText={crop.pagesText}
            allowed={ALL_SCOPES}
            invalid={issues.includes('pages')}
            onChange={(v) => setCrop((c) => ({ ...c, ...v }))}
          />
        </>
      ) : (
        <>
          <Field label={t('pageTools.resize.size')} htmlFor="resize-size">
            <Select<ResizeSize>
              id="resize-size"
              value={resize.size}
              onChange={(size) => setResize((r) => ({ ...r, size }))}
              options={(['A3', 'A4', 'Letter', 'custom'] as const).map((s) => ({
                value: s,
                label: t(`pageTools.resize.preset.${s}`),
              }))}
            />
          </Field>
          {resize.size === 'custom' && (
            <div className="pt-row">
              <NumberField
                id="resize-width"
                label={t('pageTools.resize.width')}
                value={resize.customWidthMm}
                min={1}
                max={5000}
                step={1}
                hint={t('pageTools.crop.mm')}
                invalid={issues.includes('customSize')}
                onChange={(customWidthMm) => setResize((r) => ({ ...r, customWidthMm }))}
              />
              <NumberField
                id="resize-height"
                label={t('pageTools.resize.height')}
                value={resize.customHeightMm}
                min={1}
                max={5000}
                step={1}
                hint={t('pageTools.crop.mm')}
                invalid={issues.includes('customSize')}
                onChange={(customHeightMm) => setResize((r) => ({ ...r, customHeightMm }))}
              />
            </div>
          )}
          <Field label={t('pageTools.resize.fit')}>
            <RadioGroup<'scale' | 'center'>
              value={resize.fit}
              onChange={(fit) => setResize((r) => ({ ...r, fit }))}
              aria-label={t('pageTools.resize.fit')}
              options={[
                { value: 'scale', label: t('pageTools.resize.fitScale') },
                { value: 'center', label: t('pageTools.resize.fitCenter') },
              ]}
            />
          </Field>
          <ScopeFields
            idPrefix="resize"
            scope={resize.scope}
            pagesText={resize.pagesText}
            allowed={ALL_SCOPES}
            invalid={issues.includes('pages')}
            onChange={(v) => setResize((r) => ({ ...r, ...v }))}
          />
        </>
      )}
    </TaskDialog>
  );
}

/** Chia đôi trang (C9): page.split into rows x cols pieces. */
export function PageSplitDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useState<PageSplitForm>(DEFAULT_PAGE_SPLIT_FORM);
  const [running, setRunning] = useState(false);
  if (!doc) return null;

  const pageCount = doc.info.pageCount;
  const signed = doc.state.signed;
  const issues = pageSplitIssues(form, pageCount);
  const run = async () => {
    if (issues.length > 0 || signed) return;
    setRunning(true);
    const r = await runDocOp(
      doc.id,
      'page.split',
      pageSplitParams(form, pageCount),
      t('pageTools.split.jobTitle', { name: doc.name }),
    );
    setRunning(false);
    if (r) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      title={t('pageTools.split.title')}
      icon={<Split size={18} />}
      description={t('pageTools.split.description', { name: doc.name })}
      runLabel={t('pageTools.split.run')}
      onRun={() => void run()}
      canRun={issues.length === 0 && !signed}
      running={running}
      warnings={
        signed ? [t('pageTools.signedBlocked')] : issues.map((i) => t(`pageTools.issue.${i}`))
      }
    >
      <div className="pt-row">
        <NumberField
          id="split-rows"
          label={t('pageTools.split.rows')}
          value={form.rows}
          min={1}
          max={10}
          step={1}
          invalid={issues.includes('rows') || issues.includes('pieces')}
          onChange={(rows) => setForm((f) => ({ ...f, rows }))}
        />
        <NumberField
          id="split-cols"
          label={t('pageTools.split.cols')}
          value={form.cols}
          min={1}
          max={10}
          step={1}
          invalid={issues.includes('cols') || issues.includes('pieces')}
          onChange={(cols) => setForm((f) => ({ ...f, cols }))}
        />
      </div>
      <ScopeFields
        idPrefix="split"
        scope={form.scope}
        pagesText={form.pagesText}
        allowed={['all', 'pages']}
        invalid={issues.includes('pages')}
        onChange={(v) =>
          setForm((f) => ({
            ...f,
            scope: v.scope === 'pages' ? 'pages' : 'all',
            pagesText: v.pagesText ?? f.pagesText,
          }))
        }
      />
      <Field label={t('pageTools.split.order')}>
        <Segmented<'ltr' | 'rtl'>
          aria-label={t('pageTools.split.order')}
          value={form.order}
          onChange={(order) => setForm((f) => ({ ...f, order }))}
          options={[
            { value: 'ltr', label: t('pageTools.split.ltr') },
            { value: 'rtl', label: t('pageTools.split.rtl') },
          ]}
        />
      </Field>
      <NumberField
        id="split-overlap"
        label={t('pageTools.split.overlap')}
        value={form.overlapMm}
        min={0}
        max={50}
        step={0.5}
        hint={t('pageTools.crop.mm')}
        invalid={issues.includes('overlap')}
        onChange={(overlapMm) => setForm((f) => ({ ...f, overlapMm }))}
      />
    </TaskDialog>
  );
}

/** Tách thông minh (C10): file.splitSmart writes the parts to a folder (standalone op). */
export function SmartSplitDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [source, setSource] = useState<{ path: string; password?: string } | null>(() =>
    doc?.state.sourcePath ? { path: doc.state.sourcePath, password: doc.password } : null,
  );
  const [form, setForm] = useState<SmartSplitForm>(DEFAULT_SMART_SPLIT_FORM);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SmartSplitResult | null>(null);
  if (!doc) return null;

  const issues: string[] = smartSplitIssues(form);
  const set = (patch: Partial<SmartSplitForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
  };
  const pickSource = async () => {
    const [path] = await chef().files.openDialog({ multiple: false, filters: PDF_FILTERS });
    if (!path) return;
    try {
      const probed = await probePdf(path);
      if (probed) setSource({ path: probed.path, password: probed.password });
    } catch (e) {
      showError(e);
    }
  };
  const pickOut = async () => {
    const dir = await pickFolder();
    if (dir) set({ outputDir: dir });
  };
  const run = async () => {
    if (!source || issues.length > 0) return;
    setRunning(true);
    setResult(null);
    try {
      const r = await runOp(
        'file.splitSmart',
        smartSplitParams(form, source.path, source.password),
        { title: t('pageTools.smart.jobTitle', { name: basename(source.path) }) },
      );
      setResult(readSmartSplitResult(r.data, r.outputs));
    } catch (e) {
      showError(e);
    } finally {
      setRunning(false);
    }
  };

  const sample = renderName(form.nameTemplate, {
    name: source ? basename(source.path).replace(/\.pdf$/i, '') : 'file',
    index: 1,
    total: 3,
    start: 1,
    end: 3,
  });
  const first = result?.outputs[0];

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('pageTools.smart.title')}
      icon={<Scissors size={18} />}
      description={t('pageTools.smart.description')}
      runLabel={t('pageTools.smart.run')}
      onRun={() => void run()}
      canRun={!!source && issues.length === 0 && !running}
      running={running}
      warnings={issues.map((i) => t(`pageTools.issue.${i}`))}
      advanced={
        <Checkbox
          checked={form.dropSeparatorPages}
          onChange={(dropSeparatorPages) => set({ dropSeparatorPages })}
          label={t('pageTools.smart.dropSeparators')}
          hint={t('pageTools.smart.dropSeparatorsHint')}
          disabled={form.mode !== 'blank'}
        />
      }
    >
      <Field label={t('pageTools.smart.source')}>
        <div className="field__row">
          <TextInput
            readOnly
            value={source ? basename(source.path) : ''}
            placeholder={t('pageTools.replace.noSource')}
            aria-label={t('pageTools.smart.source')}
          />
          <Button onClick={() => void pickSource()}>{t('common.browse')}</Button>
        </div>
      </Field>
      <Field label={t('pageTools.smart.mode.label')}>
        <Select<SmartMode>
          value={form.mode}
          onChange={(mode) => set({ mode })}
          aria-label={t('pageTools.smart.mode.label')}
          options={(['blank', 'bookmarkLevel', 'pattern'] as const).map((m) => ({
            value: m,
            label: t(`pageTools.smart.mode.${m}`),
          }))}
        />
      </Field>
      {form.mode === 'bookmarkLevel' && (
        <NumberField
          id="smart-level"
          label={t('pageTools.smart.level')}
          value={form.level}
          min={1}
          max={10}
          step={1}
          hint={t('pageTools.smart.levelHint')}
          invalid={issues.includes('level')}
          onChange={(level) => set({ level })}
        />
      )}
      {form.mode === 'pattern' && (
        <>
          <Field
            label={t('pageTools.smart.pattern')}
            htmlFor="smart-pattern"
            hint={t('pageTools.smart.patternHint')}
            error={issues.includes('pattern') ? t('pageTools.issue.pattern') : undefined}
          >
            <TextInput
              id="smart-pattern"
              value={form.pattern}
              invalid={issues.includes('pattern')}
              onChange={(e) => set({ pattern: e.target.value })}
            />
          </Field>
          <Checkbox
            checked={form.ignoreCase}
            onChange={(ignoreCase) => set({ ignoreCase })}
            label={t('pageTools.smart.ignoreCase')}
          />
        </>
      )}
      {form.mode === 'blank' && (
        <NumberField
          id="smart-sensitivity"
          label={t('pageTools.smart.sensitivity')}
          value={Math.round(form.blankSensitivity * 100)}
          min={0}
          max={100}
          step={5}
          hint={t('pageTools.smart.sensitivityHint')}
          onChange={(v) => set({ blankSensitivity: v / 100 })}
        />
      )}
      <Field label={t('pageTools.smart.outputDir')}>
        <div className="field__row">
          <TextInput
            readOnly
            value={form.outputDir}
            placeholder={t('pageTools.smart.noOutputDir')}
            aria-label={t('pageTools.smart.outputDir')}
          />
          <Button onClick={() => void pickOut()}>{t('common.browse')}</Button>
        </div>
      </Field>
      <Field
        label={t('pageTools.smart.nameTemplate')}
        htmlFor="smart-template"
        hint={t('pageTools.smart.nameHint', { sample })}
        error={issues.includes('nameTemplate') ? t('pageTools.issue.nameTemplate') : undefined}
      >
        <TextInput
          id="smart-template"
          value={form.nameTemplate}
          invalid={issues.includes('nameTemplate')}
          onChange={(e) => set({ nameTemplate: e.target.value })}
        />
      </Field>
      {result && (
        <section className="pt-result" role="status" aria-label={t('pageTools.smart.resultLabel')}>
          <strong>{t('pageTools.smart.result', { count: result.parts })}</strong>
          <ul>
            {result.outputs.map((o) => (
              <li key={o}>{basename(o)}</li>
            ))}
          </ul>
          {first && (
            <Button size="sm" variant="ghost" onClick={() => void chef().files.showInFolder(first)}>
              {t('pageTools.smart.openFolder')}
            </Button>
          )}
        </section>
      )}
    </TaskDialog>
  );
}
