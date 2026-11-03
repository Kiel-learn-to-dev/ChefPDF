import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import { useUi } from './state/ui';
import { useDocs } from './state/documents';
import { showError } from './actions';
import { Button } from '../components/Button';
import { toast } from '../components/Toast';
import { call } from '../lib/rpc';
import { restoreAfterCrash } from '../features/recovery/restoreAfterCrash';
import { releasePdf } from '../features/viewer/pdfCache';
import { dropThumbnails } from '../features/viewer/thumbnails';

/** Set when the core came back after a crash: open sessions are gone. */
export const useCoreRecovery = create<{ needsReopen: boolean; pendingIds: string[] }>(() => ({
  needsReopen: false,
  pendingIds: [],
}));

async function reopenAll() {
  const pending = await restoreAfterCrash(
    useCoreRecovery.getState().pendingIds,
    (sessionId) => call('recovery.restore', { sessionId }),
    (id, result) => {
      const doc = useDocs.getState().docs.find((d) => d.id === id);
      if (!doc) return;
      releasePdf(id);
      dropThumbnails(id);
      useDocs.getState().update(id, {
        state: result.state,
        info: result.info,
        password: undefined,
        version: doc.version + 1,
        lastChange: 'all',
        busy: 0,
      });
      for (const warning of result.warnings) toast.warning(doc.name, warning);
    },
    showError,
  );
  useCoreRecovery.setState({ pendingIds: pending, needsReopen: pending.length > 0 });
}

/** Banner for core-status events (core restarting / crashed / back). */
export function CoreStatusBanner() {
  const { t } = useTranslation();
  const [restoring, setRestoring] = useState(false);
  const status = useUi((s) => s.coreStatus);
  const needsReopen = useCoreRecovery((s) => s.needsReopen);
  const hasDocs = useDocs((s) => s.docs.length > 0);

  if (status === 'restarting' || status === 'starting' || status === 'crashed') {
    return (
      <div className="banner banner--warning" role="status">
        {status === 'crashed' ? (
          <CircleAlert size={15} />
        ) : (
          <LoaderCircle size={15} className="spinner" />
        )}
        <span>{t(`core.${status}`)}</span>
      </div>
    );
  }
  if (needsReopen && hasDocs) {
    return (
      <div className="banner banner--info" role="status">
        <RefreshCw size={15} />
        <span>{t('core.recovered')}</span>
        <Button
          size="sm"
          variant="primary"
          disabled={restoring}
          onClick={() => {
            setRestoring(true);
            void reopenAll().finally(() => setRestoring(false));
          }}
        >
          {t('core.reopen')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => useCoreRecovery.setState({ needsReopen: false })}
        >
          {t('common.dismiss')}
        </Button>
      </div>
    );
  }
  return null;
}
