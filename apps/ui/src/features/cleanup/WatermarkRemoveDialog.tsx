/**
 * "Gỡ watermark" (E3, T6.06): watermark.detect lists the candidates ranked by confidence, with a
 * preview on the pages. Clicking a candidate highlights its boxes and jumps to its sample page.
 * Only the checked candidates are removed (watermark.remove), and the list is scanned again after.
 * Detection never removes anything by itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Droplets } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useView } from '../../app/state/viewer';
import { errorMessage, runDocOp } from '../../app/actions';
import { runOp } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Checkbox, Field, RadioGroup, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { getViewer } from '../viewer/controllers';
import {
  confidenceLevel,
  defaultChecked,
  rankCandidates,
  readCandidates,
  readRemoveResult,
  removedTotal,
  samplePage,
  watermarkRemoveParams,
  type ConfidenceLevel,
  type WatermarkCandidate,
} from './watermarkModel';
import { cleanupPages, type CleanupScope } from './scope';
import { itemsFrom, useHighlight } from '../redact/highlight';
import '../redact/redact.css';

type ScopeKind = 'all' | 'current' | 'range';

const LEVEL_KEY: Record<ConfidenceLevel, string> = {
  high: 'cleanup.wm.level.high',
  medium: 'cleanup.wm.level.medium',
  low: 'cleanup.wm.level.low',
};

export function WatermarkRemoveDialog() {
  const { t, i18n } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const docId = doc?.id;
  const docName = doc?.name ?? '';
  const pageCount = doc?.info.pageCount ?? 0;
  const currentPage = (useView(docId).page ?? 1) - 1;
  const [list, setList] = useState<WatermarkCandidate[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all');
  const [rangeText, setRangeText] = useState('');
  // Starts true: the first scan runs as the dialog mounts.
  const [busy, setBusy] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const scan = useCallback(
    async (id: string) => {
      try {
        const r = await runOp(
          'watermark.detect',
          {},
          { sessionId: id, title: docName, silent: true },
        );
        const next = rankCandidates(readCandidates(r.data));
        setList(next);
        setChecked(defaultChecked(next));
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [docName],
  );

  // The first scan: its results are set in callbacks, not synchronously in the effect body.
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    void runOp('watermark.detect', {}, { sessionId: docId, title: docName, silent: true })
      .then((r) => {
        if (!alive) return;
        const next = rankCandidates(readCandidates(r.data));
        setList(next);
        setChecked(defaultChecked(next));
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [docId, docName]);

  // The highlight belongs to the open dialog only.
  useEffect(() => () => useHighlight.getState().clear(), []);

  if (!doc) return null;
  const signed = doc.state.signed;
  const scope: CleanupScope =
    scopeKind === 'current'
      ? { kind: 'current', page: currentPage }
      : scopeKind === 'range'
        ? { kind: 'range', text: rangeText }
        : { kind: 'all' };
  const params = watermarkRemoveParams(checked, scope, pageCount);
  const pagesOk = cleanupPages(scope, pageCount) !== null;
  const lang = i18n.language.startsWith('en') ? 'en' : 'vi';

  const toggle = (id: string) =>
    setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  /** Highlights the candidate on all its pages and jumps to the sample page. */
  const focus = (c: WatermarkCandidate) => {
    useHighlight
      .getState()
      .show(doc.id, itemsFrom(c.preview.map((p) => ({ pageIndex: p.pageIndex, rects: p.bboxes }))));
    const page = samplePage(c);
    if (page !== null) getViewer(doc.id)?.goToPage(page + 1);
  };

  const run = async () => {
    if (!params || signed) return;
    setRunning(true);
    setDone(null);
    const r = await runDocOp(
      doc.id,
      'watermark.remove',
      params,
      t('cleanup.wm.jobTitle', { name: doc.name }),
    );
    setRunning(false);
    if (!r) return;
    useHighlight.getState().clear();
    setDone(t('cleanup.wm.done', { count: removedTotal(readRemoveResult(r.data)) }));
    setBusy(true);
    await scan(doc.id);
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('cleanup.wm.title')}
      icon={<Droplets size={18} />}
      description={t('cleanup.wm.description', { name: doc.name })}
      runLabel={t('cleanup.wm.run', { count: checked.length })}
      onRun={() => void run()}
      canRun={!!params && pagesOk && !busy && !running && !signed}
      running={running}
      warnings={[...(signed ? [t('pageTools.signedBlocked')] : []), ...(error ? [error] : [])]}
    >
      {busy && <Spinner label={t('cleanup.wm.scanning')} />}
      {!busy && list.length === 0 && !error && (
        <>
          <p>{t('cleanup.wm.empty')}</p>
          <p className="pt-hint">{t('cleanup.wm.emptyHint')}</p>
        </>
      )}
      {list.length > 0 && (
        <div role="group" aria-label={t('cleanup.wm.list')}>
          {list.map((c) => {
            const level = confidenceLevel(c.confidence);
            const percent = Math.round(c.confidence * 100);
            const page = samplePage(c);
            return (
              <div key={c.id} className="cl-cand" data-testid="wm-candidate">
                <div className="cl-cand__head">
                  <Checkbox
                    checked={checked.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    label={lang === 'en' ? c.description.en : c.description.vi}
                    hint={[
                      t('cleanup.wm.pages', { count: c.pages.length }),
                      t('cleanup.wm.objects', { count: c.count }),
                      t(LEVEL_KEY[level]),
                    ].join(' · ')}
                  />
                  {page !== null && (
                    <Button variant="ghost" onClick={() => focus(c)}>
                      {t('cleanup.wm.sample', { page: page + 1 })}
                    </Button>
                  )}
                </div>
                <div
                  className={`cl-bar cl-bar--${level}`}
                  role="img"
                  aria-label={t('cleanup.wm.confidence', { percent })}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {list.length > 0 && (
        <>
          <Field label={t('cleanup.scope.label')}>
            <RadioGroup<ScopeKind>
              aria-label={t('cleanup.scope.label')}
              value={scopeKind}
              onChange={setScopeKind}
              options={[
                { value: 'all', label: t('cleanup.scope.all') },
                { value: 'current', label: t('cleanup.scope.current') },
                { value: 'range', label: t('cleanup.scope.range') },
              ]}
            />
          </Field>
          {scopeKind === 'range' && (
            <Field label={t('cleanup.scope.range')} hint={t('cleanup.scope.rangeHint')}>
              <TextInput value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
            </Field>
          )}
          {scopeKind === 'range' && !pagesOk && (
            <p className="pt-hint">{t('cleanup.scope.invalid')}</p>
          )}
        </>
      )}
      <p className="rd-warning">{t('cleanup.wm.notice')}</p>
      {done && <p className="rd-verified">{done}</p>}
      {!busy && (
        <div className="rd-row">
          <Button
            onClick={() => {
              setBusy(true);
              void scan(doc.id);
            }}
            disabled={running}
          >
            {t('cleanup.wm.rescan')}
          </Button>
        </div>
      )}
    </TaskDialog>
  );
}
