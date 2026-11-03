/**
 * "Gỡ / đổi nền trang" (E5): background.detect lists the large backgrounds per page (coverage,
 * kind, colour). The action removes them or replaces them with a colour (background.remove).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PaintBucket } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useView } from '../../app/state/viewer';
import { errorMessage, runDocOp } from '../../app/actions';
import { runOp } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Field, RadioGroup, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { ColorInput } from '../overlay/ColorInput';
import { getViewer } from '../viewer/controllers';
import { itemsFrom, useHighlight } from '../redact/highlight';
import {
  backgroundRemoveParams,
  groupByPage,
  readBackgroundResult,
  readBackgrounds,
  type BackgroundItem,
  type BackgroundMode,
  type PageBackgrounds,
} from './backgroundModel';
import { cleanupPages, type CleanupScope } from './scope';
import '../redact/redact.css';

type ScopeKind = 'all' | 'current' | 'range';

const KIND_KEY: Record<string, string> = {
  rectangle: 'cleanup.background.kind.rectangle',
  image: 'cleanup.background.kind.image',
  fill: 'cleanup.background.kind.fill',
};

export function BackgroundDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const docId = doc?.id;
  const docName = doc?.name ?? '';
  const pageCount = doc?.info.pageCount ?? 0;
  const currentPage = (useView(docId).page ?? 1) - 1;
  const [pages, setPages] = useState<PageBackgrounds[]>([]);
  const [mode, setMode] = useState<BackgroundMode>('remove');
  const [color, setColor] = useState('#ffffff');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all');
  const [rangeText, setRangeText] = useState('');
  const [busy, setBusy] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const scan = useCallback(
    async (id: string) => {
      try {
        const r = await runOp(
          'background.detect',
          {},
          { sessionId: id, title: docName, silent: true },
        );
        setPages(groupByPage(readBackgrounds(r.data)));
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
    void runOp('background.detect', {}, { sessionId: docId, title: docName, silent: true })
      .then((r) => {
        if (alive) setPages(groupByPage(readBackgrounds(r.data)));
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

  useEffect(() => () => useHighlight.getState().clear(), []);

  if (!doc) return null;
  const signed = doc.state.signed;
  const scope: CleanupScope =
    scopeKind === 'current'
      ? { kind: 'current', page: currentPage }
      : scopeKind === 'range'
        ? { kind: 'range', text: rangeText }
        : { kind: 'all' };
  const params = backgroundRemoveParams(mode, color, scope, pageCount);
  const pagesOk = cleanupPages(scope, pageCount) !== null;
  const colorOk = mode === 'remove' || /^#[0-9a-fA-F]{6}$/.test(color);
  const found = pages.reduce((n, p) => n + p.items.length, 0);

  /** Highlights the backgrounds of one page and jumps there. */
  const show = (page: PageBackgrounds) => {
    const items: BackgroundItem[] = page.items;
    useHighlight
      .getState()
      .show(doc.id, itemsFrom(items.map((i) => ({ pageIndex: i.pageIndex, bbox: i.bbox }))));
    getViewer(doc.id)?.goToPage(page.pageIndex + 1);
  };

  const run = async () => {
    if (!params || signed) return;
    setRunning(true);
    setDone(null);
    const r = await runDocOp(
      doc.id,
      'background.remove',
      params,
      t('cleanup.background.jobTitle', { name: doc.name }),
    );
    setRunning(false);
    if (!r) return;
    useHighlight.getState().clear();
    setDone(t('cleanup.background.done', { count: readBackgroundResult(r.data) }));
    setBusy(true);
    await scan(doc.id);
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('cleanup.background.title')}
      icon={<PaintBucket size={18} />}
      description={t('cleanup.background.description', { name: doc.name })}
      runLabel={t('cleanup.background.run')}
      onRun={() => void run()}
      workflowStep={
        params
          ? {
              op: 'background.remove',
              params: { ...params },
              label: t('cleanup.background.title'),
            }
          : undefined
      }
      canRun={!!params && pagesOk && colorOk && found > 0 && !busy && !running && !signed}
      running={running}
      warnings={[...(signed ? [t('pageTools.signedBlocked')] : []), ...(error ? [error] : [])]}
    >
      {busy && <Spinner label={t('cleanup.background.scanning')} />}
      {!busy && found === 0 && !error && <p>{t('cleanup.background.empty')}</p>}
      {pages.length > 0 && (
        <div role="group" aria-label={t('cleanup.background.list')}>
          {pages.map((p) => (
            <div key={p.pageIndex} className="cl-page">
              <div className="cl-page__title">
                {t('pageTools.pageN', { page: p.pageIndex + 1 })} ·{' '}
                {t('cleanup.background.coverage', { percent: Math.round(p.coverage * 100) })}
                <Button size="sm" variant="ghost" onClick={() => show(p)}>
                  {t('cleanup.wm.sample', { page: p.pageIndex + 1 })}
                </Button>
              </div>
              {p.items.map((i) => (
                <div key={i.id} className="cl-item">
                  <span>{t(KIND_KEY[i.kind] ?? 'cleanup.background.kind.fill')}</span>
                  {i.fill && (
                    <span
                      className="cl-swatch"
                      style={{ background: i.fill }}
                      aria-label={i.fill}
                      role="img"
                    />
                  )}
                  <span className="pt-hint">{Math.round(i.coverage * 100)}%</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {found > 0 && (
        <>
          <Field label={t('cleanup.background.mode')}>
            <RadioGroup<BackgroundMode>
              aria-label={t('cleanup.background.mode')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'remove', label: t('cleanup.background.remove') },
                { value: 'replaceColor', label: t('cleanup.background.replaceColor') },
              ]}
            />
          </Field>
          {mode === 'replaceColor' && (
            <ColorInput label={t('cleanup.background.color')} value={color} onChange={setColor} />
          )}
          {mode === 'replaceColor' && !colorOk && (
            <p className="pt-hint">{t('cleanup.background.colorInvalid')}</p>
          )}
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
      <p className="rd-warning">{t('cleanup.background.notice')}</p>
      {done && <p className="rd-verified">{done}</p>}
    </TaskDialog>
  );
}
