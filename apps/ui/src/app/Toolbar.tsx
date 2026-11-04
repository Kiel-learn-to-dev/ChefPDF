import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  ChevronDown,
  Columns2,
  Ellipsis,
  FilePlus,
  Minus,
  Moon,
  Plus,
  RectangleVertical,
  Redo2,
  Save,
  Sparkles,
  StretchVertical,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCommands, findCommand, type Command } from './commands';
import { useActiveDoc } from './state/documents';
import { READY_TABS, useUi } from './state/ui';
import { useView, useViewStore, ZOOM_STEPS, type ViewMode } from './state/viewer';
import { IconButton } from '../components/Button';
import { DropdownMenu, type MenuEntry } from '../components/Menu';
import { Separator } from '../components/Misc';
import { Slider } from '../components/Slider';
import { getViewer } from '../features/viewer/controllers';
import { usePageStore, useSelection } from '../features/pages/pageStore';
import { useObjectEdit } from '../features/objects/objectState';
import { useEraseState } from '../features/erase/eraseState';
import { useTextEdit } from '../features/textedit/textEditState';
import { useAnnotUi } from '../features/annots/annotState';

type Item =
  | { kind: 'cmd'; id: string; label?: boolean; pressed?: boolean }
  | { kind: 'zoom' }
  | { kind: 'viewMode' }
  | { kind: 'night' }
  | { kind: 'split' }
  | { kind: 'insert' }
  | { kind: 'sep'; id: string };

function CmdButton({
  cmd,
  label,
  pressed,
}: {
  cmd: Command | undefined;
  label?: boolean;
  pressed?: boolean;
}) {
  if (!cmd) return null;
  const button = (
    <IconButton
      label={label && cmd.short ? cmd.short : cmd.title}
      icon={cmd.icon}
      shortcut={cmd.shortcut}
      showLabel={label}
      pressed={pressed}
      disabled={!cmd.enabled}
      onClick={() => cmd.run()}
      className="toolbar__btn"
    />
  );
  // Disabled buttons do not raise tooltip events, so the reason goes on a wrapper.
  if (!cmd.enabled && cmd.disabledHint) {
    return (
      <span className="toolbar__hint" title={cmd.disabledHint}>
        {button}
      </span>
    );
  }
  return button;
}

function ZoomControl({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const view = useView(docId);
  const v = () => getViewer(docId);
  const entries: MenuEntry[] = [
    {
      id: 'fw',
      label: t('cmd.fitWidth'),
      checked: view.scaleValue === 'page-width',
      onSelect: () => v()?.setScaleValue('page-width'),
    },
    {
      id: 'fp',
      label: t('cmd.fitPage'),
      checked: view.scaleValue === 'page-fit',
      onSelect: () => v()?.setScaleValue('page-fit'),
    },
    {
      id: 'auto',
      label: t('zoom.auto'),
      checked: view.scaleValue === 'auto',
      onSelect: () => v()?.setScaleValue('auto'),
    },
    { type: 'separator', id: 's' },
    ...ZOOM_STEPS.filter((z) => z >= 0.5 && z <= 4).map<MenuEntry>((z) => ({
      id: String(z),
      label: `${Math.round(z * 100)}%`,
      checked:
        Math.abs(view.scale - z) < 0.001 &&
        !['page-width', 'page-fit', 'auto'].includes(view.scaleValue),
      onSelect: () => v()?.setScaleValue(String(z)),
    })),
  ];
  return (
    <div className="zoom" role="group" aria-label={t('zoom.label')}>
      <IconButton
        size="sm"
        label={t('cmd.zoomOut')}
        shortcut="Mod+-"
        icon={<Minus size={15} />}
        onClick={() => v()?.zoomBy(-1)}
      />
      <DropdownMenu
        entries={entries}
        trigger={
          <button type="button" className="zoom__value" aria-label={t('zoom.choose')}>
            {Math.round(view.scale * 100)}%
            <ChevronDown size={13} />
          </button>
        }
      />
      <IconButton
        size="sm"
        label={t('cmd.zoomIn')}
        shortcut="Mod+="
        icon={<Plus size={15} />}
        onClick={() => v()?.zoomBy(1)}
      />
    </div>
  );
}

const MODE_ICONS: Record<ViewMode, ReactNode> = {
  single: <RectangleVertical size={16} />,
  continuous: <StretchVertical size={16} />,
  twoPage: <Columns2 size={16} />,
  book: <BookOpen size={16} />,
};

function ViewModeMenu({ docId, commands }: { docId: string; commands: Command[] }) {
  const { t } = useTranslation();
  const view = useView(docId);
  const ids: [ViewMode, string][] = [
    ['single', 'view.single'],
    ['continuous', 'view.continuous'],
    ['twoPage', 'view.twoPage'],
    ['book', 'view.book'],
  ];
  return (
    <DropdownMenu
      entries={ids.map(([mode, id]) => {
        const c = findCommand(commands, id)!;
        return { id, label: c.title, checked: view.mode === mode, onSelect: c.run };
      })}
      trigger={
        <button type="button" className="icon-btn toolbar__btn" aria-label={t('viewMode.label')}>
          {MODE_ICONS[view.mode]}
          <span className="icon-btn__label">{t(`viewMode.${view.mode}`)}</span>
          <ChevronDown size={13} />
        </button>
      }
    />
  );
}

function InsertMenu({ commands }: { commands: Command[] }) {
  const { t } = useTranslation();
  const ids = [
    'pages.insertBlank',
    'pages.insertFromFile',
    'pages.insertImages',
    'pages.insertClipboard',
  ];
  const cmds = ids.map((id) => findCommand(commands, id)!);
  return (
    <DropdownMenu
      entries={cmds.map((c) => ({
        id: c.id,
        label: c.title,
        icon: c.icon,
        disabled: !c.enabled,
        onSelect: c.run,
      }))}
      trigger={
        <button type="button" className="icon-btn toolbar__btn" disabled={!cmds[0]?.enabled}>
          <FilePlus size={16} />
          <span className="icon-btn__label">{t('toolbar.insert')}</span>
          <ChevronDown size={13} />
        </button>
      }
    />
  );
}

const VIEW_ITEMS: Item[] = [
  { kind: 'zoom' },
  { kind: 'cmd', id: 'view.rotateCw' },
  { kind: 'viewMode' },
  { kind: 'night' },
  { kind: 'split' },
  { kind: 'sep', id: 's1' },
  { kind: 'cmd', id: 'view.find', label: true },
  { kind: 'cmd', id: 'view.snapshot', label: true },
  { kind: 'cmd', id: 'view.presentation', label: true },
  { kind: 'cmd', id: 'file.print', label: true },
];
const VIEW_OVERFLOW = [
  'view.fitWidth',
  'view.fitPage',
  'view.rotateCcw',
  'view.selectText',
  'view.outline',
  'file.saveAs',
  'file.properties',
  'view.sidebar',
  'view.panel',
];

const PAGES_ITEMS: Item[] = [
  { kind: 'cmd', id: 'pages.rotateLeft', label: true },
  { kind: 'cmd', id: 'pages.rotateRight', label: true },
  { kind: 'cmd', id: 'pages.delete', label: true },
  { kind: 'cmd', id: 'pages.duplicate', label: true },
  { kind: 'cmd', id: 'pages.extract', label: true },
  { kind: 'insert' },
  { kind: 'sep', id: 's1' },
  { kind: 'cmd', id: 'tools.merge', label: true },
  { kind: 'cmd', id: 'tools.split', label: true },
];
/** Trang tab overflow: page tools (C6-C9) and smart split (C10), then the usual items. */
const PAGES_OVERFLOW = [
  'pages.batchCrop',
  'pages.cropImage',
  'pages.replace',
  'pages.cropResize',
  'pages.blank',
  'pages.gridSplit',
  'tools.smartSplit',
  'tools.dewarp',
  'pages.selectAll',
  'file.saveAs',
  'file.print',
  'view.panel',
];

const EXPORT_ITEMS: Item[] = [
  { kind: 'cmd', id: 'tools.documentExport', label: true },
  { kind: 'cmd', id: 'tools.scan', label: true },
  { kind: 'cmd', id: 'tools.compress', label: true },
  { kind: 'cmd', id: 'tools.pdfToImages', label: true },
  { kind: 'cmd', id: 'tools.imagesToPdf', label: true },
  { kind: 'cmd', id: 'tools.color', label: true },
];

/** Chỉnh sửa: eight overlay tools in the bar, Bates in the overflow menu (D1, D2, F1-F12). */
const EDIT_ITEMS: Item[] = [
  { kind: 'cmd', id: 'edit.addText', label: true },
  { kind: 'cmd', id: 'edit.addImage', label: true },
  { kind: 'cmd', id: 'edit.watermark', label: true },
  { kind: 'cmd', id: 'edit.headerFooter', label: true },
  { kind: 'cmd', id: 'edit.pageNumbers', label: true },
  { kind: 'cmd', id: 'edit.qrBarcode', label: true },
  { kind: 'cmd', id: 'edit.objects', label: true },
  { kind: 'cmd', id: 'edit.textEdit', label: true },
];
const EDIT_OVERFLOW = [
  'edit.overlays',
  'edit.letterhead',
  'edit.insertToc',
  'edit.findReplace',
  'edit.links',
  'tools.bates',
  'edit.stamp',
  'edit.seam',
  'edit.initials',
  'edit.erase',
];

/** Ghi chú (G1-G4): markup of the selection, the drawing tools and the list. */
const ANNOTATE_ITEMS: Item[] = [
  { kind: 'cmd', id: 'annot.highlight', label: true },
  { kind: 'cmd', id: 'annot.underline', label: true },
  { kind: 'cmd', id: 'annot.strike', label: true },
  { kind: 'cmd', id: 'annot.squiggly', label: true },
  { kind: 'sep', id: 'a1' },
  { kind: 'cmd', id: 'annot.note', label: true },
  { kind: 'cmd', id: 'annot.freeText', label: true },
  { kind: 'cmd', id: 'annot.ink', label: true },
  { kind: 'cmd', id: 'annot.shape', label: true },
  { kind: 'sep', id: 'a2' },
  { kind: 'cmd', id: 'annot.list', label: true },
];
const ANNOTATE_OVERFLOW: string[] = [];

const SIGN_ITEMS: Item[] = [
  { kind: 'cmd', id: 'sign.certs', label: true },
  { kind: 'cmd', id: 'sign.verify', label: true },
  { kind: 'cmd', id: 'sign.templates', label: true },
  { kind: 'cmd', id: 'sign.library', label: true },
  { kind: 'sep', id: 's1' },
  { kind: 'cmd', id: 'sign.placeField', label: true },
  { kind: 'cmd', id: 'sign.signDoc', label: true },
  { kind: 'cmd', id: 'sign.batchSign', label: true },
  { kind: 'cmd', id: 'sign.security', label: true },
];
const FORMS_ITEMS: Item[] = [{ kind: 'cmd', id: 'forms.open', label: true }];
const WORKFLOW_ITEMS: Item[] = [
  { kind: 'cmd', id: 'tools.workflow', label: true },
  { kind: 'cmd', id: 'tools.watch', label: true },
];
/** Sign & security tab overflow: data cleanup and the pre-send checks. */
const SIGN_OVERFLOW = ['sign.inspect', 'tools.preflight', 'sign.verifyBatch'];

/** Xuất tab overflow: document properties and utilities, and repair of a damaged file (M7-M11). */
const EXPORT_OVERFLOW = [
  'tools.renameBatch',
  'tools.layoutReview',
  'tools.batchExport',
  'tools.docUtils',
  'tools.repair',
];

/** Contextual toolbar of the active function tab (≤ ~8 controls + overflow). */
export function Toolbar() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const view = useView(doc?.id);
  const split = useViewStore((s) => s.split);
  const tab = useUi((s) => s.functionTab);
  const tool = useUi((s) => s.tool);
  const findOpen = useUi((s) => s.findOpen);
  const commands = useCommands();
  const objectActive = useObjectEdit((s) => s.active);
  const eraseActive = useEraseState((s) => s.active);
  const textActive = useTextEdit((s) => s.active);
  const annotTool = useAnnotUi((s) => s.tool);
  const selection = useSelection(doc?.id);
  const thumbWidth = usePageStore((s) => s.thumbWidth);
  const setThumbWidth = usePageStore((s) => s.setThumbWidth);
  void selection; // re-render when the selection changes (page command enablement)
  if (!doc) return null;
  const cmd = (id: string) => findCommand(commands, id);

  const items =
    tab === 'view'
      ? VIEW_ITEMS
      : tab === 'pages'
        ? PAGES_ITEMS
        : tab === 'edit'
          ? EDIT_ITEMS
          : tab === 'export'
            ? EXPORT_ITEMS
            : tab === 'sign'
              ? SIGN_ITEMS
              : tab === 'annotate'
                ? ANNOTATE_ITEMS
                : tab === 'forms'
                  ? FORMS_ITEMS
                  : tab === 'workflow'
                    ? WORKFLOW_ITEMS
                    : [];
  const overflow =
    tab === 'view'
      ? VIEW_OVERFLOW
      : tab === 'pages'
        ? PAGES_OVERFLOW
        : tab === 'edit'
          ? EDIT_OVERFLOW
          : tab === 'sign'
            ? SIGN_OVERFLOW
            : tab === 'export'
              ? EXPORT_OVERFLOW
              : tab === 'annotate'
                ? ANNOTATE_OVERFLOW
                : [];
  const pressed: Record<string, boolean> = {
    'view.snapshot': tool === 'snapshot',
    'view.find': findOpen,
    'edit.objects': objectActive,
    'edit.textEdit': textActive,
    'annot.note': annotTool === 'note',
    'annot.freeText': annotTool === 'freetext',
    'annot.ink': annotTool === 'ink',
    'annot.shape': annotTool === 'shape',
    'edit.erase': eraseActive,
  };

  return (
    <div className="toolbar" role="toolbar" aria-label={t('shell.toolbar')}>
      <div className="toolbar__group">
        <IconButton
          label={cmd('file.save')!.title}
          shortcut="Mod+S"
          icon={<Save size={16} />}
          disabled={!doc.state.dirty && !!doc.state.sourcePath}
          onClick={() => cmd('file.save')?.run()}
        />
        <IconButton
          label={cmd('edit.undo')!.title}
          shortcut="Mod+Z"
          icon={<Undo2 size={16} />}
          disabled={!doc.state.canUndo}
          onClick={() => cmd('edit.undo')?.run()}
        />
        <IconButton
          label={cmd('edit.redo')!.title}
          shortcut="Mod+Y"
          icon={<Redo2 size={16} />}
          disabled={!doc.state.canRedo}
          onClick={() => cmd('edit.redo')?.run()}
        />
      </div>
      <Separator />
      {READY_TABS.has(tab) ? (
        <div className="toolbar__group toolbar__main">
          {items.map((item, i) => {
            switch (item.kind) {
              case 'cmd':
                return (
                  <CmdButton
                    key={item.id}
                    cmd={cmd(item.id)}
                    label={item.label}
                    pressed={pressed[item.id]}
                  />
                );
              case 'zoom':
                return <ZoomControl key="zoom" docId={doc.id} />;
              case 'viewMode':
                return <ViewModeMenu key="mode" docId={doc.id} commands={commands} />;
              case 'night':
                return (
                  <IconButton
                    key="night"
                    label={t('viewer.night')}
                    icon={<Moon size={16} />}
                    pressed={view.night}
                    onClick={() => useViewStore.getState().patch(doc.id, { night: !view.night })}
                    className="toolbar__btn"
                  />
                );
              case 'split':
                return (
                  <IconButton
                    key="split"
                    label={t('viewer.split')}
                    icon={<Columns2 size={16} />}
                    pressed={split}
                    onClick={() => useViewStore.getState().setSplit(!split)}
                    className="toolbar__btn"
                  />
                );
              case 'insert':
                return <InsertMenu key="insert" commands={commands} />;
              case 'sep':
                return <Separator key={item.id + i} />;
            }
          })}
          {overflow.length > 0 && (
            <DropdownMenu
              align="end"
              entries={overflow.map((id) => {
                const c = cmd(id)!;
                return {
                  id,
                  label: c.title,
                  icon: c.icon,
                  shortcut: c.shortcut,
                  disabled: !c.enabled,
                  onSelect: c.run,
                };
              })}
              trigger={
                <IconButton
                  label={t('toolbar.more')}
                  icon={<Ellipsis size={16} />}
                  className="toolbar__btn"
                />
              }
            />
          )}
        </div>
      ) : (
        <div className="toolbar__soon">
          <Sparkles size={15} aria-hidden />
          <span>{t('toolbar.comingSoon', { tab: t(`tabs.${tab}`) })}</span>
        </div>
      )}
      <div className="toolbar__spacer" />
      {tab === 'pages' && (
        <div className="toolbar__size">
          <span className="sr-only">{t('pages.thumbSize')}</span>
          <Slider
            value={thumbWidth}
            min={96}
            max={260}
            step={4}
            onChange={setThumbWidth}
            label={t('pages.thumbSize')}
          />
        </div>
      )}
    </div>
  );
}
