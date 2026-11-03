/**
 * "Liên kết" (D11, T7.05): the links of the document, with a click to go to the target, edit and
 * delete, "Thêm liên kết" (the rect is drawn on the page first, then the form opens) and "Tự nhận
 * diện liên kết" (links.autoDetect on every page). The form covers a URI or a page target, the
 * border, the colour and the highlight style.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp } from '../../app/actions';
import { runOp } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Field, Segmented, Select, TextInput } from '../../components/Form';
import { Dialog } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { ColorInput } from '../overlay/ColorInput';
import { getViewer } from '../viewer/controllers';
import { useLinkDraw } from './linkState';
import {
  DEFAULT_LINK_FORM,
  addLinkParams,
  autoDetectParams,
  formOf,
  groupLinksByPage,
  linkTargetText,
  updateLinkParams,
  validateLinkForm,
  type LinkForm,
  type LinkItem,
} from './linksModel';
import './links.css';

export function LinkDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const open = useUi((s) => s.dialog === 'linkDialog');
  const pending = useLinkDraw((s) => s.pending);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [editing, setEditing] = useState<LinkItem | null>(null);
  const [busy, setBusy] = useState(false);
  const docId = doc?.id ?? '';

  const load = async () => {
    if (!docId) return;
    const result = await runOp(
      'links.list',
      {},
      { sessionId: docId, title: t('links.title'), silent: true },
    );
    setLinks((result.data as { links: LinkItem[] }).links);
  };

  useEffect(() => {
    if (!open || pending || !docId) return;
    let cancelled = false;
    runOp('links.list', {}, { sessionId: docId, title: t('links.title'), silent: true })
      .then((result) => {
        if (!cancelled) setLinks((result.data as { links: LinkItem[] }).links);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending, docId]);

  if (!doc) return null;
  const blocked = doc.state.signed;
  const pageCount = doc.info.pages.length;
  const close = () => {
    useLinkDraw.getState().setPending(null);
    setEditing(null);
    useUi.getState().closeDialog();
  };
  const startDraw = () => {
    useUi.getState().closeDialog();
    useLinkDraw.getState().setDrawing(true);
  };

  const remove = async (link: LinkItem) => {
    const ok = await runDocOp(docId, 'links.remove', { ids: [link.id] }, t('links.op.remove'));
    if (ok) await load();
  };

  const detect = async () => {
    setBusy(true);
    const result = await runDocOp(
      docId,
      'links.autoDetect',
      autoDetectParams(),
      t('links.op.detect'),
    );
    setBusy(false);
    if (!result) return;
    const created = (result.data as { created?: number } | undefined)?.created ?? 0;
    toast.success(t('links.op.detect'), t('links.detected', { count: created }));
    await load();
  };

  const save = async (form: LinkForm) => {
    setBusy(true);
    const ok = pending
      ? await runDocOp(
          docId,
          'links.add',
          addLinkParams(pending.pageIndex, pending.rect, form),
          t('links.op.add'),
        )
      : editing
        ? await runDocOp(
            docId,
            'links.update',
            updateLinkParams(editing.id, form),
            t('links.op.update'),
          )
        : null;
    setBusy(false);
    if (ok) {
      useLinkDraw.getState().setPending(null);
      setEditing(null);
      await load();
    }
  };

  const showForm = pending !== null || editing !== null;
  const initial: LinkForm = editing ? formOf(editing) : DEFAULT_LINK_FORM;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && close()}
      title={t('links.title')}
      description={showForm ? t('links.formDesc') : t('links.desc')}
      icon={<Link2 size={18} />}
      size="lg"
      footer={
        showForm ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                useLinkDraw.getState().setPending(null);
                setEditing(null);
              }}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => void detect()} disabled={busy || blocked}>
              {t('links.detect')}
            </Button>
            <Button variant="primary" onClick={startDraw} disabled={blocked}>
              {t('links.add')}
            </Button>
          </>
        )
      }
    >
      {showForm ? (
        <LinkFormView
          key={`${pending ? 'new' : 'edit'}-${editing?.id ?? ''}`}
          initial={initial}
          pageCount={pageCount}
          busy={busy}
          onSave={(f) => void save(f)}
          isNew={pending !== null}
        />
      ) : links.length === 0 ? (
        <p className="ln-empty">{t('links.none')}</p>
      ) : (
        <div className="ln-list">
          {groupLinksByPage(links).map((g) => (
            <div key={g.pageIndex} className="ln-page">
              <div className="ln-page__title">{t('links.page', { page: g.pageIndex + 1 })}</div>
              {g.links.map((l) => {
                const target = linkTargetText(l);
                return (
                  <div key={l.id} className="ln-row">
                    <span className="ln-row__kind">
                      {target.kind === 'uri' ? t('links.kind.uri') : t('links.kind.page')}
                    </span>
                    <span className="ln-row__target">
                      {target.kind === 'page'
                        ? t('links.toPage', { page: target.text })
                        : target.text}
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() => getViewer(docId)?.goToPage(g.pageIndex + 1)}
                    >
                      {t('links.jump')}
                    </Button>
                    <Button variant="ghost" disabled={blocked} onClick={() => setEditing(l)}>
                      {t('links.edit')}
                    </Button>
                    <Button variant="ghost" disabled={blocked} onClick={() => void remove(l)}>
                      {t('links.delete')}
                    </Button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function LinkFormView({
  initial,
  pageCount,
  busy,
  isNew,
  onSave,
}: {
  initial: LinkForm;
  pageCount: number;
  busy: boolean;
  isNew: boolean;
  onSave(form: LinkForm): void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<LinkForm>(initial);
  const [tried, setTried] = useState(false);
  const set = <K extends keyof LinkForm>(k: K, v: LinkForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const err = validateLinkForm(form, pageCount);
  return (
    <div className="ln-form">
      <Field label={t('links.form.kind')}>
        <Segmented<LinkForm['kind']>
          aria-label={t('links.form.kind')}
          value={form.kind}
          onChange={(v) => set('kind', v)}
          options={[
            { value: 'uri', label: t('links.kind.uri') },
            { value: 'page', label: t('links.kind.page') },
          ]}
        />
      </Field>
      {form.kind === 'uri' ? (
        <Field
          label={t('links.form.uri')}
          htmlFor="ln-uri"
          error={tried && err === 'URI_REQUIRED' ? t('links.err.URI_REQUIRED') : undefined}
        >
          <TextInput
            id="ln-uri"
            value={form.uri}
            placeholder="https://… hoặc email@ten.vn"
            onChange={(e) => set('uri', e.target.value)}
            autoFocus={isNew}
          />
        </Field>
      ) : (
        <div className="ln-form__row">
          <Field
            label={t('links.form.page', { count: pageCount })}
            htmlFor="ln-page"
            error={tried && err === 'PAGE_INVALID' ? t('links.err.PAGE_INVALID') : undefined}
          >
            <TextInput
              id="ln-page"
              inputMode="numeric"
              value={form.targetPage}
              onChange={(e) => set('targetPage', e.target.value)}
            />
          </Field>
          <Field label={t('links.form.view')}>
            <Select<LinkForm['view']>
              aria-label={t('links.form.view')}
              value={form.view}
              onChange={(v) => set('view', v)}
              options={[
                { value: 'fit', label: t('links.view.fit') },
                { value: 'xyz', label: t('links.view.xyz') },
              ]}
            />
          </Field>
        </div>
      )}
      <div className="ln-form__row">
        <Field label={t('links.form.border')} htmlFor="ln-border">
          <TextInput
            id="ln-border"
            type="number"
            min={0}
            step={0.5}
            value={String(form.borderWidth)}
            onChange={(e) => set('borderWidth', Math.max(0, Number(e.target.value) || 0))}
          />
        </Field>
        <ColorInput
          id="ln-colour"
          label={t('links.form.colour')}
          value={form.color}
          onChange={(v) => set('color', v)}
        />
        <Field label={t('links.form.highlight')}>
          <Select<LinkForm['highlight']>
            aria-label={t('links.form.highlight')}
            value={form.highlight}
            onChange={(v) => set('highlight', v)}
            options={[
              { value: 'invert', label: t('links.highlight.invert') },
              { value: 'outline', label: t('links.highlight.outline') },
              { value: 'none', label: t('links.highlight.none') },
            ]}
          />
        </Field>
      </div>
      {tried && err && err !== 'URI_REQUIRED' && err !== 'PAGE_INVALID' && (
        <div className="ln-err" role="alert">
          {t(`links.err.${err}`)}
        </div>
      )}
      <div className="ln-form__actions">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            setTried(true);
            if (validateLinkForm(form, pageCount) === null) onSave(form);
          }}
        >
          {t('links.save')}
        </Button>
      </div>
    </div>
  );
}
