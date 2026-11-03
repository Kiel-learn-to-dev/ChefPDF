/**
 * "Kiểm tra trước khi gửi" (J5; T5.03): one button runs the checklist of preflight.check
 * (metadata, leftover data, unflattened forms, size limit, signatures...). Each failing item has
 * a "Sửa" button that runs its fix op (or opens the dialog that handles it). The checklist runs
 * again after every fix.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, CircleX, ClipboardCheck } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi, type DialogId } from '../../app/state/ui';
import { runDocOp } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Select } from '../../components/Form';
import { toast } from '../../components/Toast';
import type { OpParams } from '../../lib/ops';
import { runOp } from '../../lib/rpc';
import {
  SIZE_LIMITS_MB,
  attentionItems,
  countByStatus,
  fixActionOf,
  maxBytesOf,
  readChecklist,
  type CheckItem,
  type CheckStatus,
} from './preflightModel';
import './preflight.css';

const ICONS: Record<CheckStatus, ReactNode> = {
  ok: <CircleCheck size={16} aria-hidden />,
  warn: <CircleAlert size={16} aria-hidden />,
  fail: <CircleX size={16} aria-hidden />,
};

/** Kiểm tra trước khi gửi (J5). */
export function PreflightDialog() {
  const { t, i18n } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const openDialog = useUi((s) => s.openDialog);
  const [limitMb, setLimitMb] = useState<number>(0);
  const [items, setItems] = useState<CheckItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const docId = doc?.id;
  const docName = doc?.name ?? '';

  const check = useCallback(
    async (mb: number) => {
      if (!docId) return;
      try {
        const maxBytes = maxBytesOf(mb);
        const r = await runOp('preflight.check', maxBytes === undefined ? {} : { maxBytes }, {
          sessionId: docId,
          title: t('preflight.job', { name: docName }),
          silent: true,
        });
        setItems(readChecklist(r.data));
      } catch {
        setItems([]);
      } finally {
        setBusy(false);
      }
    },
    [docId, docName, t],
  );

  useEffect(() => {
    // Loads the checklist from the core when the dialog opens (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check(limitMb);
    // Only on open and when the size limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitMb, docId]);

  if (!doc) return null;

  const en = i18n.language === 'en';
  const counts = items ? countByStatus(items) : { ok: 0, warn: 0, fail: 0 };
  const list = items ? attentionItems(items) : [];

  const fix = async (item: CheckItem) => {
    const action = fixActionOf(item);
    if (action.kind === 'dialog') {
      close();
      openDialog(action.dialog as DialogId);
      return;
    }
    if (action.kind !== 'run') return;
    setFixing(item.id);
    const r = await runDocOp(
      doc.id,
      action.opId,
      action.params as OpParams[typeof action.opId],
      t('preflight.fixJob', { title: en ? item.titleEn : item.titleVi }),
    );
    setFixing(null);
    if (r) {
      toast.success(t('preflight.title'), t('preflight.fixed'));
      await check(limitMb);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('preflight.title')}
      icon={<ClipboardCheck size={18} />}
      description={t('preflight.description')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => close()}>
            {t('common.close')}
          </Button>
          <Button
            onClick={() => {
              setBusy(true);
              void check(limitMb);
            }}
            disabled={busy}
            loading={busy}
          >
            {t('preflight.run')}
          </Button>
        </>
      }
    >
      <div className="preflight">
        <div className="preflight__toolbar">
          <Select<string>
            id="preflight-limit"
            aria-label={t('preflight.limit')}
            value={String(limitMb)}
            onChange={(v) => setLimitMb(Number(v))}
            options={SIZE_LIMITS_MB.map((mb) => ({
              value: String(mb),
              label: mb === 0 ? t('preflight.noLimit') : t('preflight.limitMb', { mb }),
            }))}
          />
          {items && (
            <span className="preflight__summary" role="status">
              {t('preflight.summary', { ok: counts.ok, warn: counts.warn, fail: counts.fail })}
            </span>
          )}
        </div>

        {items === null ? (
          <p className="preflight__empty">{t('preflight.running')}</p>
        ) : (
          <ul className="preflight__list">
            {list.map((item) => {
              const action = fixActionOf(item);
              const hasFix = action.kind === 'run' || action.kind === 'dialog';
              return (
                <li key={item.id} className={`preflight__item preflight__item--${item.status}`}>
                  <span
                    className="preflight__icon"
                    aria-label={t(`preflight.status.${item.status}`)}
                  >
                    {ICONS[item.status]}
                  </span>
                  <div className="preflight__body">
                    <div className="preflight__title">{en ? item.titleEn : item.titleVi}</div>
                    <DetailLine item={item} />
                    {item.status !== 'ok' && !hasFix && (
                      <p className="preflight__hint">{t('preflight.manual')}</p>
                    )}
                  </div>
                  {item.status !== 'ok' && hasFix && (
                    <Button
                      onClick={() => void fix(item)}
                      disabled={busy || fixing !== null || doc.state.signed}
                      loading={fixing === item.id}
                      title={doc.state.signed ? t('preflight.signedBlocked') : undefined}
                    >
                      {t('preflight.fix')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** One line with the numbers and names of the check (detail keys from the core). */
function DetailLine({ item }: { item: CheckItem }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  for (const [key, value] of Object.entries(item.detail)) {
    if (typeof value === 'number')
      parts.push(`${t(`preflight.detail.${key}`, { defaultValue: key })}: ${value}`);
    else if (typeof value === 'string' && value)
      parts.push(`${t(`preflight.detail.${key}`, { defaultValue: key })}: ${value}`);
    else if (Array.isArray(value) && value.length > 0)
      parts.push(
        `${t(`preflight.detail.${key}`, { defaultValue: key })}: ${value
          .slice(0, 5)
          .map((v) =>
            typeof v === 'string' || typeof v === 'number' ? String(v) : t('preflight.detail.item'),
          )
          .join(', ')}${value.length > 5 ? ' …' : ''}`,
      );
  }
  if (parts.length === 0) return null;
  return <div className="preflight__detail">{parts.join(' · ')}</div>;
}
