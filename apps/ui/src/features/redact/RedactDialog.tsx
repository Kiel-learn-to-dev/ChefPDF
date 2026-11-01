/**
 * "Che thông tin mật" (J6, T6.07): redact.find lists the matches of the chosen patterns (grouped,
 * with page numbers, checked by default). Manual areas are drawn with the placement layer (box
 * mode). redact.apply removes the content for good, after a confirmation; the core then checks
 * the saved file and the dialog shows the verified message or the places where text is left.
 *
 * The form, matches and areas are kept as a draft, so they survive the dialog closing while the
 * user draws an area on the page.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { errorMessage, runDocOp } from '../../app/actions';
import { confirmDialog } from '../../app/prompts';
import { redactionLeaks } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Checkbox, Select, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { ColorInput } from '../overlay/ColorInput';
import { useDraft, useOverlayState } from '../overlay/overlayState';
import { getViewer } from '../viewer/controllers';
import { itemsFrom, useHighlight } from './highlight';
import {
  BUILTIN_KINDS,
  DEFAULT_REDACT_FORM,
  applyParams,
  defaultMatchSelection,
  formPatterns,
  groupMatches,
  isValidRegex,
  manualFromBox,
  newCustomRow,
  readMatches,
  readVerification,
  setGroupChecked,
  toggleMatch,
  unselectedCount,
  type BuiltinKind,
  type CustomRow,
  type ManualArea,
  type RedactForm,
  type RedactLeak,
  type RedactMatch,
  type Verification,
} from './redactModel';
import type { RedactPattern } from '@chef/contracts';
import './redact.css';

interface RedactDraft {
  form: RedactForm;
  /** The patterns of the last search: redact.apply finds the matches again with them. */
  patterns: RedactPattern[];
  matches: RedactMatch[];
  selected: string[];
  searched: boolean;
  areas: ManualArea[];
  fill: string;
  alsoMetadata: boolean;
  removeFromAnnotations: boolean;
  verification: Verification | null;
}

const INITIAL: RedactDraft = {
  form: DEFAULT_REDACT_FORM,
  patterns: [],
  matches: [],
  selected: [],
  searched: false,
  areas: [],
  fill: '#000000',
  alsoMetadata: true,
  removeFromAnnotations: true,
  verification: null,
};

let rowSeq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(rowSeq += 1)}`;

export function RedactDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const docId = doc?.id ?? '';
  const [d, setD] = useDraft<RedactDraft>(`redact.${docId}`, () => INITIAL);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<RedactDraft>) => setD((x) => ({ ...x, ...p }));
  const patchForm = (p: Partial<RedactForm>) => setD((x) => ({ ...x, form: { ...x.form, ...p } }));

  // A box drawn on the page comes back once, when the dialog reopens.
  useEffect(() => {
    const box = useOverlayState.getState().takeResult('redact');
    if (!box) return;
    const area = manualFromBox(newId('area'), box);
    if (area) setD((x) => ({ ...x, areas: [...x.areas, area] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot read on mount
  }, [docId]);

  useEffect(() => () => useHighlight.getState().clear(), []);

  if (!doc) return null;
  const signed = doc.state.signed;
  const pf = formPatterns(d.form);
  const groups = groupMatches(d.matches);
  const unchecked = unselectedCount(d.matches, d.selected);
  const params = applyParams({
    patterns: d.patterns,
    matchIds: d.selected,
    areas: d.areas,
    fill: d.fill,
    alsoMetadata: d.alsoMetadata,
    removeFromAnnotations: d.removeFromAnnotations,
  });

  const updateRow = (id: string, p: Partial<CustomRow>) =>
    patchForm({ custom: d.form.custom.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  const find = async () => {
    if (!pf.ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await runOp(
        'redact.find',
        { patterns: pf.patterns },
        { sessionId: doc.id, title: doc.name, silent: true },
      );
      const matches = readMatches(r.data);
      useHighlight.getState().clear();
      patch({
        patterns: pf.patterns,
        matches,
        selected: defaultMatchSelection(matches),
        searched: true,
        verification: null,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const showMatch = (m: RedactMatch) => {
    useHighlight.getState().show(doc.id, itemsFrom([m]));
    getViewer(doc.id)?.goToPage(m.pageIndex + 1);
  };

  const apply = async () => {
    if (!params || signed || running) return;
    const answer = await confirmDialog({
      title: t('redact.confirmTitle'),
      message: t('redact.confirmBody'),
      tone: 'danger',
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'secondary' },
        { id: 'apply', label: t('redact.confirm'), variant: 'danger' },
      ],
    });
    if (answer !== 'apply') return;
    setRunning(true);
    setError(null);
    const r = await runDocOp(
      doc.id,
      'redact.apply',
      params,
      t('redact.jobTitle', { name: doc.name }),
      {
        onError: (e) => {
          // A failed check leaves the session as it was: show where the text is still present.
          const leaks: RedactLeak[] | null = redactionLeaks(e);
          if (!leaks) return false;
          patch({ verification: { ok: false, leaks } });
          return true;
        },
      },
    );
    setRunning(false);
    if (!r) return;
    useHighlight.getState().clear();
    patch({
      verification: readVerification(r.data),
      matches: [],
      selected: [],
      areas: [],
      patterns: [],
      searched: false,
    });
  };

  const patternLabel = (p: string) =>
    (BUILTIN_KINDS as readonly string[]).includes(p) ? t(`redact.patterns.${p}`) : p;
  const selectedCount = d.selected.length + d.areas.length;

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('redact.title')}
      icon={<EyeOff size={18} />}
      description={t('redact.description', { name: doc.name })}
      runLabel={t('redact.apply', { count: selectedCount })}
      onRun={() => void apply()}
      canRun={!!params && !busy && !running && !signed}
      running={running}
      warnings={[...(signed ? [t('pageTools.signedBlocked')] : []), ...(error ? [error] : [])]}
    >
      <p className="rd-warning">
        <strong>{t('redact.warning')}</strong>
      </p>

      <section className="rd-section">
        <div className="rd-section__title">{t('redact.patterns.title')}</div>
        <div className="rd-row" role="group" aria-label={t('redact.patterns.title')}>
          {BUILTIN_KINDS.map((k: BuiltinKind) => (
            <Checkbox
              key={k}
              checked={d.form.builtins[k]}
              onChange={(v) => patchForm({ builtins: { ...d.form.builtins, [k]: v } })}
              label={t(`redact.patterns.${k}`)}
            />
          ))}
        </div>
        <div className="rd-section__title">{t('redact.custom.title')}</div>
        {d.form.custom.map((row) => (
          <div key={row.id} className="rd-row">
            <Select<CustomRow['kind']>
              aria-label={t('redact.custom.title')}
              value={row.kind}
              onChange={(kind) => updateRow(row.id, { kind })}
              options={[
                { value: 'literal', label: t('redact.custom.literal') },
                { value: 'regex', label: t('redact.custom.regex') },
              ]}
            />
            <TextInput
              className="rd-row__value"
              aria-label={t('redact.custom.value')}
              placeholder={t('redact.custom.value')}
              value={row.value}
              onChange={(e) => updateRow(row.id, { value: e.target.value })}
            />
            <Checkbox
              checked={row.ignoreDiacritics}
              onChange={(v) => updateRow(row.id, { ignoreDiacritics: v })}
              label={t('redact.custom.ignoreDiacritics')}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => patchForm({ custom: d.form.custom.filter((r) => r.id !== row.id) })}
            >
              {t('redact.custom.remove')}
            </Button>
            {row.kind === 'regex' && row.value !== '' && !isValidRegex(row.value) && (
              <span className="pt-hint">{t('redact.custom.invalidRegex')}</span>
            )}
          </div>
        ))}
        <div className="rd-row">
          <Button
            size="sm"
            onClick={() => patchForm({ custom: [...d.form.custom, newCustomRow(newId('row'))] })}
          >
            {t('redact.custom.add')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void find()}
            disabled={!pf.ok || busy || running}
          >
            {busy ? t('redact.finding') : t('redact.find')}
          </Button>
        </div>
        {busy && <Spinner label={t('redact.finding')} />}
      </section>

      {d.searched && (
        <section className="rd-section">
          <div className="rd-section__title">
            {t('redact.results', { count: d.matches.length })}
          </div>
          {d.matches.length === 0 && <p>{t('redact.none')}</p>}
          {d.matches.length > 0 && <p className="pt-hint">{t('redact.allOccurrences')}</p>}
          {groups.map((g) => {
            const allOn = g.matches.every((m) => d.selected.includes(m.id));
            return (
              <div key={g.pattern} className="rd-group">
                <Checkbox
                  checked={allOn}
                  onChange={(v) => patch({ selected: setGroupChecked(d.selected, g, v) })}
                  label={patternLabel(g.pattern)}
                  hint={t('redact.groupCount', {
                    count: g.count,
                    pages: g.pages.map((p) => p + 1).join(', '),
                  })}
                />
                {g.matches.map((m) => (
                  <div key={m.id} className="rd-match">
                    <Checkbox
                      checked={d.selected.includes(m.id)}
                      onChange={() => patch({ selected: toggleMatch(d.selected, m.id) })}
                      label={t('redact.pageN', { page: m.pageIndex + 1 })}
                    />
                    <button type="button" className="rd-match__text" onClick={() => showMatch(m)}>
                      {m.text}
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
          {unchecked > 0 && (
            <p className="pt-hint">{t('redact.unchecked', { count: unchecked })}</p>
          )}
        </section>
      )}

      <section className="rd-section">
        <div className="rd-section__title">{t('redact.areas.title')}</div>
        <p className="pt-hint">{t('redact.areas.hint')}</p>
        {d.areas.length === 0 && <p className="pt-hint">{t('redact.areas.none')}</p>}
        {d.areas.map((a, i) => (
          <div key={a.id} className="rd-row">
            <span>{t('redact.areas.drawn', { index: i + 1, page: a.pageIndex + 1 })}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => patch({ areas: d.areas.filter((x) => x.id !== a.id) })}
            >
              {t('redact.areas.remove')}
            </Button>
          </div>
        ))}
        <div className="rd-row">
          <Button
            size="sm"
            onClick={() =>
              useOverlayState.getState().start({ docId: doc.id, mode: 'box', returnTo: 'redact' })
            }
            disabled={running}
          >
            {t('redact.areas.draw')}
          </Button>
        </div>
      </section>

      <section className="rd-section">
        <ColorInput label={t('redact.fill')} value={d.fill} onChange={(fill) => patch({ fill })} />
        <Checkbox
          checked={d.alsoMetadata}
          onChange={(alsoMetadata) => patch({ alsoMetadata })}
          label={t('redact.alsoMetadata')}
        />
        <Checkbox
          checked={d.removeFromAnnotations}
          onChange={(removeFromAnnotations) => patch({ removeFromAnnotations })}
          label={t('redact.removeFromAnnotations')}
        />
        {selectedCount === 0 && <p className="pt-hint">{t('redact.nothing')}</p>}
      </section>

      {d.verification?.ok && (
        <p className="rd-verified" role="status">
          {t('redact.verified')}
        </p>
      )}
      {d.verification && !d.verification.ok && (
        <div className="rd-leaks" role="alert">
          <strong>{t('redact.leaksTitle')}</strong>
          <ul>
            {d.verification.leaks.map((l, i) => (
              <li key={`${l.where}-${i}`}>
                {t('redact.leakItem', { where: l.where, pattern: l.pattern })}
              </li>
            ))}
          </ul>
          <p>{t('redact.leakHint')}</p>
        </div>
      )}
    </TaskDialog>
  );
}
