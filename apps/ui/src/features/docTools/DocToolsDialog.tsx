/**
 * "Thuộc tính & tiện ích" (M7-M10): metadata, attachments, image and text extraction, and web
 * optimisation of the open document. Each section runs one core op on the document's session
 * (web optimisation runs on the saved file).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  FileText,
  FilePlus2,
  Image as ImageIcon,
  Paperclip,
  Save,
  Trash2,
  Zap,
} from 'lucide-react';
import type { DocAttachmentsListParams } from '@chef/contracts';
import { announceOutputs, errorMessage, pickFolder, runDocOp } from '../../app/actions';
import { confirmDialog } from '../../app/prompts';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox, Field, Segmented, TextInput } from '../../components/Form';
import { EmptyState, Badge } from '../../components/Misc';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { formatBytes } from '../../lib/format';
import { toChefError } from '../../lib/errors';
import { basename } from '../../lib/path';
import { runOp } from '../../lib/rpc';
import {
  DATE_KEYS,
  DEFAULT_IMAGE_TEMPLATE,
  EMPTY_METADATA,
  STANDARD_KEYS,
  attachmentNames,
  extractImagesParams,
  extractTextParams,
  formFromMetadata,
  imageTemplateProblem,
  metadataParams,
  metadataProblem,
  pagesFromField,
  savedPercent,
  sortAttachments,
  webSourcePath,
  type AttachmentRow,
  type MetadataForm,
  type StandardKey,
} from './docToolsModel';
import './docTools.css';

type Section = 'meta' | 'attach' | 'images' | 'text' | 'web';
const SECTIONS: readonly Section[] = ['meta', 'attach', 'images', 'text', 'web'];
type DocTab = NonNullable<ReturnType<typeof useActiveDoc>>;

export function DocToolsDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const doc = useActiveDoc();
  const [section, setSection] = useState<Section>('meta');

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<FileText size={18} />}
      title={t('docTools.title')}
      description={t('docTools.description')}
      size="lg"
    >
      {!doc ? (
        <EmptyState icon={<FileText size={22} />} title={t('docTools.noDoc')} text="" />
      ) : (
        <div className="docTools">
          <Segmented<Section>
            aria-label={t('docTools.sectionsLabel')}
            value={section}
            onChange={setSection}
            options={SECTIONS.map((s) => ({ value: s, label: t(`docTools.sections.${s}`) }))}
          />
          {section === 'meta' && <MetadataSection doc={doc} />}
          {section === 'attach' && <AttachmentSection doc={doc} />}
          {section === 'images' && <ImagesSection doc={doc} />}
          {section === 'text' && <TextSection doc={doc} />}
          {section === 'web' && <WebSection doc={doc} />}
        </div>
      )}
    </Dialog>
  );
}

// ---------- (M9) metadata ----------

function MetadataSection({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<MetadataForm>(() => formFromMetadata(doc.info.metadata));
  const [busy, setBusy] = useState(false);
  const problem = metadataProblem(form);

  const save = async (clear = false) => {
    if (!clear && problem) return toast.warning(t(`docTools.meta.problem.${problem}`));
    if (clear) {
      const ok = await confirmDialog({
        title: t('docTools.meta.clearTitle'),
        message: t('docTools.meta.clearText'),
        tone: 'danger',
        actions: [
          { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
          { id: 'clear', label: t('docTools.meta.clear'), variant: 'danger' },
        ],
      });
      if (ok !== 'clear') return;
    }
    setBusy(true);
    try {
      const result = await runDocOp(
        doc.id,
        'doc.setMetadata',
        metadataParams(clear ? EMPTY_METADATA : form, clear),
        t('docTools.meta.job'),
      );
      const meta = (result?.data as { metadata?: Record<string, string> } | undefined)?.metadata;
      if (meta) setForm(formFromMetadata(meta));
      if (result) toast.success(t('docTools.meta.saved'));
    } finally {
      setBusy(false);
    }
  };

  const setStd = (k: StandardKey, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setCustom = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setForm((f) => ({
      ...f,
      custom: f.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));

  return (
    <section className="docTools__section" aria-labelledby="docTools-meta">
      <h3 id="docTools-meta" className="docTools__title">
        {t('docTools.meta.title')}
      </h3>
      <div className="docTools__grid">
        {STANDARD_KEYS.map((k) => (
          <Field key={k} label={t(`docTools.meta.keys.${k}`)}>
            <TextInput
              size="sm"
              value={form[k]}
              placeholder={DATE_KEYS.includes(k) ? '2024-03-01T09:30:00+07:00' : undefined}
              onChange={(e) => setStd(k, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <h4 className="docTools__subtitle">{t('docTools.meta.custom')}</h4>
      {form.custom.map((c, i) => (
        <div key={i} className="docTools__row">
          <TextInput
            size="sm"
            aria-label={t('docTools.meta.customKey')}
            value={c.key}
            onChange={(e) => setCustom(i, { key: e.target.value })}
          />
          <TextInput
            size="sm"
            aria-label={t('docTools.meta.customValue')}
            value={c.value}
            onChange={(e) => setCustom(i, { value: e.target.value })}
          />
          <IconButton
            size="sm"
            label={t('docTools.meta.removeCustom')}
            icon={<Trash2 size={14} />}
            onClick={() => setForm((f) => ({ ...f, custom: f.custom.filter((_, j) => j !== i) }))}
          />
        </div>
      ))}
      <div className="docTools__row">
        <Button
          size="sm"
          onClick={() => setForm((f) => ({ ...f, custom: [...f.custom, { key: '', value: '' }] }))}
        >
          {t('docTools.meta.addCustom')}
        </Button>
      </div>
      {problem && (
        <p className="docTools__note docTools__note--warn" role="alert">
          {t(`docTools.meta.problem.${problem}`)}
        </p>
      )}
      <div className="docTools__row docTools__end">
        <Button variant="danger" disabled={busy} onClick={() => void save(true)}>
          {t('docTools.meta.clear')}
        </Button>
        <Button
          variant="primary"
          icon={<Save size={15} />}
          loading={busy}
          disabled={busy || problem !== null}
          onClick={() => void save(false)}
        >
          {t('docTools.meta.save')}
        </Button>
      </div>
    </section>
  );
}

// ---------- (M8) attachments ----------

function AttachmentSection({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AttachmentRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const fetchRows = async (): Promise<AttachmentRow[]> => {
    const result = await runDocOp(
      doc.id,
      'doc.attachments.list',
      {} satisfies DocAttachmentsListParams,
      t('docTools.attach.job'),
    );
    return sortAttachments(Array.isArray(result?.data) ? (result!.data as AttachmentRow[]) : []);
  };

  const reload = async () => {
    setRows(await fetchRows());
    setSelected(new Set());
  };

  // The list is read from the new state whenever the document changes.
  useEffect(() => {
    let alive = true;
    void fetchRows().then((list) => {
      if (!alive) return;
      setRows(list);
      setSelected(new Set());
    });
    return () => {
      alive = false;
    };
    // fetchRows reads doc.id and t only; the effect must rerun on the document, not on renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.version]);

  const add = async () => {
    const paths = await chef().files.openDialog({ multiple: true });
    if (paths.length === 0) return;
    setBusy(true);
    try {
      await runDocOp(doc.id, 'doc.attachments.add', { paths }, t('docTools.attach.job'));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const extract = async () => {
    const dir = await pickFolder();
    if (!dir || !rows) return;
    setBusy(true);
    try {
      const names = attachmentNames(rows, selected);
      const result = await runDocOp(
        doc.id,
        'doc.attachments.extract',
        { outputDir: dir, names },
        t('docTools.attach.job'),
      );
      if (result) announceOutputs(t('docTools.attach.extracted'), result.outputs);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rows) return;
    const names = attachmentNames(rows, selected);
    if (names.length === 0) return;
    const ok = await confirmDialog({
      title: t('docTools.attach.removeTitle'),
      message: t('docTools.attach.removeText', { count: names.length }),
      tone: 'danger',
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'remove', label: t('docTools.attach.remove'), variant: 'danger' },
      ],
    });
    if (ok !== 'remove') return;
    setBusy(true);
    try {
      await runDocOp(doc.id, 'doc.attachments.remove', { names }, t('docTools.attach.job'));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="docTools__section" aria-labelledby="docTools-attach">
      <h3 id="docTools-attach" className="docTools__title">
        {t('docTools.attach.title')}
      </h3>
      <div className="docTools__row">
        <Button icon={<FilePlus2 size={15} />} disabled={busy} onClick={() => void add()}>
          {t('docTools.attach.add')}
        </Button>
        <Button
          icon={<Download size={15} />}
          disabled={busy || !rows || rows.length === 0}
          onClick={() => void extract()}
        >
          {t('docTools.attach.extract')}
        </Button>
        <Button
          icon={<Trash2 size={15} />}
          variant="danger"
          disabled={busy || !rows || selected.size === 0}
          onClick={() => void remove()}
        >
          {t('docTools.attach.remove')}
        </Button>
      </div>
      {rows === null ? null : rows.length === 0 ? (
        <EmptyState icon={<Paperclip size={20} />} title={t('docTools.attach.empty')} text="" />
      ) : (
        <ul className="docTools__list" aria-label={t('docTools.attach.listLabel')}>
          {rows.map((r) => (
            <li key={r.name}>
              <Checkbox
                checked={selected.has(r.name)}
                label={r.name}
                hint={formatBytes(r.size)}
                onChange={(on) =>
                  setSelected((cur) => {
                    const next = new Set(cur);
                    if (on) next.add(r.name);
                    else next.delete(r.name);
                    return next;
                  })
                }
              />
              {r.description && <Badge>{r.description}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- (M7) images ----------

function ImagesSection({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const [dir, setDir] = useState<string | null>(null);
  const [pages, setPages] = useState('');
  const [template, setTemplate] = useState(DEFAULT_IMAGE_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const pageField = pagesFromField(pages, doc.info.pageCount);
  const tProblem = imageTemplateProblem(template);
  const canRun = !busy && dir !== null && pageField.ok && tProblem === null;

  const run = async () => {
    if (!dir || !pageField.ok) return;
    setBusy(true);
    try {
      const result = await runDocOp(
        doc.id,
        'doc.extractImages',
        extractImagesParams(dir, pageField.pages, template),
        t('docTools.images.job'),
      );
      if (result) {
        toast.success(
          t('docTools.images.done'),
          t('docTools.images.count', { count: result.outputs.length }),
        );
        announceOutputs(t('docTools.images.done'), result.outputs);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="docTools__section" aria-labelledby="docTools-images">
      <h3 id="docTools-images" className="docTools__title">
        {t('docTools.images.title')}
      </h3>
      <div className="docTools__row">
        <Button
          icon={<ImageIcon size={15} />}
          disabled={busy}
          onClick={() => void pickFolder().then((d) => d && setDir(d))}
        >
          {t('docTools.images.pickDir')}
        </Button>
        <span className="docTools__file" title={dir ?? undefined}>
          {dir ?? t('docTools.images.noDir')}
        </span>
      </div>
      <div className="docTools__grid">
        <Field label={t('docTools.images.pages')} hint={t('docTools.images.pagesHint')}>
          <TextInput
            size="sm"
            value={pages}
            placeholder={t('docTools.images.pagesPlaceholder')}
            onChange={(e) => setPages(e.target.value)}
          />
        </Field>
        <Field label={t('docTools.images.template')} hint={t('docTools.images.templateHint')}>
          <TextInput size="sm" value={template} onChange={(e) => setTemplate(e.target.value)} />
        </Field>
      </div>
      {!pageField.ok && (
        <p className="docTools__note docTools__note--warn" role="alert">
          {t('docTools.images.badPages')}
        </p>
      )}
      {tProblem && (
        <p className="docTools__note docTools__note--warn" role="alert">
          {t(`docTools.images.templateProblem.${tProblem}`)}
        </p>
      )}
      <div className="docTools__row docTools__end">
        <Button variant="primary" loading={busy} disabled={!canRun} onClick={() => void run()}>
          {t('docTools.images.run')}
        </Button>
      </div>
    </section>
  );
}

// ---------- (M7) text ----------

function TextSection({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [markers, setMarkers] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const base = basename(doc.name).replace(/\.pdf$/i, '');
    const picked = await chef().files.saveDialog({
      defaultPath: `${base}.txt`,
      filters: [{ name: t('docTools.text.filter'), extensions: ['txt'] }],
    });
    if (picked) setPath(picked);
  };

  const run = async () => {
    if (!path) return;
    setBusy(true);
    try {
      const result = await runDocOp(
        doc.id,
        'doc.extractText',
        extractTextParams(path, markers),
        t('docTools.text.job'),
      );
      if (result) announceOutputs(t('docTools.text.done'), result.outputs);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="docTools__section" aria-labelledby="docTools-text">
      <h3 id="docTools-text" className="docTools__title">
        {t('docTools.text.title')}
      </h3>
      <div className="docTools__row">
        <Button icon={<FileText size={15} />} disabled={busy} onClick={() => void pick()}>
          {t('docTools.text.pick')}
        </Button>
        <span className="docTools__file" title={path ?? undefined}>
          {path ? basename(path) : t('docTools.text.noFile')}
        </span>
      </div>
      <Checkbox checked={markers} onChange={setMarkers} label={t('docTools.text.markers')} />
      <div className="docTools__row docTools__end">
        <Button
          variant="primary"
          loading={busy}
          disabled={!path || busy}
          onClick={() => void run()}
        >
          {t('docTools.text.run')}
        </Button>
      </div>
    </section>
  );
}

// ---------- (M10) web ----------

function WebSection({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const source = webSourcePath({
    sourcePath: doc.state.sourcePath,
    dirty: doc.state.dirty,
    signed: doc.state.signed,
  });
  const blockedBy = doc.state.signed
    ? 'signed'
    : doc.state.dirty || !doc.state.sourcePath
      ? 'unsaved'
      : null;

  const run = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const result = await runOp(
        'doc.optimizeWeb',
        { inputPath: source, outputPath: source },
        { title: t('docTools.web.job') },
      );
      const d = (result.data ?? {}) as { beforeBytes?: number; afterBytes?: number };
      setBefore(typeof d.beforeBytes === 'number' ? d.beforeBytes : null);
      setAfter(typeof d.afterBytes === 'number' ? d.afterBytes : null);
      toast.success(t('docTools.web.done'), t('docTools.web.reopen'));
    } catch (e) {
      toast.error(t('docTools.web.failed'), errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="docTools__section" aria-labelledby="docTools-web">
      <h3 id="docTools-web" className="docTools__title">
        {t('docTools.web.title')}
      </h3>
      <p className="docTools__note">{t('docTools.web.help')}</p>
      {blockedBy && (
        <p className="docTools__note docTools__note--warn" role="alert">
          {t(`docTools.web.blocked.${blockedBy}`)}
        </p>
      )}
      {before !== null && after !== null && (
        <p className="docTools__note" role="status">
          {t('docTools.web.result', {
            before: formatBytes(before),
            after: formatBytes(after),
            percent: savedPercent(before, after),
          })}
        </p>
      )}
      <div className="docTools__row docTools__end">
        <Button
          variant="primary"
          icon={<Zap size={15} />}
          loading={busy}
          disabled={!source || busy}
          onClick={() => void run()}
        >
          {t('docTools.web.run')}
        </Button>
      </div>
    </section>
  );
}
