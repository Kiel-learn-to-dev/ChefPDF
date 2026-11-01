/**
 * Sidebar tab "Lớp" (E1, T6.05): the optional-content layers of the document with visibility
 * toggles, removal and flattening, and the view-by-type chips (E2) that show one kind of object.
 * Every change of the document is an operation (layers.* / a revision); the chips change nothing.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Lock, Layers3, Trash2 } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { confirmDialog } from '../../app/prompts';
import { runDocOp, showError } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { EmptyState, Spinner, Badge } from '../../components/Misc';
import { runOp } from '../../lib/rpc';
import { toggleKind, FILTER_KINDS, layerTotals, type LayersData } from './layersModel';
import { useObjectEdit } from '../objects/objectState';
import type { ObjectKind } from '../objects/objectModel';
import './layers.css';

const KIND_LABEL_KEY: Record<ObjectKind, string> = {
  text: 'layers.filter.text',
  image: 'layers.filter.image',
  path: 'layers.filter.path',
  shading: 'layers.filter.shading',
  form: 'layers.filter.form',
};

export function LayersPanel({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const [data, setData] = useState<LayersData | null>(null);
  const [failed, setFailed] = useState(false);
  const kinds = useObjectEdit((s) => s.kinds);
  const blocked = doc.state.signed;
  const off = blocked || doc.busy > 0;

  // Reload after every revision (a layer toggle is a revision too).
  useEffect(() => {
    let cancelled = false;
    runOp('layers.list', {}, { sessionId: doc.id, title: t('layers.listing'), silent: true })
      .then((r) => {
        if (!cancelled) {
          setFailed(false);
          setData(r.data as LayersData);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFailed(true);
          showError(e);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.version]);

  const setVisible = (id: string, visible: boolean) =>
    void runDocOp(
      doc.id,
      'layers.setVisibility',
      { layerIds: [id], visible },
      t('layers.op.visibility'),
    );

  const remove = async (id: string, name: string) => {
    const answer = await confirmDialog({
      title: t('layers.removeTitle'),
      message: t('layers.removeMessage', { name }),
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'keep', label: t('layers.removeKeep') },
        { id: 'drop', label: t('layers.removeDrop'), variant: 'danger' },
      ],
    });
    if (answer === null || answer === 'cancel') return;
    await runDocOp(
      doc.id,
      'layers.remove',
      { layerIds: [id], deleteContent: answer === 'drop' },
      t('layers.op.remove'),
    );
  };

  const flatten = async () => {
    const answer = await confirmDialog({
      title: t('layers.flattenTitle'),
      message: t('layers.flattenMessage'),
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'flatten', label: t('layers.flattenAction'), variant: 'primary' },
      ],
    });
    if (answer !== 'flatten') return;
    await runDocOp(doc.id, 'layers.flatten', {}, t('layers.op.flatten'));
  };

  const chips = (
    <div className="layers__chips" role="group" aria-label={t('layers.filter.label')}>
      {FILTER_KINDS.map((k) => {
        const on = !!kinds?.includes(k);
        return (
          <button
            key={k}
            type="button"
            className={`layers__chip layers__chip--${k}${on ? ' is-on' : ''}`}
            aria-pressed={on}
            data-testid={`filter-${k}`}
            onClick={() => useObjectEdit.getState().setKinds(toggleKind(kinds, k))}
          >
            {t(KIND_LABEL_KEY[k])}
          </button>
        );
      })}
    </div>
  );

  if (failed && !data) {
    return (
      <div className="layers" data-testid="layers-panel">
        {chips}
        <EmptyState title={t('layers.failed')} text={t('layers.failedText')} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="layers" data-testid="layers-panel">
        {chips}
        <div className="layers__loading">
          <Spinner size={18} label={t('layers.listing')} />
        </div>
      </div>
    );
  }

  const totals = layerTotals(data.layers);
  return (
    <div className="layers" data-testid="layers-panel">
      {chips}
      {data.layers.length === 0 ? (
        <EmptyState
          icon={<Layers3 size={22} />}
          title={t('layers.none')}
          text={t('layers.noneText')}
        />
      ) : (
        <>
          <p className="layers__summary">
            {t('layers.summary', {
              layers: totals.layers,
              hidden: totals.hidden,
              objects: totals.objects,
            })}
          </p>
          <ul className="layers__list" aria-label={t('layers.label')}>
            {data.layers.map((l) => (
              <li key={l.id} className="layers__row" data-testid="layer-row" data-name={l.name}>
                <IconButton
                  size="sm"
                  label={l.visible ? t('layers.hide') : t('layers.show')}
                  icon={l.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                  disabled={off}
                  onClick={() => setVisible(l.id, !l.visible)}
                  aria-pressed={l.visible}
                />
                <div className="layers__name">
                  <span title={l.name}>{l.name || t('layers.unnamed')}</span>
                  <span className="layers__meta">
                    {t('layers.meta', { objects: l.objectCount, pages: l.pageCount })}
                  </span>
                </div>
                {l.locked && (
                  <span className="layers__lock" title={t('layers.locked')}>
                    <Lock size={13} aria-hidden />
                    <span className="sr-only">{t('layers.locked')}</span>
                  </span>
                )}
                {!l.visible && <Badge>{t('layers.hiddenBadge')}</Badge>}
                <IconButton
                  size="sm"
                  label={t('layers.remove')}
                  icon={<Trash2 size={14} />}
                  disabled={off}
                  onClick={() => void remove(l.id, l.name)}
                />
              </li>
            ))}
          </ul>
          <div className="layers__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<Layers3 size={14} />}
              disabled={off}
              title={blocked ? t('overlay.signedBlocked') : undefined}
              onClick={() => void flatten()}
            >
              {t('layers.flatten')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
