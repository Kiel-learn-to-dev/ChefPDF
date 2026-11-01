/**
 * "Soi file & dọn dữ liệu ẩn" (J3, J4; T5.02). Lists what the open document holds beyond its
 * visible pages (by category, with severity), lets the user tick the removable categories and
 * removes them (inspect.removeHidden), then shows the before / after counts and rescans.
 * Hidden text is reported but cannot be removed automatically.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox } from '../../components/Form';
import { Badge, Spinner } from '../../components/Misc';
import { toast } from '../../components/Toast';
import { runOp } from '../../lib/rpc';
import {
  itemText,
  presentFindings,
  readFindings,
  readRemoveSummary,
  removableOf,
  removeParams,
  type Finding,
  type InspectCategory,
  type RemoveSummary,
} from './inspectModel';
import './inspect.css';

const SEVERITY_TONE: Record<Finding['severity'], 'neutral' | 'accent'> = {
  info: 'neutral',
  warn: 'accent',
  risk: 'accent',
};

/** Soi file & dọn dữ liệu ẩn (J3, J4). */
export function InspectDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [selected, setSelected] = useState<Set<InspectCategory>>(new Set());
  const [summary, setSummary] = useState<RemoveSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const docId = doc?.id;
  const docName = doc?.name ?? '';
  const blocked = doc?.state.signed ?? false;

  const scan = useCallback(async () => {
    if (!docId) return;
    try {
      const r = await runOp(
        'inspect.hiddenData',
        {},
        { sessionId: docId, title: t('inspect.job', { name: docName }), silent: true },
      );
      const list = readFindings(r.data);
      setFindings(list);
      setSelected(new Set(removableOf(list)));
    } catch {
      setFindings([]);
    } finally {
      setBusy(false);
    }
  }, [docId, docName, t]);

  useEffect(() => {
    // Loads the findings from the core when the dialog opens (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void scan();
  }, [scan]);

  if (!doc) return null;

  const shown = findings ? presentFindings(findings) : [];
  const removable = findings ? removableOf(findings) : [];
  const toggle = (c: InspectCategory, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(c);
      else next.delete(c);
      return next;
    });

  const remove = async () => {
    const params = removeParams([...selected]);
    if (params.categories.length === 0 || blocked) return;
    setBusy(true);
    const r = await runDocOp(
      doc.id,
      'inspect.removeHidden',
      params,
      t('inspect.removeJob', { name: docName }),
    );
    setBusy(false);
    if (!r) return;
    setSummary(readRemoveSummary(r.data));
    toast.success(t('inspect.title'), t('inspect.removedToast'));
    await scan();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={t('inspect.title')}
      icon={<ScanSearch size={18} />}
      description={t('inspect.description')}
      size="lg"
      modalLock={busy}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setBusy(true);
              void scan();
            }}
            disabled={busy}
          >
            {t('inspect.rescan')}
          </Button>
          <Button variant="ghost" onClick={() => close()} disabled={busy}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void remove()}
            disabled={busy || blocked || selected.size === 0}
            title={blocked ? t('inspect.signedBlocked') : undefined}
            loading={busy}
          >
            {t('inspect.remove', { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className="inspect">
        {findings === null || (busy && findings.length === 0) ? (
          <div className="inspect__loading">
            <Spinner label={t('inspect.scanning')} />
            <span>{t('inspect.scanning')}</span>
          </div>
        ) : shown.length === 0 ? (
          <p className="inspect__clean">{t('inspect.clean')}</p>
        ) : (
          <ul className="inspect__list">
            {shown.map((f) => (
              <li key={f.category} className="inspect__item">
                <div className="inspect__head">
                  {f.fixAvailable && removable.includes(f.category) ? (
                    <Checkbox
                      checked={selected.has(f.category)}
                      disabled={blocked}
                      onChange={(on) => toggle(f.category, on)}
                      label={t(`inspect.cat.${f.category}`)}
                    />
                  ) : (
                    <span className="inspect__label">{t(`inspect.cat.${f.category}`)}</span>
                  )}
                  <Badge tone={SEVERITY_TONE[f.severity]}>
                    {t(`inspect.severity.${f.severity}`)}
                  </Badge>
                  <span className="inspect__count">{t('inspect.count', { count: f.count })}</span>
                </div>
                <p className="inspect__hint">
                  {f.fixAvailable
                    ? t(`inspect.hint.${f.category}`)
                    : t(`inspect.noFix.${f.category}`)}
                </p>
                {f.items.length > 0 && (
                  <details className="inspect__details">
                    <summary>{t('inspect.showItems', { count: f.items.length })}</summary>
                    <ul>
                      {f.items.map((item, i) => (
                        <li key={i}>{itemText(item, t)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {summary && (
          <div className="inspect__summary" role="status">
            <strong>
              {t('inspect.summary', { before: summary.totalBefore, after: summary.totalAfter })}
            </strong>
            <ul>
              {Object.entries(summary.removed).map(([c, n]) => (
                <li key={c}>
                  {t('inspect.removedLine', { name: t(`inspect.cat.${c}`), count: n })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="inspect__note">{t('inspect.hiddenTextNote')}</p>
        {blocked && <p className="inspect__note">{t('inspect.signedBlocked')}</p>}
      </div>
    </Dialog>
  );
}
