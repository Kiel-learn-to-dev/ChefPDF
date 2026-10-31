import { useTranslation } from 'react-i18next';
import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import { useUi } from './state/ui';
import { useDocs } from './state/documents';
import { useViewStore } from './state/viewer';
import { openFiles } from './actions';
import { Button } from '../components/Button';
import { releasePdf } from '../features/viewer/pdfCache';
import { dropThumbnails } from '../features/viewer/thumbnails';

/** Set when the core came back after a crash: open sessions are gone. */
export const useCoreRecovery = create<{ needsReopen: boolean }>(() => ({ needsReopen: false }));

async function reopenAll() {
  const docs = useDocs.getState().docs;
  const paths = docs.map((d) => d.state.sourcePath).filter((p): p is string => !!p);
  for (const d of docs) {
    useDocs.getState().remove(d.id);
    useViewStore.getState().drop(d.id);
    releasePdf(d.id);
    dropThumbnails(d.id);
  }
  useCoreRecovery.setState({ needsReopen: false });
  await openFiles(paths);
}

/** Banner for core-status events (core restarting / crashed / back). */
export function CoreStatusBanner() {
  const { t } = useTranslation();
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
        <Button size="sm" variant="primary" onClick={() => void reopenAll()}>
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
