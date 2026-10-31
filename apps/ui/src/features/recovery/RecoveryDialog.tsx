/**
 * Crash recovery dialog (A9, T5.10): shown at start when the core kept sessions from a crash.
 * Restore opens the document as a tab (the core's restored state, with its warnings); discard
 * deletes the recovery file. Nothing is restored without the user's choice.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import type { RecoverableSession } from '@chef/contracts';
import { showError } from '../../app/actions';
import { useDocs } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { call } from '../../lib/rpc';
import { readRecoverable, recoveryName, sortRecoverable } from './recoveryModel';
import './recovery.css';

/** The sessions the app found at start (set by useBootstrap in dialogData). */
export function RecoveryDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const data = useUi((s) => s.dialogData);
  const [items, setItems] = useState<RecoverableSession[]>(() =>
    sortRecoverable(readRecoverable(data)),
  );
  const [busy, setBusy] = useState(false);

  const forget = (id: string) => setItems((list) => list.filter((s) => s.sessionId !== id));
  const finishIfEmpty = (remaining: RecoverableSession[]) => {
    if (remaining.length === 0) close();
  };

  const restore = async (s: RecoverableSession) => {
    setBusy(true);
    try {
      const r = await call('recovery.restore', { sessionId: s.sessionId });
      const name = recoveryName(s) ?? t('recovery.untitled');
      useDocs.getState().add({ id: r.state.sessionId, name, state: r.state, info: r.info });
      for (const w of r.warnings) toast.warning(name, w);
      toast.success(name, t('recovery.restored'));
      forget(s.sessionId);
      finishIfEmpty(items.filter((x) => x.sessionId !== s.sessionId));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const discard = async (list: RecoverableSession[]) => {
    setBusy(true);
    try {
      for (const s of list) {
        await call('recovery.discard', { sessionId: s.sessionId });
        forget(s.sessionId);
      }
      finishIfEmpty(items.filter((x) => !list.some((d) => d.sessionId === x.sessionId)));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('recovery.title')}
      description={t('recovery.description')}
      icon={<History size={18} />}
      size="lg"
      footer={
        <>
          <Button disabled={busy || items.length === 0} onClick={() => void discard(items)}>
            {t('recovery.discardAll')}
          </Button>
          <Button variant="secondary" onClick={close}>
            {t('recovery.later')}
          </Button>
        </>
      }
    >
      <ul className="recovery-list">
        {items.map((s) => (
          <li key={s.sessionId} className="recovery-list__row">
            <div className="recovery-list__info">
              <strong>{recoveryName(s) ?? t('recovery.untitled')}</strong>
              <span className="recovery-list__meta">
                {t('recovery.meta', {
                  time: new Date(s.lastModified).toLocaleString(),
                  pages: s.pages,
                })}
                {s.hasUnsavedChanges ? ` · ${t('recovery.unsaved')}` : ''}
              </span>
            </div>
            <div className="recovery-list__actions">
              <Button variant="primary" disabled={busy} onClick={() => void restore(s)}>
                {t('recovery.restore')}
              </Button>
              <Button disabled={busy} onClick={() => void discard([s])}>
                {t('recovery.discard')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
