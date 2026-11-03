/**
 * "Tìm & thay thế" (D10, T7.04): finds a text over the document. The preview (text.findReplace with
 * preview on) lists the matches with their page, before and after, and draws their boxes on the
 * pages; a click on a match jumps to it. "Thay tất cả" runs the replacement as one revision (undo
 * through the session). The core has no per-match exclusion, so the scope is pages only.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Replace } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { textErrorCode } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Checkbox, Field, TextInput } from '../../components/Form';
import { Dialog } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { getViewer } from '../viewer/controllers';
import { useHighlight } from '../redact/highlight';
import { i18n } from '../../i18n';
import { textErrorText } from './textEditActions';
import {
  DEFAULT_FIND_FORM,
  buildFindParams,
  groupByPage,
  matchHighlights,
  summarize,
  validateForm,
  type FindForm,
  type FindMatch,
  type FindReplaceData,
} from './findReplaceModel';

export function FindReplaceDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const open = useUi((s) => s.dialog === 'findReplace');
  const close = () => {
    useHighlight.getState().clear();
    useUi.getState().closeDialog();
  };
  const [form, setForm] = useState<FindForm>(DEFAULT_FIND_FORM);
  const [preview, setPreview] = useState<FindReplaceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  if (!doc) return null;
  const pageCount = doc.info.pages.length;
  const set = <K extends keyof FindForm>(key: K, value: FindForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setPreview(null);
    useHighlight.getState().clear();
  };

  const check = (): boolean => {
    const err = validateForm(form, pageCount);
    setFormError(err ? t(`findReplace.err.${err}`) : null);
    return err === null;
  };

  const runPreview = async () => {
    if (!check()) return;
    setBusy(true);
    try {
      const result = await runOp('text.findReplace', buildFindParams(form, pageCount, true), {
        sessionId: doc.id,
        title: t('findReplace.title'),
        silent: true,
      });
      const data = result.data as FindReplaceData;
      setPreview(data);
      useHighlight.getState().show(doc.id, matchHighlights(data.matches));
      if (data.matches.length === 0) toast.info(t('findReplace.title'), t('findReplace.none'));
    } catch (e) {
      setFormError(textErrorText(e));
      if (textErrorCode(e) === null) showError(e);
    } finally {
      setBusy(false);
    }
  };

  const runAll = async () => {
    if (!check()) return;
    setBusy(true);
    const result = await runDocOp(
      doc.id,
      'text.findReplace',
      buildFindParams(form, pageCount, false),
      t('findReplace.title'),
      {
        toastWarnings: false,
        onError: (e) => {
          if (textErrorCode(e) === null) return false;
          setFormError(textErrorText(e));
          return true;
        },
      },
    );
    setBusy(false);
    if (!result) return;
    const s = summarize(result.data as FindReplaceData);
    toast.success(
      t('findReplace.title'),
      t('findReplace.done', { count: s.replaced, pages: s.pages.length }),
    );
    if (s.substitutions > 0) {
      toast.warning(
        t('findReplace.title'),
        t('findReplace.substituted', { count: s.substitutions, fonts: s.fonts.join(', ') }),
      );
    }
    close();
  };

  const groups = preview ? groupByPage(preview.matches) : [];
  const total = preview?.matches.length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && close()}
      title={t('findReplace.title')}
      description={t('findReplace.desc')}
      icon={<Replace size={18} />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.close')}
          </Button>
          <Button variant="secondary" onClick={() => void runPreview()} disabled={busy}>
            {t('findReplace.preview')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void runAll()}
            disabled={busy || doc.state.signed || !preview || total === 0}
            title={doc.state.signed ? t('overlay.signedBlocked') : undefined}
          >
            {t('findReplace.replaceAll')}
          </Button>
        </>
      }
    >
      <div className="fr-form">
        <Field label={t('findReplace.find')} htmlFor="fr-find">
          <TextInput
            id="fr-find"
            value={form.find}
            onChange={(e) => set('find', e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('findReplace.replace')} htmlFor="fr-replace">
          <TextInput
            id="fr-replace"
            value={form.replace}
            onChange={(e) => set('replace', e.target.value)}
          />
        </Field>
        <div className="fr-options">
          <Checkbox
            checked={form.caseSensitive}
            onChange={(v) => set('caseSensitive', v)}
            label={t('findReplace.opt.case')}
          />
          <Checkbox
            checked={form.ignoreDiacritics}
            onChange={(v) => set('ignoreDiacritics', v)}
            label={t('findReplace.opt.diacritics')}
          />
          <Checkbox
            checked={form.wholeWord}
            onChange={(v) => set('wholeWord', v)}
            label={t('findReplace.opt.word')}
          />
          <Checkbox
            checked={form.regex}
            onChange={(v) => set('regex', v)}
            label={t('findReplace.opt.regex')}
          />
        </div>
        <div className="fr-scope">
          <Checkbox
            checked={form.scope === 'pages'}
            onChange={(v) => set('scope', v ? 'pages' : 'all')}
            label={t('findReplace.scope.pages')}
            hint={t('findReplace.scope.hint')}
          />
          {form.scope === 'pages' && (
            <TextInput
              aria-label={t('findReplace.scope.range')}
              placeholder={t('findReplace.scope.placeholder')}
              value={form.pageRange}
              onChange={(e) => set('pageRange', e.target.value)}
            />
          )}
        </div>
        {formError && (
          <div className="fr-error" role="alert">
            {formError}
          </div>
        )}
        {preview && (
          <div className="fr-results">
            <div className="fr-results__head">
              {total === 0 ? t('findReplace.none') : t('findReplace.found', { count: total })}
            </div>
            {groups.map((g) => (
              <div key={g.pageIndex} className="fr-page">
                <div className="fr-page__title">
                  {t('findReplace.page', { page: g.pageIndex + 1 })}
                </div>
                {g.matches.map((m, i) => (
                  <MatchRow key={`${m.lineId}-${i}`} match={m} docId={doc.id} />
                ))}
              </div>
            ))}
            {preview.skipped.length > 0 && (
              <div className="fr-skipped">
                <div className="fr-page__title">{t('findReplace.skipped')}</div>
                {preview.skipped.map((s, i) => (
                  <div key={i} className="fr-skipped__row">
                    {t('findReplace.page', { page: s.pageIndex + 1 })}:{' '}
                    {skipText(s.reason, s.missing ?? [])}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function MatchRow({ match, docId }: { match: FindMatch; docId: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="fr-match"
      onClick={() => getViewer(docId)?.goToPage(match.pageIndex + 1)}
      title={t('findReplace.jump')}
    >
      <span className="fr-match__before">{match.before}</span>
      <span aria-hidden="true"> → </span>
      <span className="fr-match__after">{match.after}</span>
      {match.fontTo && (
        <span className="fr-match__font">{t('findReplace.fontNote', { font: match.fontTo })}</span>
      )}
    </button>
  );
}

/** Reason of a skipped line in Vietnamese. Unknown reasons are shown as the core sent them. */
export function skipText(reason: string, missing: string[]): string {
  if (reason === 'ARTIFACT') return i18n.t('findReplace.skip.ARTIFACT');
  if (reason === 'TEXT_GLYPH_MISSING') {
    return i18n.t('findReplace.skip.glyphs', { chars: missing.join(' ') });
  }
  return reason;
}
