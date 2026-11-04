import { create } from 'zustand';

export const FUNCTION_TABS = [
  'view',
  'pages',
  'edit',
  'annotate',
  'forms',
  'sign',
  'export',
  'workflow',
] as const;
export type FunctionTab = (typeof FUNCTION_TABS)[number];
/** Tabs that have tools in v0.1. */
export const READY_TABS: ReadonlySet<FunctionTab> = new Set<FunctionTab>([
  'view',
  'pages',
  'edit',
  'annotate',
  'forms',
  'sign',
  'export',
  'workflow',
]);

export type SidebarTab = 'thumbnails' | 'outline' | 'signatures' | 'layers' | 'notes';
export type ViewerTool = 'select' | 'snapshot';
export type DialogId =
  | 'merge'
  | 'split'
  | 'print'
  | 'properties'
  | 'settings'
  | 'insertBlank'
  | 'insertFromFile'
  | 'insertImages'
  | 'scan'
  | 'certs'
  | 'tokenWizard'
  | 'trust'
  | 'signTemplates'
  | 'sigLibrary'
  | 'signDoc'
  | 'batchSign'
  | 'overlayText'
  | 'overlayImage'
  | 'overlayWatermark'
  | 'overlayHeaderFooter'
  | 'overlayPageNumbers'
  | 'overlayCode'
  | 'overlayLetterhead'
  | 'overlayBates'
  | 'overlayManager'
  | 'stamp'
  | 'seam'
  | 'initials'
  | 'recovery'
  | 'security'
  | 'inspect'
  | 'preflight'
  | 'compress'
  | 'pdfToImages'
  | 'documentExport'
  | 'batchExport'
  | 'toc'
  | 'layoutReview'
  | 'rename'
  | 'cropReview'
  | 'batchCrop'
  | 'forms'
  | 'imagesToPdf'
  | 'web2pdf'
  | 'verifyBatch'
  | 'docTools'
  | 'repair'
  | 'color'
  | 'pageReplace'
  | 'pageCrop'
  | 'pageBlank'
  | 'pageGridSplit'
  | 'smartSplit'
  | 'watermarkRemove'
  | 'backgroundRemove'
  | 'removeSimilar'
  | 'redact'
  | 'findReplace'
  | 'linkDialog'
  | 'capture'
  | 'dewarp'
  | 'spine'
  | 'finger'
  | 'watch'
  | 'shortcuts'
  | 'workflow';

export type CoreStatus = 'starting' | 'ready' | 'crashed' | 'restarting';

interface UiState {
  functionTab: FunctionTab;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  panelOpen: boolean;
  jobPanelOpen: boolean;
  paletteOpen: boolean;
  findOpen: boolean;
  /** Bumps to request focus of the find input. */
  findFocusTick: number;
  tool: ViewerTool;
  presenting: boolean;
  dialog: DialogId | null;
  /** Extra data for the open dialog (e.g. preselected files for merge). */
  dialogData: unknown;
  coreStatus: CoreStatus;
  set(patch: Partial<Omit<UiState, 'set' | 'openDialog' | 'closeDialog' | 'openFind'>>): void;
  openDialog(id: DialogId, data?: unknown): void;
  closeDialog(): void;
  openFind(): void;
}

export const useUi = create<UiState>((set) => ({
  functionTab: 'view',
  sidebarOpen: true,
  sidebarTab: 'thumbnails',
  panelOpen: true,
  jobPanelOpen: false,
  paletteOpen: false,
  findOpen: false,
  findFocusTick: 0,
  tool: 'select',
  presenting: false,
  dialog: null,
  dialogData: undefined,
  coreStatus: 'ready',
  set: (patch) => set(patch),
  openDialog: (id, data) => set({ dialog: id, dialogData: data, paletteOpen: false }),
  closeDialog: () => set({ dialog: null, dialogData: undefined }),
  openFind: () => set((s) => ({ findOpen: true, findFocusTick: s.findFocusTick + 1 })),
}));
