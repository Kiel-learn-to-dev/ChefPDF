import { useEffect } from 'react';
import { chef } from '../lib/bridge';
import { call } from '../lib/rpc';
import { readRecoverable, sortRecoverable } from '../features/recovery/recoveryModel';
import { isJobEvent, useJobStore } from '../features/jobs/jobStore';
import { setLanguage } from '../i18n';
import { closeDoc, openFiles } from './actions';
import { useCoreRecovery } from './CoreStatusBanner';
import { useDocs } from './state/documents';
import { useSettings } from './state/settings';
import { useUi } from './state/ui';
import { useThemeSync } from './theme';

let allowClose = false;

/** Crash recovery (A9): offers the sessions the core kept, then drops old recovery files once. */
async function checkRecovery() {
  try {
    const list = sortRecoverable(readRecoverable(await call('recovery.list', {})));
    if (list.length > 0) useUi.getState().openDialog('recovery', list);
    await call('recovery.cleanup', {}).catch(() => undefined);
  } catch {
    // The core is not up yet: no prompt this time.
  }
}

/** Load settings, wire bridge events, open files passed at launch, guard unsaved changes. */
export function useBootstrap() {
  const theme = useSettings((s) => s.settings.theme);
  const language = useSettings((s) => s.settings.language);
  useThemeSync(theme);

  useEffect(() => setLanguage(language), [language]);

  useEffect(() => {
    const off = chef().onEvent((ev) => {
      switch (ev.type) {
        case 'rpc':
          if (isJobEvent(ev.name)) {
            useJobStore
              .getState()
              .handle({ name: ev.name, payload: ev.payload } as Parameters<
                ReturnType<typeof useJobStore.getState>['handle']
              >[0]);
          }
          break;
        case 'open-files':
          void openFiles(ev.paths);
          break;
        case 'core-status': {
          const prev = useUi.getState().coreStatus;
          useUi.getState().set({ coreStatus: ev.status });
          if (ev.status === 'ready' && (prev === 'crashed' || prev === 'restarting')) {
            useCoreRecovery.setState({ needsReopen: true });
          }
          break;
        }
      }
    });
    void (async () => {
      await useSettings.getState().load();
      const initial = await chef()
        .app.initialFiles()
        .catch(() => []);
      if (initial.length) await openFiles(initial);
      await checkRecovery();
    })();
    return off;
  }, []);

  // Unsaved changes when the window closes: cancel the close, ask per document, then close again.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowClose) return;
      const dirty = useDocs.getState().docs.filter((d) => d.state.dirty);
      if (dirty.length === 0) return;
      e.preventDefault();
      e.returnValue = '';
      void (async () => {
        for (const d of dirty) {
          if (!(await closeDoc(d.id))) return;
        }
        allowClose = true;
        window.close();
      })();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
