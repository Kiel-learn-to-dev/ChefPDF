/**
 * "Ký tài liệu" (T3.12 / T3.13 sign dialog): one task dialog with the sections signer, template,
 * level, placement and the sign button. Signing runs sign.pades or sign.padesToken through
 * runDocOp (progress in the job panel), then the post-sign actions (I32).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileSignature, PenLine } from 'lucide-react';
import type { SignTemplateEntry, SignatureTemplate } from '@chef/contracts';
import { useActiveDoc, type DocTab } from '../../app/state/documents';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { askPassword, confirmDialog } from '../../app/prompts';
import { errorMessage, runDocOp, saveDoc, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Field, Select, TextInput } from '../../components/Form';
import { toast } from '../../components/Toast';
import { toChefError } from '../../lib/errors';
import { i18n } from '../../i18n';
import { fromWire } from '../signTemplate/templateModel';
import { TemplatePreview } from '../signTemplate/TemplatePreview';
import { SAMPLE_VALUES, renderRows } from '../signTemplate/sampleData';
import { boundTemplate } from '../signTemplate/templateList';
import {
  validateAnchorForm,
  validateFixedForm,
  type AnchorForm,
  type FixedForm,
} from './anchorModel';
import {
  fixedBox,
  listEmptyFields,
  materializeTemplate,
  previewAnchors,
  rememberAnchorText,
  showSignaturesPanel,
  type FieldInfo,
  type MaterializedTemplate,
} from './signActions';
import { SignerSection, type SignerHandle, type SignerReady } from './SignerSection';
import { placementOf, usePlacementOf, usePlacementStore, type PlacedBox } from './placementStore';
import { useSignDraft, type PlacementMode } from './signDraft';
import {
  buildSignRequest,
  SignRequestError,
  type ResolvedPlacement,
  type SignOptionsDraft,
  type SignerChoice,
  type SignRequest,
} from './signRequest';
import { cleanTsaUrls } from './tsa';
import { readSignPrefs } from './signPrefs';
import './sign.css';

const LEVELS = ['B-B', 'B-T', 'B-LT', 'B-LTA'] as const;
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
const POSITIONS = ['below', 'above', 'left', 'right', 'over'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;
const MODES: PlacementMode[] = ['invisible', 'draw', 'field', 'anchor', 'fixed'];

/** The suggested output name (I32): "<name>_da-ky.pdf". */
export function suggestedName(docName: string): string {
  const stem = docName.replace(/\.pdf$/i, '') || 'document';
  return `${stem}_da-ky.pdf`;
}

export function SignDocDialog() {
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  if (!doc) return null;
  return <SignDocInner doc={doc} onClose={close} />;
}

function SignDocInner({ doc, onClose }: { doc: DocTab; onClose(): void }) {
  const { t } = useTranslation();
  const docId = doc.id;
  const templates = useSettings((s) => s.settings.signTemplates);
  const tsaSettings = useSettings((s) => s.settings.tsaUrls);
  const prefs = useSettings((s) => s.settings.prefs);
  const { draft, patch } = useSignDraft();
  const { placement: boxNow, previews, selected } = usePlacementOf(docId);
  const signerRef = useRef<SignerHandle>(null);
  const [ready, setReady] = useState<SignerReady>({
    choice: null,
    fingerprint: null,
    finalTry: false,
    label: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [previewInfo, setPreviewInfo] = useState<string | null>(null);
  const [busyAnchor, setBusyAnchor] = useState(false);

  const bound = boundTemplate(templates, ready.fingerprint);
  const templateId = draft.templateId === undefined ? (bound?.id ?? null) : draft.templateId;
  const entry: SignTemplateEntry | undefined = templates.find((e) => e.id === templateId);
  const tsa = cleanTsaUrls(tsaSettings).urls;
  const needsTsa = draft.level !== 'B-B' && tsa.length === 0;

  // The field list of the "field" mode is loaded when the mode is chosen.
  useEffect(() => {
    if (draft.placementMode !== 'field') return;
    let alive = true;
    listEmptyFields(docId)
      .then((list) => alive && setFields(list))
      .catch((e: unknown) => alive && setProblem(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [draft.placementMode, docId]);

  // The fixed corner is recomputed whenever its form changes.
  useEffect(() => {
    if (draft.placementMode !== 'fixed' || validateFixedForm(draft.fixedForm)) return;
    const box = fixedBox(docId, draft.fixedForm);
    if (box) usePlacementStore.getState().setPlacement(docId, box);
  }, [draft.placementMode, draft.fixedForm, docId]);

  const setMode = (mode: PlacementMode) => {
    patch({ placementMode: mode });
    setPreviewInfo(null);
    setProblem(null);
    const store = usePlacementStore.getState();
    if (mode === 'invisible') store.setPlacement(docId, null);
    if (mode !== 'anchor') store.setPreviews(docId, []);
    if (mode === 'fixed') store.setPlacement(docId, null);
  };

  const drawOnPage = () => {
    usePlacementStore.getState().startPlacing(docId);
    onClose();
  };

  async function runPreview() {
    const bad = validateAnchorForm(draft.anchorForm);
    if (bad) {
      setProblem(t('sign.anchor.invalid', { field: t(`sign.anchor.field.${bad.field}`) }));
      return;
    }
    setBusyAnchor(true);
    setProblem(null);
    const store = usePlacementStore.getState();
    try {
      const r = await previewAnchors(docId, draft.anchorForm);
      store.setPreviews(docId, r.previews);
      if (r.found === 0) {
        setPreviewInfo(t('sign.anchor.notFound'));
        // onMissing: skip / fail leave no box; fallback-fixed puts the box at the bottom right.
        const fallback =
          draft.anchorForm.onMissing === 'fallback-fixed'
            ? fixedBox(docId, {
                corner: 'bottom-right',
                widthMm: draft.anchorForm.widthMm,
                heightMm: draft.anchorForm.heightMm,
                marginPt: 36,
                page: 'last',
              })
            : null;
        store.setPlacement(docId, fallback);
      } else {
        setPreviewInfo(
          t('sign.anchor.found', { count: r.found }) +
            (r.truncated ? ` ${t('sign.anchor.truncated')}` : ''),
        );
        store.selectPreview(docId, 0);
      }
      void rememberAnchorText(draft.anchorForm.text, readSignPrefs(prefsNow()).anchors);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusyAnchor(false);
    }
  }

  /** Where the visible box goes now: null (invisible), a placement, or 'missing'. */
  function currentPlacement(): PlacedBox | null | 'missing' {
    if (draft.placementMode === 'invisible') return null;
    return placementOf(docId).placement ?? 'missing';
  }

  async function sign(confirmedFinal = false): Promise<void> {
    const signer = ready.choice;
    if (!signer) return setProblem(t('sign.errors.noSigner'));
    const where = currentPlacement();
    if (where === 'missing') {
      return setProblem(
        t(draft.placementMode === 'anchor' ? 'sign.errors.noAnchor' : 'sign.errors.noBox'),
      );
    }
    if (ready.finalTry && signer.kind === 'token' && !confirmedFinal) {
      const answer = await confirmFinalTryDialog();
      if (answer) return sign(true);
      return;
    }
    let materialized: MaterializedTemplate | null = null;
    try {
      if (entry) materialized = await materializeTemplate(entry);
      const options: SignOptionsDraft = {
        level: draft.level,
        digest: draft.digest,
        tsaUrls: tsa,
        reason: draft.reason,
        location: draft.location,
        contact: draft.contact,
        certify: draft.certify,
        ...(materialized ? { template: materialized.template as SignatureTemplate } : {}),
      };
      const resolved = toResolved(where);
      const first = buildSignRequest(
        confirmedFinal && signer.kind === 'token' ? { ...signer, confirmFinalTry: true } : signer,
        options,
        resolved,
      );
      setSigning(true);
      await runSigning(first, signer, options, resolved);
    } catch (e) {
      setProblem(e instanceof SignRequestError ? t(`sign.errors.${e.code}`) : errorMessage(e));
    } finally {
      setSigning(false);
      signerRef.current?.clearSecrets();
      await materialized?.release();
    }
  }

  /**
   * Runs the op. A missing or wrong certificate password is asked again; a PIN is never retried
   * by the app: a wrong PIN stops here and the user types it again.
   */
  async function runSigning(
    first: SignRequest,
    signer: SignerChoice,
    options: SignOptionsDraft,
    resolved: ResolvedPlacement | null,
  ): Promise<void> {
    let req = first;
    let current = signer;
    for (;;) {
      let failure: ReturnType<typeof toChefError> | null = null;
      const result = await runDocOp(docId, req.opId, req.params as never, t('sign.job'), {
        onError(e) {
          failure = toChefError(e);
          return true;
        },
      });
      if (result) {
        onSigned(docId, doc.name);
        onClose();
        return;
      }
      const err = failure as ReturnType<typeof toChefError> | null;
      if (!err) return;
      if (
        current.kind === 'pfx' &&
        (err.kind === 'PASSWORD_REQUIRED' ||
          err.kind === 'PASSWORD_INVALID' ||
          err.kind === 'SIGN_BAD_PASSWORD')
      ) {
        const name = current.pfxPath.split(/[\\/]/).pop() ?? current.pfxPath;
        const answer = await askPassword(name, err.kind !== 'PASSWORD_REQUIRED');
        if (answer === null) return;
        current = { ...current, password: answer };
        req = buildSignRequest(current, options, resolved);
        continue;
      }
      if (current.kind === 'token' && err.kind === 'TOKEN_PIN_CONFIRM_REQUIRED') {
        if (!(await confirmFinalTryDialog())) return;
        current = { ...current, confirmFinalTry: true };
        req = buildSignRequest(current, options, resolved);
        continue;
      }
      if (
        current.kind === 'token' &&
        (err.kind === 'TOKEN_PIN_INVALID' || err.kind === 'TOKEN_PIN_LOCKED')
      ) {
        setProblem(errorMessage(err));
        return;
      }
      showError(err, t('sign.failed'));
      return;
    }
  }

  const anchorReady = draft.placementMode !== 'anchor' || previews.length > 0;
  const placed = draft.placementMode === 'invisible' || boxNow !== null;
  const canSign = !signing && !!ready.choice && !needsTsa && placed && anchorReady;

  return (
    <Dialog
      open
      modalLock={signing}
      onOpenChange={(o) => {
        if (!o && !signing) onClose();
      }}
      icon={<FileSignature size={18} />}
      title={t('sign.doc.title')}
      description={t('sign.doc.description', { name: doc.name })}
      size="lg"
      footer={
        <>
          <p className="sign-note" data-testid="sign-name-hint">
            {t('sign.doc.nameHint', { name: suggestedName(doc.name) })}
          </p>
          <DialogSpacer />
          <Button onClick={onClose} disabled={signing}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={signing}
            disabled={!canSign}
            onClick={() => void sign()}
          >
            {t('sign.doc.sign')}
          </Button>
        </>
      }
    >
      <SignerSection ref={signerRef} onReady={setReady} onProblem={setProblem} />

      <section className="sign-section" aria-labelledby="sign-template-title">
        <h3 id="sign-template-title" className="sign-section__title">
          {t('sign.template.title')}
        </h3>
        <Select
          aria-label={t('sign.template.title')}
          value={templateId ?? ''}
          options={[
            { value: '', label: t('sign.template.none') },
            ...templates.map((e) => ({
              value: e.id,
              label:
                ready.fingerprint && e.certFingerprint === ready.fingerprint
                  ? `${e.name} · ${t('sign.template.bound')}`
                  : e.name,
            })),
          ]}
          onChange={(v) => patch({ templateId: v || null })}
        />
        {entry ? (
          <TemplatePreview
            template={fromWire(entry.template)}
            rows={renderRows(fromWire(entry.template), SAMPLE_VALUES)}
          />
        ) : (
          <p className="sign-note">{t('sign.template.noneHint')}</p>
        )}
      </section>

      <section className="sign-section" aria-labelledby="sign-level-title">
        <h3 id="sign-level-title" className="sign-section__title">
          {t('sign.level.title')}
        </h3>
        <div className="sign-row" role="group" aria-label={t('sign.level.title')}>
          {LEVELS.map((lv) => (
            <Button
              key={lv}
              size="sm"
              variant={draft.level === lv ? 'primary' : 'secondary'}
              aria-pressed={draft.level === lv}
              onClick={() => patch({ level: lv })}
            >
              {lv}
            </Button>
          ))}
        </div>
        <p className="sign-note">{t(`sign.level.${LEVEL_KEY[draft.level]}`)}</p>
        {needsTsa ? (
          <p className="sign-note sign-note--warn">{t('sign.level.needTsa')}</p>
        ) : (
          draft.level !== 'B-B' && (
            <p className="sign-note">{t('sign.level.tsaCount', { count: tsa.length })}</p>
          )
        )}
        <div className="sign-grid">
          <Field label={t('sign.level.digest')}>
            <Select
              aria-label={t('sign.level.digest')}
              value={draft.digest}
              options={[
                { value: 'sha256', label: 'SHA-256' },
                { value: 'sha384', label: 'SHA-384' },
                { value: 'sha512', label: 'SHA-512' },
              ]}
              onChange={(v) => patch({ digest: v })}
            />
          </Field>
          <Field label={t('sign.certify.title')}>
            <Select
              aria-label={t('sign.certify.title')}
              value={draft.certify}
              options={[
                { value: 'none', label: t('sign.certify.none') },
                { value: 'no-changes', label: t('sign.certify.noChanges') },
                { value: 'form-fill', label: t('sign.certify.formFill') },
                { value: 'annotate', label: t('sign.certify.annotate') },
              ]}
              onChange={(v) => patch({ certify: v })}
            />
          </Field>
        </div>
        {draft.certify !== 'none' && (
          <p className="sign-note sign-note--warn">{t('sign.certify.warning')}</p>
        )}
        <div className="sign-grid">
          <Field label={t('sign.level.reason')}>
            <TextInput value={draft.reason} onChange={(e) => patch({ reason: e.target.value })} />
          </Field>
          <Field label={t('sign.level.location')}>
            <TextInput
              value={draft.location}
              onChange={(e) => patch({ location: e.target.value })}
            />
          </Field>
          <Field label={t('sign.level.contact')}>
            <TextInput value={draft.contact} onChange={(e) => patch({ contact: e.target.value })} />
          </Field>
        </div>
      </section>

      <section className="sign-section" aria-labelledby="sign-place-title">
        <h3 id="sign-place-title" className="sign-section__title">
          {t('sign.place.sectionTitle')}
        </h3>
        <div className="sign-row" role="group" aria-label={t('sign.place.sectionTitle')}>
          {MODES.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={draft.placementMode === m ? 'primary' : 'secondary'}
              aria-pressed={draft.placementMode === m}
              onClick={() => setMode(m)}
            >
              {t(`sign.place.mode.${m}`)}
            </Button>
          ))}
        </div>

        {draft.placementMode === 'invisible' && (
          <p className="sign-note">{t('sign.place.invisibleHint')}</p>
        )}

        {draft.placementMode === 'draw' && (
          <div className="sign-row">
            <Button icon={<PenLine size={15} />} onClick={drawOnPage}>
              {t('sign.place.drawOnPage')}
            </Button>
            <span className="sign-note">
              {boxNow
                ? t('sign.place.current', { page: boxNow.pageIndex + 1 })
                : t('sign.place.noBox')}
            </span>
          </div>
        )}

        {draft.placementMode === 'field' && (
          <>
            {fields !== null && fields.length === 0 && (
              <p className="sign-note">{t('sign.place.noFields')}</p>
            )}
            {fields !== null && fields.length > 0 && (
              <ul className="sign-field-list" aria-label={t('sign.place.fieldsTitle')}>
                {fields.map((f) => (
                  <li key={f.fieldName}>
                    <Button
                      size="sm"
                      variant={boxNow?.fieldName === f.fieldName ? 'primary' : 'secondary'}
                      aria-pressed={boxNow?.fieldName === f.fieldName}
                      onClick={() => chooseField(docId, f)}
                    >
                      {f.fieldName} · {t('sign.place.pageOf', { page: f.page + 1 })}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="sign-row">
              <Button size="sm" onClick={drawOnPage}>
                {t('sign.place.addEmptyDraw')}
              </Button>
            </div>
          </>
        )}

        {draft.placementMode === 'anchor' && (
          <AnchorFields
            form={draft.anchorForm}
            recent={readSignPrefs(prefs).anchors}
            onChange={(f) => patch({ anchorForm: f })}
            onPreview={() => void runPreview()}
            busy={busyAnchor}
            info={previewInfo}
            count={previews.length}
            selected={selected}
            onChoose={(i) => usePlacementStore.getState().selectPreview(docId, i)}
          />
        )}

        {draft.placementMode === 'fixed' && (
          <FixedFields form={draft.fixedForm} onChange={(f) => patch({ fixedForm: f })} />
        )}
      </section>

      {problem && (
        <p className="sign-note sign-note--danger" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

function prefsNow(): Record<string, unknown> {
  return useSettings.getState().settings.prefs;
}

const LEVEL_KEY: Record<SignLevelName, string> = {
  'B-B': 'bb',
  'B-T': 'bt',
  'B-LT': 'blt',
  'B-LTA': 'blta',
};
type SignLevelName = (typeof LEVELS)[number];

function toResolved(where: PlacedBox | null | 'missing'): ResolvedPlacement | null {
  if (!where || where === 'missing') return null;
  return {
    page: where.pageIndex,
    rect: where.rect,
    ...(where.fieldName ? { fieldName: where.fieldName } : {}),
  };
}

/** Asks before using the PIN when the token has one try left. True when the user agrees. */
async function confirmFinalTryDialog(): Promise<boolean> {
  const answer = await confirmDialog({
    title: i18n.t('sign.confirmFinal.title'),
    message: i18n.t('sign.confirmFinal.message'),
    tone: 'danger',
    actions: [
      { id: 'cancel', label: i18n.t('common.cancel'), variant: 'ghost' },
      { id: 'go', label: i18n.t('sign.confirmFinal.go'), variant: 'danger' },
    ],
  });
  return answer === 'go';
}

function chooseField(docId: string, f: FieldInfo) {
  if (!f.rect) return;
  const [x1, y1, x2, y2] = f.rect as [number, number, number, number];
  usePlacementStore.getState().setPlacement(docId, {
    pageIndex: f.page,
    rect: [x1, y1, x2, y2],
    fieldName: f.fieldName,
    source: 'field',
  });
}

/** After a successful signature: the signature panel shows it and is verified; save is offered (I32). */
function onSigned(docId: string, docName: string) {
  const name = suggestedName(docName);
  showSignaturesPanel();
  toast.success(i18n.t('sign.done.title'), i18n.t('sign.done.text', { name }), [
    { label: i18n.t('sign.done.viewSignatures'), onClick: () => showSignaturesPanel() },
    { label: i18n.t('sign.done.saveAs'), onClick: () => void saveDoc(docId, true) },
  ]);
}

// ---------- placement sub-forms ----------

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange(v: number): void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <TextInput
        size="sm"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </Field>
  );
}

function AnchorFields({
  form,
  recent,
  onChange,
  onPreview,
  busy,
  info,
  count,
  selected,
  onChoose,
}: {
  form: AnchorForm;
  recent: readonly string[];
  onChange(f: AnchorForm): void;
  onPreview(): void;
  busy: boolean;
  info: string | null;
  count: number;
  selected: number;
  onChoose(i: number): void;
}) {
  const { t } = useTranslation();
  const set = (p: Partial<AnchorForm>) => onChange({ ...form, ...p });
  return (
    <>
      <div className="sign-grid">
        <Field label={t('sign.anchor.text')} htmlFor="sign-anchor-text">
          <TextInput
            id="sign-anchor-text"
            value={form.text}
            placeholder={t('sign.anchor.placeholder')}
            onChange={(e) => set({ text: e.target.value })}
          />
        </Field>
        <Field label={t('sign.anchor.position')}>
          <Select
            aria-label={t('sign.anchor.position')}
            value={form.position}
            options={POSITIONS.map((p) => ({ value: p, label: t(`sign.anchor.pos.${p}`) }))}
            onChange={(v) => set({ position: v })}
          />
        </Field>
        <NumberInput
          label={t('sign.anchor.widthMm')}
          value={form.widthMm}
          min={2}
          max={300}
          step={0.5}
          onChange={(v) => set({ widthMm: v })}
        />
        <NumberInput
          label={t('sign.anchor.heightMm')}
          value={form.heightMm}
          min={2}
          max={300}
          step={0.5}
          onChange={(v) => set({ heightMm: v })}
        />
        <NumberInput
          label={t('sign.anchor.offsetX')}
          value={form.offsetXPt}
          min={-500}
          max={500}
          onChange={(v) => set({ offsetXPt: v })}
        />
        <NumberInput
          label={t('sign.anchor.offsetY')}
          value={form.offsetYPt}
          min={-500}
          max={500}
          onChange={(v) => set({ offsetYPt: v })}
        />
        <Field label={t('sign.anchor.align')}>
          <Select
            aria-label={t('sign.anchor.align')}
            value={form.align}
            options={ALIGNS.map((a) => ({ value: a, label: t(`sign.anchor.al.${a}`) }))}
            onChange={(v) => set({ align: v })}
          />
        </Field>
        <Field label={t('sign.anchor.which')}>
          <Select
            aria-label={t('sign.anchor.which')}
            value={form.whichMatch}
            options={[
              { value: 'first', label: t('sign.anchor.w.first') },
              { value: 'last', label: t('sign.anchor.w.last') },
              { value: 'all', label: t('sign.anchor.w.all') },
            ]}
            onChange={(v) => set({ whichMatch: v })}
          />
        </Field>
        <Field label={t('sign.anchor.onMissing')}>
          <Select
            aria-label={t('sign.anchor.onMissing')}
            value={form.onMissing}
            options={[
              { value: 'skip', label: t('sign.anchor.m.skip') },
              { value: 'fail', label: t('sign.anchor.m.fail') },
              { value: 'fallback-fixed', label: t('sign.anchor.m.fallback') },
            ]}
            onChange={(v) => set({ onMissing: v })}
          />
        </Field>
      </div>
      {recent.length > 0 && (
        <div className="sign-row">
          <span className="sign-note">{t('sign.anchor.recent')}</span>
          {recent.map((r) => (
            <Button key={r} size="sm" onClick={() => set({ text: r })}>
              {r}
            </Button>
          ))}
        </div>
      )}
      <div className="sign-row">
        <label className="sign-aspect">
          <input
            type="checkbox"
            checked={form.ignoreDiacritics}
            onChange={(e) => set({ ignoreDiacritics: e.target.checked })}
          />
          <span>{t('sign.anchor.ignoreDiacritics')}</span>
        </label>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!form.text.trim()}
          onClick={onPreview}
        >
          {t('sign.anchor.preview')}
        </Button>
      </div>
      {info && <p className="sign-note">{info}</p>}
      {count > 1 && (
        <Select
          aria-label={t('sign.anchor.chooseMatch')}
          value={String(selected)}
          options={Array.from({ length: count }, (_, i) => ({
            value: String(i),
            label: t('sign.anchor.matchN', { n: i + 1 }),
          }))}
          onChange={(v) => onChoose(Number(v))}
        />
      )}
      {form.whichMatch === 'all' && <p className="sign-note">{t('sign.anchor.allNote')}</p>}
    </>
  );
}

function FixedFields({ form, onChange }: { form: FixedForm; onChange(f: FixedForm): void }) {
  const { t } = useTranslation();
  const set = (p: Partial<FixedForm>) => onChange({ ...form, ...p });
  return (
    <div className="sign-grid">
      <Field label={t('sign.fixed.corner')}>
        <Select
          aria-label={t('sign.fixed.corner')}
          value={form.corner}
          options={CORNERS.map((c) => ({ value: c, label: t(`sign.fixed.c.${c}`) }))}
          onChange={(v) => set({ corner: v })}
        />
      </Field>
      <Field label={t('sign.fixed.page')}>
        <Select
          aria-label={t('sign.fixed.page')}
          value={form.page === 'first' ? 'first' : 'last'}
          options={[
            { value: 'first', label: t('sign.fixed.p.first') },
            { value: 'last', label: t('sign.fixed.p.last') },
          ]}
          onChange={(v) => set({ page: v === 'first' ? 'first' : 'last' })}
        />
      </Field>
      <NumberInput
        label={t('sign.anchor.widthMm')}
        value={form.widthMm}
        min={2}
        max={300}
        step={0.5}
        onChange={(v) => set({ widthMm: v })}
      />
      <NumberInput
        label={t('sign.anchor.heightMm')}
        value={form.heightMm}
        min={2}
        max={300}
        step={0.5}
        onChange={(v) => set({ heightMm: v })}
      />
      <NumberInput
        label={t('sign.fixed.margin')}
        value={form.marginPt}
        min={0}
        max={300}
        onChange={(v) => set({ marginPt: v })}
      />
    </div>
  );
}
