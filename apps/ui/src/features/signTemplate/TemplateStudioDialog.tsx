import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  KeyRound,
  Plus,
  Save,
  Stamp,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  CertInfoData,
  LibraryItem,
  SignTemplateEntry,
  SignatureTemplate,
  TemplateLine,
} from '@chef/contracts';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox, Field, Segmented, Select, Switch, TextInput } from '../../components/Form';
import { Badge } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { readCertificate } from '../certs/certOps';
import { fileNameOf } from '../certs/pfxList';
import { PREVIEW_BOX, TemplatePreview } from './TemplatePreview';
import { SAMPLE_VALUES, renderRows, valuesFromCert, type SignValues } from './sampleData';
import {
  ALIGNS,
  FITS,
  LAYOUTS,
  LIMITS,
  LINE_SOURCES,
  MAX_TEMPLATE_LINES,
  VALIGNS,
  clamp,
  defaultTemplate,
  fromWire,
  moveLine,
  newLine,
  normalizeTemplate,
  parseTemplateFile,
  templateFileText,
  toWire,
} from './templateModel';
import {
  MAX_TEMPLATES,
  addEntry,
  bindTemplate,
  boundTemplate,
  cleanName,
  duplicateEntry,
  newTemplateId,
  removeEntry,
  replaceEntry,
} from './templateList';
import { hasProofOp, renderTemplateProof } from './templateProof';
import './signTemplate.css';

type Source = 'sample' | 'cert';
type Slot = 'image' | 'logo';

/** Wire object as a plain record, for the settings store. */
function wireRecord(template: SignatureTemplate): Record<string, unknown> {
  return toWire(template) as unknown as Record<string, unknown>;
}

/** Values the core's proof op takes from the sample or certificate values. */
function proofValues(v: SignValues) {
  return {
    signerName: v.signerName,
    organization: v.organization,
    taxCode: v.taxCode,
    citizenId: v.citizenId,
    reason: v.reason,
    location: v.location,
    contact: v.contact,
  };
}

function withSlot(
  d: SignatureTemplate,
  slot: Slot,
  value: NonNullable<SignatureTemplate['image']>,
): SignatureTemplate {
  return slot === 'image' ? { ...d, image: value } : { ...d, logo: value };
}
type LibraryRefs = NonNullable<SignTemplateEntry['libraryRefs']>;

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];

/** Number field: edits as text, clamps to [min, max] on blur or Enter. */
function NumberField({
  label,
  value,
  range,
  step = 0.5,
  onCommit,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  // Follow outside changes while the user is not typing (state adjusted during render, no effect).
  if (seen !== value) {
    setSeen(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    if (!Number.isFinite(n)) return setText(String(value));
    const c = clamp(n, range);
    setText(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <Field label={label}>
      <TextInput
        type="number"
        inputMode="decimal"
        min={range[0]}
        max={range[1]}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </Field>
  );
}

/** Mẫu chữ ký studio (I10-I18): templates, the form, data sources and the preview. */
export function TemplateStudioDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const saved = useSettings((s) => s.settings.signTemplates);
  const knownPfx = useSettings((s) => s.settings.knownPfxFiles);
  const update = useSettings((s) => s.update);

  const [selectedId, setSelectedId] = useState<string | null>(saved[0]?.id ?? null);
  const [draft, setDraft] = useState<SignatureTemplate>(() =>
    saved[0] ? fromWire(saved[0].template) : defaultTemplate(),
  );
  const [refs, setRefs] = useState<LibraryRefs>(saved[0]?.libraryRefs ?? {});
  const [dirty, setDirty] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [source, setSource] = useState<Source>('sample');
  const [values, setValues] = useState<SignValues>(SAMPLE_VALUES);
  const [cert, setCert] = useState<CertInfoData | null>(null);
  const [pfxPath, setPfxPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [proofOk, setProofOk] = useState(false);
  const [proofImage, setProofImage] = useState<string | null>(null);
  const temp = useRef<Set<string>>(new Set());

  const current = saved.find((e) => e.id === selectedId) ?? null;
  const bound = cert ? boundTemplate(saved, cert.fingerprintSha256) : undefined;
  const isBoundHere =
    !!current && !!cert && current.certFingerprint === cert.fingerprintSha256.toLowerCase();
  const rows = useMemo(() => renderRows(draft, values), [draft, values]);

  const releaseTemp = useCallback(async (path: string | undefined) => {
    if (!path || !temp.current.has(path)) return;
    temp.current.delete(path);
    await chef()
      .library.release(path)
      .catch(() => undefined);
  }, []);

  // Decrypted library copies live only while the studio is open.
  useEffect(() => {
    const files = temp.current;
    return () => {
      for (const p of files)
        void chef()
          .library.release(p)
          .catch(() => undefined);
      files.clear();
    };
  }, []);

  useEffect(() => {
    void chef()
      .library.list()
      .then(setLibrary)
      .catch(() => setLibrary([]));
    void hasProofOp().then(setProofOk);
  }, []);

  const fail = (e: unknown) => setNotice(errorMessage(toChefError(e)));

  /** Puts the library copy of a slot into the draft as a temporary PNG path. */
  async function materialize(slot: Slot, id: string | undefined) {
    const old = draft[slot]?.path;
    if (!id) {
      setDraft((d) => {
        const next = { ...d };
        delete next[slot];
        return next;
      });
      await releaseTemp(old);
      return;
    }
    try {
      const path = await chef().library.materialize(id);
      temp.current.add(path);
      await releaseTemp(old);
      setDraft((d) =>
        withSlot(d, slot, {
          path,
          fit: d[slot]?.fit ?? 'contain',
          opacity: d[slot]?.opacity ?? 1,
        }),
      );
    } catch (e) {
      fail(e);
    }
  }

  function loadEntry(entry: SignTemplateEntry) {
    const normalized = normalizeTemplate(entry.template);
    setSelectedId(entry.id);
    setDraft(normalized.template);
    setWarnings(normalized.warnings);
    setRefs({ ...(entry.libraryRefs ?? {}) });
    setDirty(false);
    setNotice(null);
    setProofImage(null);
    for (const slot of ['image', 'logo'] as const satisfies readonly Slot[]) {
      const id = entry.libraryRefs?.[slot];
      if (id) void materialize(slot, id);
    }
  }

  function patch(p: Partial<SignatureTemplate>) {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  }

  function setLines(lines: TemplateLine[]) {
    patch({ lines });
  }

  function newTemplate() {
    setSelectedId(null);
    setDraft(defaultTemplate(t('tpl.newName')));
    setRefs({});
    setWarnings([]);
    setDirty(true);
    setNotice(null);
    setProofImage(null);
  }

  /** Writes the list to settings; a failure keeps the draft and shows the reason. */
  async function persist(list: SignTemplateEntry[]): Promise<boolean> {
    try {
      await update({ signTemplates: list });
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  async function save() {
    const name = cleanName(draft.name ?? '') ?? t('tpl.untitled');
    const cleanRefs: LibraryRefs = {};
    if (refs.image && draft.image) cleanRefs.image = refs.image;
    if (refs.logo && draft.logo) cleanRefs.logo = refs.logo;
    const id = selectedId ?? newTemplateId();
    const entry: SignTemplateEntry = {
      id,
      name,
      template: wireRecord({ ...draft, name }),
      ...(current?.certFingerprint ? { certFingerprint: current.certFingerprint } : {}),
      ...(Object.keys(cleanRefs).length > 0 ? { libraryRefs: cleanRefs } : {}),
    };
    const list = current
      ? replaceEntry(saved, entry)
      : (() => {
          const added = addEntry(saved, entry);
          if (!added.ok) {
            setNotice(
              t(added.reason === 'full' ? 'tpl.full' : 'tpl.saveFailed', { max: MAX_TEMPLATES }),
            );
            return null;
          }
          return added.list;
        })();
    if (!list) return;
    if (await persist(list)) {
      setSelectedId(id);
      setDirty(false);
      setNotice(t('tpl.saved'));
    }
  }

  async function remove() {
    if (!current) return;
    const list = removeEntry(saved, current.id);
    if (await persist(list)) {
      const next = list[0];
      if (next) loadEntry(next);
      else newTemplate();
    }
  }

  async function duplicate() {
    if (!current) return;
    const result = duplicateEntry(saved, current.id, newTemplateId());
    if (!result.ok) {
      setNotice(t('tpl.full'));
      return;
    }
    const copy = result.list[result.list.length - 1]!;
    if (await persist(result.list)) loadEntry(copy);
  }

  async function importFile() {
    try {
      const [picked] = await chef().files.openDialog({ multiple: false, filters: JSON_FILTER });
      if (!picked) return;
      const parsed = parseTemplateFile(await chef().files.readText(picked));
      const name = cleanName(parsed.template.name ?? '') ?? t('tpl.imported');
      const entry: SignTemplateEntry = {
        id: newTemplateId(),
        name,
        template: wireRecord({ ...parsed.template, name }),
      };
      const added = addEntry(saved, entry);
      if (!added.ok) {
        setNotice(t('tpl.full'));
        return;
      }
      if (await persist(added.list)) {
        loadEntry(entry);
        setWarnings(parsed.warnings);
        setNotice(t('tpl.imported'));
      }
    } catch (e) {
      setNotice(t('tpl.importFailed', { message: errorMessage(toChefError(e)) }));
    }
  }

  async function exportFile() {
    try {
      const path = await chef().files.saveDialog({
        defaultPath: `${cleanName(draft.name ?? '') ?? 'mau-chu-ky'}.json`,
        filters: JSON_FILTER,
      });
      if (!path) return;
      await chef().files.writeText(path, templateFileText(draft));
      setNotice(t('tpl.exported'));
    } catch (e) {
      fail(e);
    }
  }

  async function bindToCert(on: boolean) {
    if (!cert || !current) {
      setNotice(t('tpl.saveFirst'));
      return;
    }
    const list = bindTemplate(saved, current.id, on ? cert.fingerprintSha256 : null);
    if (await persist(list)) setNotice(on ? t('tpl.bound') : t('tpl.unbound'));
  }

  async function readCert(path: string, pw: string | undefined, fromSecret: boolean) {
    setBusy(true);
    try {
      const info = await readCertificate(path, pw, t('tpl.readJob'));
      setCert(info);
      setPfxPath(path);
      setValues(valuesFromCert(info));
      setPassword('');
      const match = boundTemplate(
        useSettings.getState().settings.signTemplates,
        info.fingerprintSha256,
      );
      if (match) loadEntry(match);
      setNotice(
        t('tpl.certLoaded', { name: info.identity.personName ?? info.subjectCommonName ?? '' }),
      );
    } catch (e) {
      setCert(null);
      setNotice(fromSecret ? t('tpl.savedPasswordWrong') : errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function pickPfx() {
    const [picked] = await chef().files.openDialog({
      multiple: false,
      filters: [{ name: t('certs.pfxFilter'), extensions: ['pfx', 'p12'] }],
    });
    if (picked) {
      setPfxPath(picked);
      setPassword('');
    }
  }

  async function openKnown(path: string, remembered: boolean) {
    setPfxPath(path);
    if (remembered) {
      const secret = await chef()
        .secrets.get(path)
        .catch(() => null);
      if (secret !== null) return readCert(path, secret, true);
    }
    setPassword('');
  }

  async function proof() {
    setBusy(true);
    try {
      const path = await renderTemplateProof(draft, proofValues(values), PREVIEW_BOX);
      setProofImage(chef().files.toUrl(path));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const slotOptions = [
    { value: '', label: t('tpl.noImage') },
    ...library.map((i) => ({ value: i.id, label: `${i.name} · ${t(`lib.kind.${i.kind}`)}` })),
  ];

  const moveTo = (index: number, to: number) => setLines(moveLine(draft.lines ?? [], index, to));
  const lines = draft.lines ?? [];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<Stamp size={18} />}
      title={t('tpl.title')}
      description={t('tpl.description')}
      size="xl"
      footer={
        <>
          <Button onClick={() => void importFile()} icon={<Upload size={14} />}>
            {t('tpl.import')}
          </Button>
          <Button onClick={() => void exportFile()} icon={<Download size={14} />}>
            {t('tpl.export')}
          </Button>
          <span className="tpl__spacer" />
          {notice && (
            <span className="tpl__notice" role="status">
              {notice}
            </span>
          )}
          <Button
            variant="primary"
            icon={<Save size={14} />}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {t('tpl.save')}
          </Button>
        </>
      }
    >
      <div className="tpl">
        {/* (1) template list */}
        <aside className="tpl__list" aria-label={t('tpl.listLabel')}>
          <div className="tpl__list-actions">
            <IconButton label={t('tpl.new')} icon={<FilePlus2 size={15} />} onClick={newTemplate} />
            <IconButton
              label={t('tpl.duplicate')}
              icon={<Copy size={15} />}
              disabled={!current}
              onClick={() => void duplicate()}
            />
            <IconButton
              label={t('tpl.delete')}
              icon={<Trash2 size={15} />}
              disabled={!current}
              onClick={() => void remove()}
            />
          </div>
          {saved.length === 0 && !dirty && <p className="tpl__muted">{t('tpl.none')}</p>}
          <ul className="tpl__items">
            {saved.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="tpl__item"
                  aria-current={e.id === selectedId ? 'true' : undefined}
                  onClick={() => loadEntry(e)}
                >
                  <span className="tpl__item-name">{e.name}</span>
                  {e.certFingerprint && <Badge tone="accent">{t('tpl.boundBadge')}</Badge>}
                </button>
              </li>
            ))}
          </ul>
          {!current && dirty && <p className="tpl__muted">{t('tpl.unsavedNew')}</p>}
        </aside>

        {/* (2) form */}
        <div className="tpl__form">
          {warnings.length > 0 && (
            <ul className="tpl__warnings" role="status">
              {warnings.slice(0, 6).map((w, i) => (
                <li key={`${w}-${i}`}>{w}</li>
              ))}
            </ul>
          )}

          <fieldset className="tpl__group">
            <legend>{t('tpl.group.content')}</legend>
            <div className="tpl__row">
              <Field label={t('tpl.name')} htmlFor="tpl-name">
                <TextInput
                  id="tpl-name"

                  value={draft.name ?? ''}
                  maxLength={LIMITS.nameMax}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label={t('tpl.layout')}>
                <Select
                  aria-label={t('tpl.layout')}
                  value={draft.layout ?? 'text-only'}
                  onChange={(v) => patch({ layout: v })}
                  options={LAYOUTS.map((l) => ({ value: l, label: t(`tpl.layouts.${l}`) }))}
                />
              </Field>
            </div>
            <Field label={t('tpl.header')} hint={t('tpl.headerHint')} htmlFor="tpl-header">
              <TextInput
                id="tpl-header"

                value={draft.header ?? ''}
                maxLength={LIMITS.headerMax}
                placeholder={t('tpl.noHeader')}
                onChange={(e) => patch({ header: e.target.value || null })}
              />
            </Field>

            <div className="tpl__lines" role="list" aria-label={t('tpl.lines')}>
              {lines.map((line, i) => (
                <div className="tpl__line" role="listitem" key={`${line.source}-${i}`}>
                  <Checkbox
                    checked={line.enabled !== false}
                    onChange={(on) =>
                      setLines(lines.map((l, j) => (j === i ? { ...l, enabled: on } : l)))
                    }
                    label={t('tpl.lineEnabled')}
                  />
                  <Select<string>
                    aria-label={t('tpl.lineSource')}
                    value={line.source}
                    onChange={(v) =>
                      setLines(
                        lines.map((l, j) =>
                          j === i ? { ...l, source: v as TemplateLine['source'] } : l,
                        ),
                      )
                    }
                    options={LINE_SOURCES.map((s) => ({ value: s, label: t(`tpl.sources.${s}`) }))}
                  />
                  <TextInput
                    aria-label={t('tpl.lineLabel')}
                    placeholder={t('tpl.lineLabel')}
                    value={line.label ?? ''}
                    maxLength={60}
                    onChange={(e) =>
                      setLines(lines.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))
                    }
                  />
                  <TextInput
                    aria-label={line.source === 'custom' ? t('tpl.customText') : t('tpl.lineText')}
                    placeholder={
                      line.source === 'custom' ? t('tpl.customText') : t('tpl.lineTextHint')
                    }
                    value={line.text ?? ''}
                    maxLength={500}
                    onChange={(e) =>
                      setLines(lines.map((l, j) => (j === i ? { ...l, text: e.target.value } : l)))
                    }
                  />
                  <IconButton
                    label={t('tpl.moveUp')}
                    icon={<ChevronUp size={14} />}
                    disabled={i === 0}
                    onClick={() => moveTo(i, i - 1)}
                  />
                  <IconButton
                    label={t('tpl.moveDown')}
                    icon={<ChevronDown size={14} />}
                    disabled={i === lines.length - 1}
                    onClick={() => moveTo(i, i + 1)}
                  />
                  <IconButton
                    label={t('tpl.removeLine')}
                    icon={<Trash2 size={14} />}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
            </div>
            <div className="tpl__add-line">
              <Button
                icon={<Plus size={14} />}
                disabled={lines.length >= MAX_TEMPLATE_LINES}
                onClick={() => setLines([...lines, newLine('signerName')])}
              >
                {t('tpl.addLine')}
              </Button>
            </div>
          </fieldset>

          <fieldset className="tpl__group">
            <legend>{t('tpl.group.date')}</legend>
            <Field label={t('tpl.dateFormat')} hint={t('tpl.dateFormatHint')} htmlFor="tpl-date">
              <TextInput
                id="tpl-date"

                value={draft.dateFormat ?? ''}
                maxLength={LIMITS.dateFormatMax}
                onChange={(e) => patch({ dateFormat: e.target.value || 'dd/MM/yyyy HH:mm:ss' })}
              />
            </Field>
            <Switch
              checked={!!draft.showTimezone}
              onChange={(on) => patch({ showTimezone: on })}
              label={t('tpl.showTimezone')}
            />
          </fieldset>

          <fieldset className="tpl__group">
            <legend>{t('tpl.group.text')}</legend>
            <div className="tpl__row tpl__row--4">
              <NumberField
                label={t('tpl.fontSize')}
                value={draft.fontSize ?? 9}
                range={LIMITS.fontSize}
                onCommit={(v) => patch({ fontSize: v })}
              />
              <NumberField
                label={t('tpl.minFontSize')}
                value={draft.minFontSize ?? 5}
                range={[
                  LIMITS.minFontSize[0],
                  Math.min(LIMITS.minFontSize[1], draft.fontSize ?? 9),
                ]}
                onCommit={(v) => patch({ minFontSize: v })}
              />
              <NumberField
                label={t('tpl.padding')}
                value={draft.padding ?? 4}
                range={LIMITS.padding}
                step={1}
                onCommit={(v) => patch({ padding: v })}
              />
              <Field label={t('tpl.textColor')}>
                <input
                  type="color"
                  className="tpl__color"
                  aria-label={t('tpl.textColor')}
                  value={(draft.textColor ?? '#000000').toLowerCase()}
                  onChange={(e) => patch({ textColor: e.target.value.toUpperCase() })}
                />
              </Field>
            </div>
            <div className="tpl__row">
              <Field label={t('tpl.align')}>
                <Segmented
                  aria-label={t('tpl.align')}
                  value={draft.align ?? 'left'}
                  onChange={(v) => patch({ align: v })}
                  options={ALIGNS.map((a) => ({ value: a, label: t(`tpl.aligns.${a}`) }))}
                />
              </Field>
              <Field label={t('tpl.valign')}>
                <Segmented
                  aria-label={t('tpl.valign')}
                  value={draft.valign ?? 'middle'}
                  onChange={(v) => patch({ valign: v })}
                  options={VALIGNS.map((a) => ({ value: a, label: t(`tpl.valigns.${a}`) }))}
                />
              </Field>
            </div>
            <div className="tpl__row">
              <Switch
                checked={draft.autoShrink ?? true}
                onChange={(on) => patch({ autoShrink: on })}
                label={t('tpl.autoShrink')}
              />
              <Switch
                checked={!!draft.bold}
                onChange={(on) => patch({ bold: on })}
                label={t('tpl.bold')}
              />
            </div>
          </fieldset>

          <fieldset className="tpl__group">
            <legend>{t('tpl.group.box')}</legend>
            <div className="tpl__row">
              <Switch
                checked={draft.border !== null && draft.border !== undefined}
                onChange={(on) => patch({ border: on ? { color: '#1F3A93', width: 0.8 } : null })}
                label={t('tpl.border')}
              />
              {draft.border && (
                <>
                  <input
                    type="color"
                    className="tpl__color"
                    aria-label={t('tpl.borderColor')}
                    value={draft.border.color?.toLowerCase() ?? '#1f3a93'}
                    onChange={(e) =>
                      patch({ border: { ...draft.border!, color: e.target.value.toUpperCase() } })
                    }
                  />
                  <NumberField
                    label={t('tpl.borderWidth')}
                    value={draft.border.width ?? 0.8}
                    range={LIMITS.borderWidth}
                    step={0.1}
                    onCommit={(v) => patch({ border: { ...draft.border!, width: v } })}
                  />
                </>
              )}
            </div>
            <div className="tpl__row">
              <Field label={t('tpl.background')}>
                <input
                  type="color"
                  className="tpl__color"
                  aria-label={t('tpl.background')}
                  value={draft.background?.color?.toLowerCase() ?? '#ffffff'}
                  onChange={(e) =>
                    patch({
                      background: {
                        color: e.target.value.toUpperCase(),
                        opacity: draft.background?.opacity ?? 0,
                      },
                    })
                  }
                />
              </Field>
              <NumberField
                label={t('tpl.backgroundOpacity')}
                value={draft.background?.opacity ?? 0}
                range={LIMITS.opacity}
                step={0.05}
                onCommit={(v) =>
                  patch({ background: { color: draft.background?.color ?? '#FFFFFF', opacity: v } })
                }
              />
            </div>
            <div className="tpl__row">
              <Checkbox
                checked={!!draft.checkmark}
                onChange={(on) => patch({ checkmark: on })}
                label={t('tpl.checkmark')}
              />
              {draft.checkmark && (
                <input
                  type="color"
                  className="tpl__color"
                  aria-label={t('tpl.checkColor')}
                  value={draft.checkColor?.toLowerCase() ?? '#1e8e3e'}
                  onChange={(e) => patch({ checkColor: e.target.value.toUpperCase() })}
                />
              )}
            </div>
          </fieldset>

          <fieldset className="tpl__group">
            <legend>{t('tpl.group.images')}</legend>
            <div className="tpl__row">
              <Field label={t('tpl.image')}>
                <Select
                  aria-label={t('tpl.image')}
                  value={refs.image ?? ''}
                  onChange={(v) => {
                    setRefs((r) => ({ ...r, image: v || undefined }));
                    setDirty(true);
                    void materialize('image', v || undefined);
                  }}
                  options={slotOptions}
                />
              </Field>
              <Field label={t('tpl.logo')}>
                <Select
                  aria-label={t('tpl.logo')}
                  value={refs.logo ?? ''}
                  onChange={(v) => {
                    setRefs((r) => ({ ...r, logo: v || undefined }));
                    setDirty(true);
                    void materialize('logo', v || undefined);
                  }}
                  options={slotOptions}
                />
              </Field>
            </div>
            {library.length === 0 && <p className="tpl__muted">{t('tpl.libraryEmpty')}</p>}
            <NumberField
              label={t('tpl.imageRatio')}
              value={draft.imageRatio ?? 0.35}
              range={LIMITS.imageRatio}
              step={0.05}
              onCommit={(v) => patch({ imageRatio: v })}
            />
            {draft.image && (
              <div className="tpl__row">
                <Field label={t('tpl.fit')}>
                  <Segmented
                    aria-label={t('tpl.fit')}
                    value={draft.image.fit ?? 'contain'}
                    onChange={(v) => patch({ image: { ...draft.image!, fit: v } })}
                    options={FITS.map((f) => ({ value: f, label: t(`tpl.fits.${f}`) }))}
                  />
                </Field>
              </div>
            )}
          </fieldset>
        </div>

        {/* (3) data sources and preview */}
        <aside className="tpl__side">
          <Segmented<Source>
            aria-label={t('tpl.dataSource')}
            value={source}
            onChange={setSource}
            options={[
              { value: 'sample', label: t('tpl.sourceSample') },
              { value: 'cert', label: t('tpl.sourceCert'), icon: <KeyRound size={14} /> },
            ]}
          />

          {source === 'cert' && (
            <div className="tpl__source">
              {knownPfx.length > 0 && (
                <ul className="tpl__known">
                  {knownPfx.map((k) => (
                    <li key={k.path}>
                      <button
                        type="button"
                        className="tpl__item"
                        onClick={() => void openKnown(k.path, !!k.remembered)}
                        disabled={busy}
                      >
                        {k.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                icon={<FolderOpen size={14} />}
                onClick={() => void pickPfx()}
                disabled={busy}
              >
                {t('tpl.pickPfx')}
              </Button>
              {pfxPath && <p className="tpl__muted">{fileNameOf(pfxPath)}</p>}
              {pfxPath && (
                <div className="tpl__row">
                  <TextInput
                    type="password"
                    aria-label={t('tpl.pfxPassword')}
                    value={password}
                    autoComplete="off"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    disabled={busy}
                    onClick={() => void readCert(pfxPath, password || undefined, false)}
                  >
                    {t('tpl.readCert')}
                  </Button>
                </div>
              )}
              {cert && (
                <>
                  <p className="tpl__muted">
                    {t('tpl.usingCert', { name: values.signerName })}
                    {bound &&
                      bound.id !== selectedId &&
                      ` · ${t('tpl.boundElsewhere', { name: bound.name })}`}
                  </p>
                  <Checkbox
                    checked={isBoundHere}
                    onChange={(on) => void bindToCert(on)}
                    label={t('tpl.bindCert')}
                    hint={t('tpl.bindHint')}
                  />
                </>
              )}
            </div>
          )}

          <TemplatePreview template={draft} rows={rows} />
          <p className="tpl__muted">{t('tpl.previewNote')}</p>

          {proofOk && (
            <Button loading={busy} onClick={() => void proof()}>
              {t('tpl.proof')}
            </Button>
          )}
          {proofImage && <img className="tpl__proof" src={proofImage} alt={t('tpl.proofAlt')} />}
          {!proofOk && <p className="tpl__muted">{t('tpl.proofNotAvailable')}</p>}
        </aside>
      </div>
    </Dialog>
  );
}
