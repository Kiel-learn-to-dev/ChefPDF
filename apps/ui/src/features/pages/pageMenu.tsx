/**
 * Context menu of a page (or of the selected pages) in the page grid (C13, C14). One list of
 * entries shared by every page card, so the grid and any other page list stay in step.
 * Pure: it only builds MenuEntry values; the actions live in pageActions.ts.
 */
import {
  ArrowLeftRight,
  ClipboardPaste,
  Copy,
  Eye,
  FileOutput,
  FilePlus,
  Images,
  ImagePlus,
  ListChecks,
  ListOrdered,
  RotateCcw,
  RotateCw,
  Shrink,
  SquarePlus,
  Stamp,
  Trash2,
} from 'lucide-react';
import { useUi } from '../../app/state/ui';
import type { MenuEntry } from '../../components/Menu';
import { i18n } from '../../i18n';
import {
  compressPagesInNewTab,
  createPdfFromPages,
  deletePages,
  duplicatePages,
  imagesFromPages,
  insertBlank,
  insertClipboardImage,
  invertPageSelection,
  openPageInViewer,
  rotatePages,
  selectAll,
  selectParityPages,
  stampPages,
} from './pageActions';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);

export interface PageMenuInput {
  docId: string;
  /** 0-based page under the pointer. */
  pageIndex: number;
  /** 0-based selected pages (store selection). */
  selected: readonly number[];
  pageCount: number;
  /** A signed file: anything that rewrites it is disabled, reading and new files are not. */
  signed: boolean;
}

/**
 * How many pages the menu acts on: the selection when the pointer page belongs to it, else
 * just that page (the context menu selects the page before it opens).
 */
export function menuTargetCount(input: Pick<PageMenuInput, 'pageIndex' | 'selected'>): number {
  return input.selected.includes(input.pageIndex) ? input.selected.length : 1;
}

/** Entries of the page context menu. Disabled entries stay visible, as in the rest of the app. */
export function pageMenuEntries(input: PageMenuInput): MenuEntry[] {
  const { docId, pageIndex, selected, pageCount, signed } = input;
  const n = menuTargetCount(input);
  const allSelected = selected.length >= pageCount;
  return [
    {
      id: 'createPdf',
      label: t('pageMenu.createPdf', { count: n }),
      icon: <FileOutput size={15} />,
      onSelect: () => void createPdfFromPages(docId),
    },
    {
      id: 'open',
      label: t('pages.openInViewer'),
      icon: <Eye size={15} />,
      shortcut: 'Enter',
      onSelect: () => openPageInViewer(docId, pageIndex),
    },
    { type: 'separator', id: 's0' },
    {
      id: 'selAll',
      label: t('pageMenu.selectAll'),
      icon: <ListChecks size={15} />,
      shortcut: 'Mod+A',
      disabled: allSelected,
      onSelect: () => selectAll(docId),
    },
    {
      id: 'selInvert',
      label: t('pageMenu.invertSelection'),
      icon: <ArrowLeftRight size={15} />,
      disabled: allSelected,
      onSelect: () => invertPageSelection(docId),
    },
    {
      id: 'selOdd',
      label: t('pageMenu.selectOdd'),
      icon: <ListOrdered size={15} />,
      onSelect: () => selectParityPages(docId, 'odd'),
    },
    {
      id: 'selEven',
      label: t('pageMenu.selectEven'),
      icon: <ListOrdered size={15} />,
      onSelect: () => selectParityPages(docId, 'even'),
    },
    { type: 'separator', id: 's1' },
    {
      id: 'rl',
      disabled: signed,
      label: t('pages.rotateLeft'),
      icon: <RotateCcw size={15} />,
      onSelect: () => void rotatePages(docId, 270),
    },
    {
      id: 'rr',
      disabled: signed,
      label: t('pages.rotateRight'),
      icon: <RotateCw size={15} />,
      onSelect: () => void rotatePages(docId, 90),
    },
    {
      id: 'dup',
      disabled: signed,
      label: t('pages.duplicate'),
      icon: <Copy size={15} />,
      shortcut: 'Mod+D',
      onSelect: () => void duplicatePages(docId),
    },
    { type: 'separator', id: 's2' },
    {
      id: 'stamp',
      disabled: signed,
      label: t('pageMenu.stamp'),
      icon: <Stamp size={15} />,
      onSelect: () => stampPages(docId),
    },
    {
      id: 'compress',
      label: t('pageMenu.compress'),
      icon: <Shrink size={15} />,
      onSelect: () => void compressPagesInNewTab(docId),
    },
    {
      id: 'toImages',
      label: t('pageMenu.toImages'),
      icon: <Images size={15} />,
      onSelect: () => imagesFromPages(docId),
    },
    { type: 'separator', id: 's3' },
    {
      id: 'blankBefore',
      disabled: signed,
      label: t('pages.insertBlankBefore'),
      icon: <SquarePlus size={15} />,
      onSelect: () => void insertBlank(docId, Math.min(...(n > 1 ? selected : [pageIndex])), 1),
    },
    {
      id: 'blankAfter',
      disabled: signed,
      label: t('pages.insertBlankAfter'),
      icon: <SquarePlus size={15} />,
      onSelect: () => void insertBlank(docId, Math.max(...(n > 1 ? selected : [pageIndex])) + 1, 1),
    },
    {
      id: 'file',
      disabled: signed,
      label: t('pages.insertFromFile'),
      icon: <FilePlus size={15} />,
      onSelect: () => useUi.getState().openDialog('insertFromFile'),
    },
    {
      id: 'img',
      disabled: signed,
      label: t('pages.insertImages'),
      icon: <ImagePlus size={15} />,
      onSelect: () => useUi.getState().openDialog('insertImages'),
    },
    {
      id: 'paste',
      disabled: signed,
      label: t('pages.insertClipboard'),
      icon: <ClipboardPaste size={15} />,
      onSelect: () => void insertClipboardImage(docId),
    },
    { type: 'separator', id: 's4' },
    {
      id: 'del',
      label: n > 1 ? t('pages.deleteN', { count: n }) : t('pages.delete'),
      icon: <Trash2 size={15} />,
      shortcut: 'Delete',
      danger: true,
      disabled: n >= pageCount || signed,
      onSelect: () => void deletePages(docId),
    },
  ];
}
