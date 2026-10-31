/**
 * Central command registry: used by the command palette (A3), keyboard
 * shortcuts and toolbars, so every action has one definition.
 */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  BookOpen,
  ClipboardPaste,
  Columns2,
  Combine,
  Copy,
  Crop,
  FileInput,
  FileOutput,
  FilePlus,
  FileSignature,
  FileText,
  FolderOpen,
  Home,
  ImagePlus,
  Info,
  LayoutGrid,
  ListTree,
  Maximize,
  MoveHorizontal,
  PanelLeft,
  PanelRight,
  Presentation,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanLine,
  ScanText,
  Search,
  Settings,
  Shrink,
  Split,
  SquarePlus,
  Stamp,
  StretchVertical,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  RectangleVertical,
  Keyboard,
  KeyRound,
  PenLine,
} from 'lucide-react';
import { closeDoc, openWithDialog, redo, saveDoc, undo } from './actions';
import { useDocs, type DocTab } from './state/documents';
import { useUi, type FunctionTab } from './state/ui';
import { useViewStore, type ViewMode } from './state/viewer';
import { getViewer } from '../features/viewer/controllers';
import {
  deletePages,
  duplicatePages,
  extractPages,
  insertBlank,
  insertClipboardImage,
  insertionPoint,
  rotatePages,
  selectAll,
  targetPages,
} from '../features/pages/pageActions';
import { getSelection } from '../features/pages/pageStore';
import { openScanFlow } from '../features/scan/ScanDialog';

export type CommandGroup = 'file' | 'edit' | 'view' | 'pages' | 'tools' | 'app' | 'soon';

export interface Command {
  id: string;
  title: string;
  /** Shorter label for toolbars. */
  short?: string;
  keywords?: string[];
  group: CommandGroup;
  icon?: ReactNode;
  shortcut?: string;
  /** Extra shortcuts (not displayed). */
  altShortcuts?: string[];
  enabled: boolean;
  /** Why the command is disabled, shown as a tooltip where the toolbar can show one. */
  disabledHint?: string;
  /** Feature planned for a later milestone. */
  comingSoon?: boolean;
  /** Allow the shortcut while typing in an input. */
  inInputs?: boolean;
  run(): void;
}

interface Ctx {
  t: TFunction;
  doc: DocTab | undefined;
  docCount: number;
  functionTab: FunctionTab;
  presenting: boolean;
}

const I = 16;

function build({ t, doc, docCount, functionTab }: Ctx): Command[] {
  const ui = useUi.getState();
  const has = !!doc;
  const id = doc?.id ?? '';
  const viewer = () => getViewer(id);
  const pagesReady = has && doc.busy === 0;
  // Signed documents: rewrite ops are blocked by the core (BLOCKED_BY_SIGNATURE); extract/split/merge still work.
  const canRewrite = pagesReady && !doc.state.signed;
  const canScan = pagesReady && !doc.state.signed;
  const mode = (m: ViewMode) => () => {
    if (viewer()) viewer()!.setMode(m);
    else useViewStore.getState().patch(id, { mode: m });
  };
  const showView = () => ui.set({ functionTab: 'view' });
  const setTab = (tab: FunctionTab) => () => ui.set({ functionTab: tab });
  const soon = (cid: string, title: string, icon: ReactNode, keywords: string[] = []): Command => ({
    id: `soon.${cid}`,
    title,
    keywords,
    group: 'soon',
    icon,
    enabled: false,
    comingSoon: true,
    run: () => undefined,
  });

  return [
    // File
    {
      id: 'file.open',
      title: t('cmd.open'),
      keywords: ['open', 'mo file'],
      group: 'file',
      icon: <FolderOpen size={I} />,
      shortcut: 'Mod+O',
      enabled: true,
      inInputs: true,
      run: () => void openWithDialog(),
    },
    {
      id: 'file.save',
      title: t('cmd.save'),
      keywords: ['save'],
      group: 'file',
      icon: <Save size={I} />,
      shortcut: 'Mod+S',
      enabled: has,
      inInputs: true,
      run: () => void saveDoc(id),
    },
    {
      id: 'file.saveAs',
      title: t('cmd.saveAs'),
      keywords: ['save as'],
      group: 'file',
      icon: <FileInput size={I} />,
      shortcut: 'Mod+Shift+S',
      enabled: has,
      inInputs: true,
      run: () => void saveDoc(id, true),
    },
    {
      id: 'file.print',
      title: t('cmd.print'),
      short: t('toolbar.print'),
      keywords: ['print'],
      group: 'file',
      icon: <Printer size={I} />,
      shortcut: 'Mod+P',
      enabled: has,
      inInputs: true,
      run: () => ui.openDialog('print'),
    },
    {
      id: 'file.properties',
      title: t('cmd.properties'),
      keywords: ['properties', 'metadata', 'thong tin'],
      group: 'file',
      icon: <Info size={I} />,
      shortcut: functionTab === 'pages' ? undefined : 'Mod+D',
      enabled: has,
      run: () => ui.openDialog('properties'),
    },
    {
      id: 'file.close',
      title: t('cmd.close'),
      keywords: ['close'],
      group: 'file',
      icon: <X size={I} />,
      shortcut: 'Mod+W',
      enabled: has,
      inInputs: true,
      run: () => void closeDoc(id),
    },
    // Edit
    {
      id: 'edit.undo',
      title: t('cmd.undo'),
      keywords: ['undo'],
      group: 'edit',
      icon: <Undo2 size={I} />,
      shortcut: 'Mod+Z',
      enabled: has && doc.state.canUndo,
      run: () => void undo(id),
    },
    {
      id: 'edit.redo',
      title: t('cmd.redo'),
      keywords: ['redo'],
      group: 'edit',
      icon: <Redo2 size={I} />,
      shortcut: 'Mod+Y',
      altShortcuts: ['Mod+Shift+Z'],
      enabled: has && doc.state.canRedo,
      run: () => void redo(id),
    },
    // View
    {
      id: 'view.find',
      title: t('cmd.find'),
      short: t('toolbar.find'),
      keywords: ['search', 'find'],
      group: 'view',
      icon: <Search size={I} />,
      shortcut: 'Mod+F',
      enabled: has,
      inInputs: true,
      run: () => (showView(), ui.openFind()),
    },
    {
      id: 'view.zoomIn',
      title: t('cmd.zoomIn'),
      keywords: ['zoom'],
      group: 'view',
      icon: <ZoomIn size={I} />,
      shortcut: 'Mod+=',
      altShortcuts: ['Mod++'],
      enabled: has,
      run: () => viewer()?.zoomBy(1),
    },
    {
      id: 'view.zoomOut',
      title: t('cmd.zoomOut'),
      keywords: ['zoom'],
      group: 'view',
      icon: <ZoomOut size={I} />,
      shortcut: 'Mod+-',
      enabled: has,
      run: () => viewer()?.zoomBy(-1),
    },
    {
      id: 'view.actualSize',
      title: t('cmd.actualSize'),
      keywords: ['100%', 'zoom'],
      group: 'view',
      shortcut: 'Mod+0',
      enabled: has,
      run: () => viewer()?.setScaleValue('1'),
    },
    {
      id: 'view.fitWidth',
      title: t('cmd.fitWidth'),
      keywords: ['zoom', 'width'],
      group: 'view',
      icon: <MoveHorizontal size={I} />,
      enabled: has,
      run: () => viewer()?.setScaleValue('page-width'),
    },
    {
      id: 'view.fitPage',
      title: t('cmd.fitPage'),
      keywords: ['zoom', 'page'],
      group: 'view',
      icon: <Maximize size={I} />,
      enabled: has,
      run: () => viewer()?.setScaleValue('page-fit'),
    },
    {
      id: 'view.rotateCw',
      title: t('cmd.rotateViewCw'),
      keywords: ['rotate'],
      group: 'view',
      icon: <RotateCw size={I} />,
      shortcut: 'Mod+]',
      enabled: has,
      run: () => viewer()?.rotateBy(90),
    },
    {
      id: 'view.rotateCcw',
      title: t('cmd.rotateViewCcw'),
      keywords: ['rotate'],
      group: 'view',
      icon: <RotateCcw size={I} />,
      shortcut: 'Mod+[',
      enabled: has,
      run: () => viewer()?.rotateBy(-90),
    },
    {
      id: 'view.single',
      title: t('cmd.modeSingle'),
      keywords: ['single page'],
      group: 'view',
      icon: <RectangleVertical size={I} />,
      enabled: has,
      run: mode('single'),
    },
    {
      id: 'view.continuous',
      title: t('cmd.modeContinuous'),
      keywords: ['scroll', 'continuous'],
      group: 'view',
      icon: <StretchVertical size={I} />,
      enabled: has,
      run: mode('continuous'),
    },
    {
      id: 'view.twoPage',
      title: t('cmd.modeTwoPage'),
      keywords: ['two page', 'spread'],
      group: 'view',
      icon: <Columns2 size={I} />,
      enabled: has,
      run: mode('twoPage'),
    },
    {
      id: 'view.book',
      title: t('cmd.modeBook'),
      keywords: ['book', 'spread'],
      group: 'view',
      icon: <BookOpen size={I} />,
      enabled: has,
      run: mode('book'),
    },
    {
      id: 'view.presentation',
      title: t('cmd.presentation'),
      short: t('toolbar.present'),
      keywords: ['fullscreen', 'slideshow', 'toan man hinh'],
      group: 'view',
      icon: <Presentation size={I} />,
      shortcut: 'F5',
      enabled: has,
      run: () => ui.set({ presenting: true }),
    },
    {
      id: 'view.snapshot',
      title: t('cmd.snapshot'),
      short: t('toolbar.snapshot'),
      keywords: ['snapshot', 'screenshot', 'anh', 'chup'],
      group: 'view',
      icon: <Crop size={I} />,
      enabled: has,
      run: () => (showView(), ui.set({ tool: ui.tool === 'snapshot' ? 'select' : 'snapshot' })),
    },
    {
      id: 'view.selectText',
      title: t('cmd.selectText'),
      keywords: ['select', 'copy', 'text'],
      group: 'view',
      icon: <ScanText size={I} />,
      enabled: has,
      run: () => ui.set({ tool: 'select' }),
    },
    {
      id: 'view.sidebar',
      title: t('cmd.toggleSidebar'),
      keywords: ['sidebar', 'thumbnails'],
      group: 'view',
      icon: <PanelLeft size={I} />,
      shortcut: 'Mod+B',
      enabled: has,
      run: () => ui.set({ sidebarOpen: !useUi.getState().sidebarOpen }),
    },
    {
      id: 'view.outline',
      title: t('cmd.outline'),
      keywords: ['bookmarks', 'outline', 'toc'],
      group: 'view',
      icon: <ListTree size={I} />,
      enabled: has,
      run: () => ui.set({ sidebarOpen: true, sidebarTab: 'outline', functionTab: 'view' }),
    },
    {
      id: 'view.panel',
      title: t('cmd.togglePanel'),
      keywords: ['properties panel'],
      group: 'view',
      icon: <PanelRight size={I} />,
      enabled: has,
      run: () => ui.set({ panelOpen: !useUi.getState().panelOpen }),
    },
    // Pages
    {
      id: 'pages.organizer',
      title: t('cmd.organizer'),
      keywords: ['pages', 'organize', 'sap xep', 'thumbnail'],
      group: 'pages',
      icon: <LayoutGrid size={I} />,
      enabled: has,
      run: setTab('pages'),
    },
    {
      id: 'pages.rotateLeft',
      title: t('cmd.rotatePagesLeft'),
      short: t('pages.rotateLeft'),
      keywords: ['rotate'],
      group: 'pages',
      icon: <RotateCcw size={I} />,
      enabled: canRewrite,
      run: () => void rotatePages(id, 270),
    },
    {
      id: 'pages.rotateRight',
      title: t('cmd.rotatePagesRight'),
      short: t('pages.rotateRight'),
      keywords: ['rotate'],
      group: 'pages',
      icon: <RotateCw size={I} />,
      enabled: canRewrite,
      run: () => void rotatePages(id, 90),
    },
    {
      id: 'pages.delete',
      title: t('cmd.deletePages'),
      short: t('pages.delete'),
      keywords: ['delete', 'remove'],
      group: 'pages',
      icon: <Trash2 size={I} />,
      shortcut: functionTab === 'pages' ? 'Delete' : undefined,
      enabled: canRewrite && targetPages(id).length < (doc?.info.pageCount ?? 0),
      run: () =>
        functionTab === 'pages' && getSelection(id).selected.length === 0
          ? undefined
          : void deletePages(id),
    },
    {
      id: 'pages.duplicate',
      title: t('cmd.duplicatePages'),
      short: t('pages.duplicate'),
      keywords: ['duplicate', 'copy'],
      group: 'pages',
      icon: <Copy size={I} />,
      shortcut: functionTab === 'pages' ? 'Mod+D' : undefined,
      enabled: canRewrite,
      run: () => void duplicatePages(id),
    },
    {
      id: 'pages.extract',
      title: t('cmd.extractPages'),
      short: t('pages.extract'),
      keywords: ['extract'],
      group: 'pages',
      icon: <FileOutput size={I} />,
      enabled: pagesReady,
      run: () => void extractPages(id),
    },
    {
      id: 'pages.insertBlank',
      title: t('cmd.insertBlank'),
      keywords: ['insert', 'blank'],
      group: 'pages',
      icon: <SquarePlus size={I} />,
      enabled: canRewrite,
      run: () =>
        functionTab === 'pages'
          ? ui.openDialog('insertBlank')
          : void insertBlank(id, insertionPoint(id), 1),
    },
    {
      id: 'pages.insertFromFile',
      title: t('cmd.insertFromFile'),
      keywords: ['insert', 'file'],
      group: 'pages',
      icon: <FilePlus size={I} />,
      enabled: canRewrite,
      run: () => ui.openDialog('insertFromFile'),
    },
    {
      id: 'pages.insertImages',
      title: t('cmd.insertImages'),
      keywords: ['insert', 'image', 'picture'],
      group: 'pages',
      icon: <ImagePlus size={I} />,
      enabled: canRewrite,
      run: () => ui.openDialog('insertImages'),
    },
    {
      id: 'pages.insertClipboard',
      title: t('cmd.insertClipboard'),
      keywords: ['paste', 'clipboard'],
      group: 'pages',
      icon: <ClipboardPaste size={I} />,
      enabled: canRewrite,
      run: () => void insertClipboardImage(id),
    },
    {
      id: 'pages.selectAll',
      title: t('cmd.selectAllPages'),
      keywords: ['select all'],
      group: 'pages',
      shortcut: functionTab === 'pages' ? 'Mod+A' : undefined,
      enabled: has,
      run: () => (setTab('pages')(), selectAll(id)),
    },
    // Sign & security: certificate files and USB tokens (T3.02-T3.04)
    {
      id: 'sign.certs',
      title: t('cmd.certs'),
      short: t('cmd.certs'),
      keywords: ['certificate', 'token', 'pfx', 'p12', 'usb', 'chung thu', 'chu ky', 'driver'],
      group: 'tools',
      icon: <KeyRound size={I} />,
      enabled: true,
      run: () => ui.openDialog('certs'),
    },
    // Tools
    {
      id: 'tools.merge',
      title: t('cmd.merge'),
      short: t('toolbar.merge'),
      keywords: ['merge', 'combine', 'gop', 'noi'],
      group: 'tools',
      icon: <Combine size={I} />,
      enabled: true,
      run: () => ui.openDialog('merge'),
    },
    {
      id: 'tools.split',
      title: t('cmd.split'),
      short: t('toolbar.split'),
      keywords: ['split', 'chia'],
      group: 'tools',
      icon: <Split size={I} />,
      enabled: has,
      run: () => ui.openDialog('split'),
    },
    {
      id: 'tools.scan',
      title: t('cmd.scan'),
      short: t('toolbar.scan'),
      keywords: ['scan', 'ban scan', 'chuyen thanh ban scan', 'anh', 'image'],
      group: 'tools',
      icon: <ScanLine size={I} />,
      // Without a document the command asks for a PDF first; signed documents are blocked by the core.
      enabled: !has || canScan,
      disabledHint: doc?.state.signed ? t('scan.signedBlocked') : undefined,
      run: () => {
        if (has) ui.openDialog('scan');
        else void openScanFlow();
      },
    },
    // App
    {
      id: 'app.home',
      title: t('cmd.home'),
      keywords: ['start', 'home', 'bat dau'],
      group: 'app',
      icon: <Home size={I} />,
      enabled: docCount > 0,
      run: () => useDocs.getState().activate(null),
    },
    {
      id: 'app.settings',
      title: t('cmd.settings'),
      keywords: ['settings', 'preferences', 'tuy chon', 'ngon ngu', 'giao dien'],
      group: 'app',
      icon: <Settings size={I} />,
      shortcut: 'Mod+,',
      enabled: true,
      inInputs: true,
      run: () => ui.openDialog('settings'),
    },
    {
      id: 'app.shortcuts',
      title: t('cmd.shortcuts'),
      keywords: ['keyboard', 'shortcuts', 'phim tat'],
      group: 'app',
      icon: <Keyboard size={I} />,
      enabled: true,
      run: () => ui.openDialog('shortcuts'),
    },
    {
      id: 'app.palette',
      title: t('cmd.palette'),
      keywords: ['command'],
      group: 'app',
      shortcut: 'Mod+K',
      enabled: true,
      inInputs: true,
      run: () => ui.set({ paletteOpen: !useUi.getState().paletteOpen }),
    },
    {
      id: 'app.nextTab',
      title: t('cmd.nextTab'),
      group: 'app',
      shortcut: 'Ctrl+Tab',
      enabled: docCount > 1,
      inInputs: true,
      run: () => cycleTab(1),
    },
    {
      id: 'app.prevTab',
      title: t('cmd.prevTab'),
      group: 'app',
      shortcut: 'Ctrl+Shift+Tab',
      enabled: docCount > 1,
      inInputs: true,
      run: () => cycleTab(-1),
    },
    // Coming soon (later milestones) so the palette can still find them.
    soon('sign', t('soon.sign'), <FileSignature size={I} />, ['sign', 'signature', 'chu ky']),
    {
      ...soon('placeField', t('sign.placeField'), <PenLine size={I} />, [
        'signature field',
        'o ky',
      ]),
      disabledHint: t('sign.soonHint'),
    },
    {
      ...soon('signDoc', t('sign.signDoc'), <FileSignature size={I} />, [
        'sign pdf',
        'ky tai lieu',
      ]),
      disabledHint: t('sign.soonHint'),
    },
    soon('stamp', t('soon.stamp'), <Stamp size={I} />, ['stamp', 'con dau']),
    soon('compress', t('soon.compress'), <Shrink size={I} />, ['compress', 'giam dung luong']),
    soon('editText', t('soon.editText'), <FileText size={I} />, ['edit', 'sua chu']),
    soon('export', t('soon.export'), <FileOutput size={I} />, ['export', 'word', 'docx']),
  ];
}

function cycleTab(dir: 1 | -1) {
  const { docs, activeId, activate } = useDocs.getState();
  if (docs.length === 0) return;
  const i = docs.findIndex((d) => d.id === activeId);
  const next = docs[(i + dir + docs.length) % docs.length];
  if (next) activate(next.id);
}

export function useCommands(): Command[] {
  const { t } = useTranslation();
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId));
  const docCount = useDocs((s) => s.docs.length);
  const functionTab = useUi((s) => s.functionTab);
  const presenting = useUi((s) => s.presenting);
  // Selection changes affect enablement of page commands.
  const tool = useUi((s) => s.tool);
  return useMemo(
    () => build({ t, doc, docCount, functionTab, presenting }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, doc, docCount, functionTab, presenting, tool],
  );
}

export function findCommand(commands: Command[], id: string): Command | undefined {
  return commands.find((c) => c.id === id);
}
