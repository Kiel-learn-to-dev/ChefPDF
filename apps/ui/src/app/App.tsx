import { useTranslation } from 'react-i18next';
import { ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '../components/Button';
import { editableCopy } from '../features/pages/pageActions';
import { TooltipProvider } from '../components/Tooltip';
import { Toaster } from '../components/Toast';
import { EmptyState } from '../components/Misc';
import { StartScreen } from '../features/start/StartScreen';
import { Viewer } from '../features/viewer/Viewer';
import { Presentation } from '../features/viewer/Presentation';
import { PageOrganizer } from '../features/pages/PageOrganizer';
import { CommandPalette } from '../features/palette/CommandPalette';
import { useActiveDoc, type DocTab } from './state/documents';
import { READY_TABS, useUi } from './state/ui';
import { useCommands } from './commands';
import { useBootstrap } from './useBootstrap';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { DocumentTabs } from './DocumentTabs';
import { FunctionTabs } from './FunctionTabs';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import { PropertiesPanel } from './PropertiesPanel';
import { StatusBar } from './StatusBar';
import { DialogHost } from './DialogHost';
import { PromptHost } from './PromptHost';
import { DropZone } from './DropZone';
import { CoreStatusBanner } from './CoreStatusBanner';
import './app.css';

function ComingSoonNote({ tab }: { tab: string }) {
  const { t } = useTranslation();
  return (
    <div className="soon-note" role="note">
      <EmptyState
        icon={<Sparkles size={22} />}
        title={t('soonTab.title', { tab: t(`tabs.${tab}`) })}
        text={t(`soonTab.${tab}`)}
      />
    </div>
  );
}

function SignedBanner({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  return (
    <div className="banner banner--info" role="status">
      <ShieldCheck size={15} />
      <span>{t('signed.banner')}</span>
      <Button size="sm" onClick={() => void editableCopy(doc.id)}>
        {t('signed.makeCopy')}
      </Button>
    </div>
  );
}

function Workspace({ doc }: { doc: DocTab }) {
  const tab = useUi((s) => s.functionTab);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const panelOpen = useUi((s) => s.panelOpen);
  const presenting = useUi((s) => s.presenting);
  const organizer = tab === 'pages';
  return (
    <div className="workspace">
      {sidebarOpen && !organizer && <Sidebar doc={doc} />}
      <main className="workspace__main" aria-label={doc.name}>
        {doc.state.signed && <SignedBanner doc={doc} />}
        {!READY_TABS.has(tab) && <ComingSoonNote tab={tab} />}
        {organizer ? <PageOrganizer key={doc.id} doc={doc} /> : <Viewer key={doc.id} doc={doc} />}
      </main>
      {panelOpen && <PropertiesPanel doc={doc} />}
      {presenting && <Presentation doc={doc} />}
    </div>
  );
}

export function App() {
  useBootstrap();
  const commands = useCommands();
  useGlobalShortcuts(commands);
  const doc = useActiveDoc();
  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={200}>
      <div className="app">
        <DocumentTabs />
        <CoreStatusBanner />
        {doc ? (
          <>
            <div className="chrome">
              <FunctionTabs />
              <Toolbar />
            </div>
            <Workspace doc={doc} />
          </>
        ) : (
          <StartScreen />
        )}
        <StatusBar />
      </div>
      <DialogHost />
      <CommandPalette />
      <PromptHost />
      <DropZone />
      <Toaster />
    </TooltipProvider>
  );
}
