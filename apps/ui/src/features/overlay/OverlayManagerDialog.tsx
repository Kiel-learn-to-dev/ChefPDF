/**
 * "Đã thêm vào tài liệu" (F12): the overlays Chef PDF added to the open document, grouped by kind
 * and by the operation that added them. Select a group to remove it or jump to its first page.
 * The list refreshes after every change of the document (undo and redo included).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Droplets,
  FileImage,
  Hash,
  Layers,
  PanelBottom,
  PanelTop,
  QrCode,
  Stamp,
  Trash2,
  Type,
  Image as ImageIcon,
  Eye,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { confirmDialog } from '../../app/prompts';
import { Button } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { getViewer } from '../viewer/controllers';
import { listOverlays } from './overlayActions';
import {
  groupOverlays,
  type OverlayGroup,
  type OverlayItem,
  type OverlayKind,
} from './overlayModel';
import { formatPageRanges } from '../../lib/pageRange';
import './overlay.css';

const ICONS: Record<OverlayKind, ReactNode> = {
  text: <Type size={15} />,
  image: <ImageIcon size={15} />,
  watermark: <Droplets size={15} />,
  stamp: <Stamp size={15} />,
  header: <PanelTop size={15} />,
  footer: <PanelBottom size={15} />,
  number: <Hash size={15} />,
  qr: <QrCode size={15} />,
  letterhead: <FileImage size={15} />,
};

export function OverlayManagerDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [items, setItems] = useState<OverlayItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docId = doc?.id;
  const revision = doc?.state.revision;
  const signed = doc?.state.signed ?? false;

  // Reload after every change of the document: each revision is a new state of the list.
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    listOverlays(docId)
      .then((list) => {
        if (alive) {
          setItems(list);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setItems([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [docId, revision]);

  const groups = useMemo(() => groupOverlays(items ?? []), [items]);
  if (!doc) return null;
  const current = groups.find((g) => g.key === selected) ?? null;
  const watermarks = groups.filter((g) => g.kind === 'watermark');

  const removeWhere = async (
    selector: { group?: string; kind?: OverlayKind; ids?: string[] },
    title: string,
  ) => {
    setBusy(true);
    try {
      await runDocOp(doc.id, 'overlay.remove', selector, title);
      setSelected(null);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = () => {
    if (!current) return;
    void removeWhere(
      { group: current.group },
      t('overlay.manager.removeJob', { label: current.label }),
    );
  };

  const removeKind = (kind: OverlayKind) =>
    void removeWhere(
      { kind },
      t('overlay.manager.removeKindJob', { kind: t(`overlay.kind.${kind}`) }),
    );

  const removeAll = async () => {
    const answer = await confirmDialog({
      title: t('overlay.manager.confirmAllTitle'),
      message: t('overlay.manager.confirmAllText', { count: items?.length ?? 0 }),
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'remove', label: t('overlay.manager.removeAll'), variant: 'danger' },
      ],
    });
    if (answer !== 'remove') return;
    const ids = (items ?? []).map((i) => i.id);
    if (ids.length === 0) return;
    void removeWhere({ ids }, t('overlay.manager.removeAllJob'));
  };

  const goFirst = (g: OverlayGroup) => {
    const first = g.pages[0];
    if (first !== undefined) getViewer(doc.id)?.goToPage(first + 1);
  };

  const lockHint = signed ? t('overlay.signedBlocked') : undefined;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<Layers size={18} />}
      title={t('overlay.manager.title')}
      description={t('overlay.manager.description')}
      size="lg"
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => void removeAll()}
            disabled={signed || busy || !items?.length}
            title={lockHint}
          >
            {t('overlay.manager.removeAll')}
          </Button>
          <Button
            disabled={signed || busy || watermarks.length === 0}
            onClick={() => removeKind('watermark')}
            title={lockHint}
          >
            {t('overlay.manager.removeWatermarks')}
          </Button>
          <DialogSpacer />
          <Button onClick={close}>{t('common.close')}</Button>
        </>
      }
    >
      {items === null && <p className="field__hint">{t('overlay.manager.loading')}</p>}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      {items !== null && groups.length === 0 && (
        <p className="ov-manager__empty" data-testid="overlay-empty">
          {t('overlay.manager.empty')}
        </p>
      )}
      {groups.length > 0 && (
        <ul
          className="ov-manager__list"
          role="listbox"
          aria-label={t('overlay.manager.title')}
          data-testid="overlay-list"
        >
          {groups.map((g) => (
            <li key={g.key}>
              <button
                type="button"
                role="option"
                aria-selected={selected === g.key}
                className="ov-manager__item"
                data-kind={g.kind}
                onClick={() => setSelected(g.key)}
                onDoubleClick={() => goFirst(g)}
              >
                <span className="ov-manager__icon">{ICONS[g.kind]}</span>
                <span className="ov-manager__label">
                  <span className="ov-manager__name">{g.label || t(`overlay.kind.${g.kind}`)}</span>
                  <span className="ov-manager__meta">
                    {t(`overlay.kind.${g.kind}`)} · {t('overlay.manager.count', { count: g.count })}{' '}
                    ·{' '}
                    {t('overlay.manager.pages', {
                      pages: formatPageRanges(g.pages.map((p) => p)) || '–',
                    })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ov-manager__actions">
        <Button
          size="sm"
          icon={<Eye size={14} />}
          disabled={!current || current.pages.length === 0}
          onClick={() => current && goFirst(current)}
        >
          {t('overlay.manager.view')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={14} />}
          disabled={!current || signed || busy}
          onClick={removeSelected}
          title={lockHint}
        >
          {t('overlay.manager.remove')}
        </Button>
      </div>
    </Dialog>
  );
}
