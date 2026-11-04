import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight } from 'lucide-react';
import { useActiveDoc } from './state/documents';
import { useUi } from './state/ui';
import { useView } from './state/viewer';
import { IconButton } from '../components/Button';
import { Badge } from '../components/Misc';
import { getViewer } from '../features/viewer/controllers';
import { JobIndicator } from '../features/jobs/JobPanel';
import { useSelection } from '../features/pages/pageStore';
import { isMockBridge } from '../lib/bridge';
import { chipSummary } from '../features/signatures/verifyModel';
import { useVerifyStore, verifyEntry } from '../features/signatures/verifyStore';
import { textLayerLabel, useTextLayer } from '../features/textedit/textLayer';
import { useTextEdit } from '../features/textedit/textEditState';
import { KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';

function PageInput({ docId, page, count }: { docId: string; page: number; count: number }) {
  const { t } = useTranslation();
  // Remounted (key) when the page changes, so the initial value is enough.
  const [value, setValue] = useState(String(page));
  const commit = () => {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= count) getViewer(docId)?.goToPage(n);
    else setValue(String(page));
  };
  return (
    <input
      className="status__page-input"
      value={value}
      inputMode="numeric"
      aria-label={t('status.goToPage')}
      onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') setValue(String(page));
      }}
      size={Math.max(1, String(count).length)}
    />
  );
}

/** Bottom status bar: page x/y, zoom, document state, job indicator. */
export function StatusBar() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const view = useView(doc?.id);
  const tab = useUi((s) => s.functionTab);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const panelOpen = useUi((s) => s.panelOpen);
  const set = useUi((s) => s.set);
  const sel = useSelection(doc?.id);
  const count = doc?.info.pageCount ?? 0;
  const verify = useVerifyStore((s) => (doc ? s.byDoc[doc.id] : undefined)) ?? verifyEntry(doc?.id);
  const chip = chipSummary(verify.items);
  const layerLabel = textLayerLabel(useTextLayer(doc));
  const editMode = useTextEdit((s) => s.active);

  return (
    <footer className="status" aria-label={t('status.label')}>
      {doc ? (
        <>
          {tab !== 'pages' && (
            <IconButton
              size="sm"
              label={t('cmd.toggleSidebar')}
              shortcut="Mod+B"
              pressed={sidebarOpen}
              icon={<PanelLeft size={14} />}
              onClick={() => set({ sidebarOpen: !sidebarOpen })}
            />
          )}
          {tab === 'pages' ? (
            <span className="status__item">
              {t('status.pages', { count })}
              {sel.selected.length > 0 &&
                ` · ${t('status.selected', { count: sel.selected.length })}`}
            </span>
          ) : (
            <span className="status__item status__nav">
              <IconButton
                size="sm"
                label={t('viewer.prevPage')}
                icon={<ChevronLeft size={14} />}
                disabled={view.page <= 1}
                onClick={() => getViewer(doc.id)?.goToPage(view.page - 1)}
              />
              <span>{t('status.page')}</span>
              <PageInput key={view.page} docId={doc.id} page={view.page} count={count} />
              <span>/ {count}</span>
              <IconButton
                size="sm"
                label={t('viewer.nextPage')}
                icon={<ChevronRight size={14} />}
                disabled={view.page >= count}
                onClick={() => getViewer(doc.id)?.goToPage(view.page + 1)}
              />
            </span>
          )}
          {tab !== 'pages' && <span className="status__item">{Math.round(view.scale * 100)}%</span>}
          {editMode && <span className="status__item status__mode">{t('status.mode.edit')}</span>}
          {layerLabel && <span className="status__item">{layerLabel}</span>}
          {doc.state.dirty && (
            <span className="status__item status__dirty">{t('status.unsaved')}</span>
          )}
          {doc.state.pendingEncryption && (
            <span className="status__item status__chip status__chip--warn">
              <KeyRound size={13} aria-hidden />
              {t('security.pendingChip')}
            </span>
          )}
          {chip && (
            <button
              type="button"
              className={`status__item status__chip status__chip--${chip.tone}`}
              onClick={() => useUi.getState().set({ sidebarOpen: true, sidebarTab: 'signatures' })}
            >
              {chip.tone === 'ok' || chip.tone === 'warn' ? (
                <ShieldCheck size={13} aria-hidden />
              ) : chip.tone === 'bad' ? (
                <ShieldAlert size={13} aria-hidden />
              ) : (
                <ShieldQuestion size={13} aria-hidden />
              )}
              {t(chip.key, { count: chip.count })}
            </button>
          )}
        </>
      ) : (
        <span className="status__item">{t('status.ready')}</span>
      )}
      <div className="status__spacer" />
      {isMockBridge() && <Badge>{t('status.mock')}</Badge>}
      <JobIndicator />
      {doc && (
        <IconButton
          size="sm"
          label={t('cmd.togglePanel')}
          pressed={panelOpen}
          icon={<PanelRight size={14} />}
          onClick={() => set({ panelOpen: !panelOpen })}
        />
      )}
    </footer>
  );
}
