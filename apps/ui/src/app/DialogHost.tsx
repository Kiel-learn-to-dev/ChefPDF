import { useTranslation } from 'react-i18next';
import { Keyboard } from 'lucide-react';
import { useUi } from './state/ui';
import { useCommands } from './commands';
import { Dialog } from '../components/Dialog';
import { Kbd } from '../components/Kbd';
import { MergeDialog } from '../features/merge/MergeDialog';
import { SplitDialog } from '../features/split/SplitDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { PrintDialog } from '../features/print/PrintDialog';
import { PropertiesDialog } from '../features/viewer/PropertiesDialog';
import { ScanDialog } from '../features/scan/ScanDialog';
import { CertManagerDialog } from '../features/certs/CertManagerDialog';
import { TokenDiagnosticWizard } from '../features/certs/TokenDiagnosticWizard';
import { TrustDialog } from '../features/signatures/TrustDialog';
import { TemplateStudioDialog } from '../features/signTemplate/TemplateStudioDialog';
import { LibraryDialog } from '../features/sigLibrary/LibraryDialog';
import { SignDocDialog } from '../features/sign/SignDocDialog';
import { BatchSignDialog } from '../features/sign/BatchSignDialog';
import {
  InsertBlankDialog,
  InsertFromFileDialog,
  InsertImagesDialog,
} from '../features/pages/InsertDialogs';

function ShortcutsDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const commands = useCommands().filter((c) => c.shortcut);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<Keyboard size={18} />}
      title={t('cmd.shortcuts')}
      size="lg"
    >
      <dl className="shortcuts">
        {commands.map((c) => (
          <div key={c.id} className="shortcuts__row">
            <dt>{c.title}</dt>
            <dd>
              <Kbd keys={c.shortcut!} />
            </dd>
          </div>
        ))}
        <div className="shortcuts__row">
          <dt>{t('shortcuts.organizerKeys')}</dt>
          <dd>
            <Kbd keys="Delete" /> <Kbd keys="Mod+A" /> <Kbd keys="Alt+ArrowLeft" />{' '}
            <Kbd keys="Alt+ArrowRight" />
          </dd>
        </div>
      </dl>
    </Dialog>
  );
}

/** Renders the currently open feature dialog. */
export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  switch (dialog) {
    case 'merge':
      return <MergeDialog />;
    case 'split':
      return <SplitDialog />;
    case 'settings':
      return <SettingsDialog />;
    case 'print':
      return <PrintDialog />;
    case 'properties':
      return <PropertiesDialog />;
    case 'insertBlank':
      return <InsertBlankDialog />;
    case 'insertFromFile':
      return <InsertFromFileDialog />;
    case 'insertImages':
      return <InsertImagesDialog />;
    case 'scan':
      return <ScanDialog />;
    case 'certs':
      return <CertManagerDialog />;
    case 'tokenWizard':
      return <TokenDiagnosticWizard />;
    case 'trust':
      return <TrustDialog />;
    case 'signTemplates':
      return <TemplateStudioDialog />;
    case 'sigLibrary':
      return <LibraryDialog />;
    case 'signDoc':
      return <SignDocDialog />;
    case 'batchSign':
      return <BatchSignDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    default:
      return null;
  }
}
