/**
 * "Gỡ đối tượng giống thế này" (E4): the user picks an object on a page. The point goes through
 * the overlay placement layer (returnTo "removeSimilar"); content.hitTest finds the object there.
 * Preview = content.removeSimilar with dryRun (the matches are highlighted); "Gỡ" runs it for real.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MousePointerClick } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { errorMessage, runDocOp } from '../../app/actions';
import { runOp } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Field, RadioGroup, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { Spinner } from '../../components/Misc';
import { useOverlayState, useDraft } from '../overlay/overlayState';
import { getViewer } from '../viewer/controllers';
import { itemsFrom, useHighlight } from '../redact/highlight';
import {
  DEFAULT_TOLERANCE_MM,
  matchesPerPage,
  readPickedObject,
  readSimilarResult,
  similarParams,
  type PickedObject,
  type SimilarResult,
  type SimilarScope,
} from './removeSimilarModel';
import '../redact/redact.css';

interface SimilarDraft {
  scope: SimilarScope;
  tolerance: number;
  picked: PickedObject | null;
  preview: SimilarResult | null;
}

const INITIAL: SimilarDraft = {
  scope: 'all',
  tolerance: DEFAULT_TOLERANCE_MM,
  picked: null,
  preview: null,
};

export function RemoveSimilarDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const docId = doc?.id ?? '';
  const [draft, setDraft] = useDraft<SimilarDraft>(`similar.${docId}`, () => INITIAL);
  // Starts busy when a picked point is waiting to be read (the dialog reopens after the pick).
  const [busy, setBusy] = useState(
    () => useOverlayState.getState().result?.returnTo === 'removeSimilar',
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // A point picked on the page comes back here once: find the object under it.
  useEffect(() => {
    const pick = useOverlayState.getState().takeResult('removeSimilar');
    if (!pick || !docId) return;
    runOp(
      'content.hitTest',
      { pageIndex: pick.pageIndex, x: pick.x, y: pick.y, unit: 'pt' },
      { sessionId: docId, title: t('cleanup.similar.pick'), silent: true },
    )
      .then((r) => {
        const obj = readPickedObject(r.data);
        if (!obj) {
          setError(t('cleanup.similar.none'));
          setDraft((d) => ({ ...d, picked: null, preview: null }));
          return;
        }
        setError(null);
        setDraft((d) => ({ ...d, picked: obj, preview: null }));
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot read on mount
  }, [docId]);

  useEffect(() => () => useHighlight.getState().clear(), []);

  if (!doc) return null;
  const signed = doc.state.signed;
  const { picked, preview } = draft;
  const matches = preview?.matches ?? [];

  const pick = () => {
    useOverlayState.getState().start({ docId: doc.id, mode: 'point', returnTo: 'removeSimilar' });
  };

  const runPreview = async (p: PickedObject) => {
    setBusy(true);
    setError(null);
    try {
      const r = await runOp(
        'content.removeSimilar',
        similarParams(p, draft.scope, draft.tolerance, true),
        { sessionId: doc.id, title: doc.name, silent: true },
      );
      const res = readSimilarResult(r.data);
      setDraft((d) => ({ ...d, preview: res }));
      useHighlight
        .getState()
        .show(
          doc.id,
          itemsFrom(res.matches.map((m) => ({ pageIndex: m.pageIndex, bbox: m.bbox }))),
        );
      const first = res.matches[0];
      if (first) getViewer(doc.id)?.goToPage(first.pageIndex + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!picked || !preview || matches.length === 0 || signed) return;
    setRunning(true);
    setDone(null);
    const r = await runDocOp(
      doc.id,
      'content.removeSimilar',
      similarParams(picked, draft.scope, draft.tolerance, false),
      t('cleanup.similar.jobTitle', { name: doc.name }),
    );
    setRunning(false);
    if (!r) return;
    const removed = readSimilarResult(r.data).removedObjects;
    useHighlight.getState().clear();
    setDraft((d) => ({ ...d, preview: null, picked: null }));
    setDone(t('cleanup.similar.removed', { count: removed }));
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && !running && close()}
      size="lg"
      title={t('cleanup.similar.title')}
      icon={<MousePointerClick size={18} />}
      description={t('cleanup.similar.description')}
      runLabel={t('cleanup.similar.remove', { count: matches.length })}
      onRun={() => void remove()}
      canRun={!!preview && matches.length > 0 && !busy && !running && !signed}
      running={running}
      warnings={[...(signed ? [t('pageTools.signedBlocked')] : []), ...(error ? [error] : [])]}
    >
      <div className="rd-row">
        <Button size="sm" onClick={pick} disabled={busy || running || signed}>
          {t('cleanup.similar.pick')}
        </Button>
        {picked && (
          <span>
            {t('cleanup.similar.picked', { kind: picked.kind, page: picked.pageIndex + 1 })}
          </span>
        )}
      </div>
      {busy && <Spinner label={t('cleanup.similar.preview')} />}
      <Field label={t('cleanup.similar.scope.label')}>
        <RadioGroup<SimilarScope>
          aria-label={t('cleanup.similar.scope.label')}
          value={draft.scope}
          onChange={(scope) => setDraft((d) => ({ ...d, scope, preview: null }))}
          options={[
            { value: 'all', label: t('cleanup.similar.scope.all') },
            { value: 'others', label: t('cleanup.similar.scope.others') },
          ]}
        />
      </Field>
      <Field label={t('cleanup.similar.tolerance')}>
        <TextInput
          type="number"
          min={0}
          max={20}
          step={0.5}
          value={draft.tolerance}
          onChange={(e) =>
            setDraft((d) => ({ ...d, tolerance: Number(e.target.value), preview: null }))
          }
        />
      </Field>
      <div className="rd-row">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => picked && void runPreview(picked)}
          disabled={!picked || busy || running}
        >
          {t('cleanup.similar.preview')}
        </Button>
        {preview && matches.length === 0 && <span>{t('cleanup.similar.noMatches')}</span>}
      </div>
      {preview && matches.length > 0 && (
        <div
          role="group"
          aria-label={t('cleanup.similar.found', {
            count: matches.length,
            pages: matchesPerPage(matches).length,
          })}
        >
          <p>
            {t('cleanup.similar.found', {
              count: matches.length,
              pages: matchesPerPage(matches).length,
            })}
          </p>
          {matchesPerPage(matches).map((p) => (
            <p key={p.pageIndex} className="pt-hint">
              {t('cleanup.similar.perPage', { page: p.pageIndex + 1, count: p.count })}
            </p>
          ))}
        </div>
      )}
      {!preview && picked && <p className="pt-hint">{t('cleanup.similar.needPreview')}</p>}
      <p className="rd-warning">{t('cleanup.wm.notice')}</p>
      {done && <p className="rd-verified">{done}</p>}
    </TaskDialog>
  );
}
