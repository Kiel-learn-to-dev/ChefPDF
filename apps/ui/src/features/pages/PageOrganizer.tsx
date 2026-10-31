import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ClipboardPaste,
  Copy,
  Eye,
  FileOutput,
  FilePlus,
  ImagePlus,
  RotateCcw,
  RotateCw,
  SquarePlus,
  Trash2,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { ContextMenu, type MenuEntry } from '../../components/Menu';
import { IconButton } from '../../components/Button';
import { ProgressBar } from '../../components/Misc';
import { isEditableTarget } from '../../lib/shortcuts';
import { usePdfDocument } from '../viewer/pdfCache';
import { PageThumb } from '../viewer/PageThumb';
import { getSelection, usePageStore, useSelection } from './pageStore';
import { clampSelection, clickSelect, moveFocus, pressSelect } from './selection';
import { dragOrder, identityOrder } from './reorder';
import {
  clearSelection,
  deletePages,
  duplicatePages,
  extractPages,
  insertBlank,
  insertClipboardImage,
  nudgeSelection,
  openPageInViewer,
  reorderPages,
  rotatePages,
  selectAll,
} from './pageActions';
import './PageOrganizer.css';

const id = (i: number) => `p${i}`;
const indexOf = (s: string | number) => Number(String(s).slice(1));

interface CardProps {
  doc: DocTab;
  pdf: PDFDocumentProxy | undefined;
  pageIndex: number;
  displayIndex: number;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  width: number;
  menu: MenuEntry[];
  onPress(e: React.PointerEvent | React.MouseEvent): void;
  onOpen(): void;
}

function PageCard({
  doc,
  pdf,
  pageIndex,
  displayIndex,
  selected,
  focused,
  dimmed,
  width,
  menu,
  onPress,
  onOpen,
}: CardProps) {
  const { t } = useTranslation();
  const locked = doc.state.signed;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: id(pageIndex),
    disabled: locked,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const rotation = doc.info.pages[pageIndex]?.rotation ?? 0;
  return (
    <ContextMenu entries={menu}>
      <div
        {...attributes}
        {...listeners}
        ref={setNodeRef}
        style={style}
        className={clsx(
          'page-card',
          selected && 'is-selected',
          focused && 'is-focused',
          (isDragging || dimmed) && 'is-dragging',
        )}
        role="option"
        aria-roledescription={undefined}
        aria-selected={selected}
        aria-label={t('pages.pageN', { page: displayIndex + 1 })}
        tabIndex={focused ? 0 : -1}
        data-index={pageIndex}
        onPointerDown={(e) => {
          if (e.button === 0) onPress(e);
          listeners?.onPointerDown?.(e);
        }}
        onContextMenu={(e) => {
          if (!selected) onPress(e);
        }}
        onDoubleClick={onOpen}
      >
        <div className="page-card__frame">
          <PageThumb doc={doc} pdf={pdf} pageIndex={pageIndex} width={width} />
          {!locked && (
            <div className="page-card__quick" onPointerDown={(e) => e.stopPropagation()}>
              <IconButton
                size="sm"
                label={t('pages.rotateLeft')}
                icon={<RotateCcw size={14} />}
                onClick={() => void rotatePages(doc.id, 270, [pageIndex])}
              />
              <IconButton
                size="sm"
                label={t('pages.rotateRight')}
                icon={<RotateCw size={14} />}
                onClick={() => void rotatePages(doc.id, 90, [pageIndex])}
              />
              <IconButton
                size="sm"
                label={t('pages.delete')}
                icon={<Trash2 size={14} />}
                onClick={() => void deletePages(doc.id, [pageIndex])}
              />
            </div>
          )}
        </div>
        <div className="page-card__label">
          <span>{displayIndex + 1}</span>
          {rotation !== 0 && <span className="page-card__rot">{rotation}°</span>}
        </div>
      </div>
    </ContextMenu>
  );
}

/** Thumbnail grid of the "Trang" tab (C1–C3). */
export function PageOrganizer({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const { pdf: loaded, stale } = usePdfDocument(doc);
  // Don't render thumbnails of the previous revision under the new version.
  const pdf = stale ? undefined : loaded;
  const sel = useSelection(doc.id);
  const setSelection = usePageStore((s) => s.setSelection);
  const width = usePageStore((s) => s.thumbWidth);
  const gridRef = useRef<HTMLDivElement>(null);
  const count = doc.info.pageCount;
  const [activeId, setActiveId] = useState<string | null>(null);
  // Optimistic order while page.reorder runs; reset when a new revision arrives.
  const [pending, setPending] = useState<{ version: number; order: number[] } | null>(null);
  const order = pending && pending.version === doc.version ? pending.order : identityOrder(count);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    setSelection(doc.id, clampSelection(getSelection(doc.id), count));
  }, [count, doc.id, setSelection]);

  const setSel = (s: typeof sel) => setSelection(doc.id, s);

  const focusIndex = (i: number) => {
    requestAnimationFrame(() =>
      gridRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus(),
    );
  };

  const columns = () => {
    const grid = gridRef.current;
    const first = grid?.querySelector<HTMLElement>('.page-card');
    if (!grid || !first) return 1;
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap) || 0;
    return Math.max(
      1,
      Math.floor(
        (grid.clientWidth -
          parseFloat(styles.paddingLeft) -
          parseFloat(styles.paddingRight) +
          gap) /
          (first.offsetWidth + gap),
      ),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key];
    if (step !== undefined && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      void nudgeSelection(doc.id, step > 0 ? 1 : -1);
      return;
    }
    if (step !== undefined) {
      e.preventDefault();
      const next = moveFocus(sel, step, count, e.shiftKey);
      setSel(mod ? { ...sel, focus: next.focus } : next);
      focusIndex(next.focus ?? 0);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const target = e.key === 'Home' ? 0 : count - 1;
      setSel(clickSelect(sel, target, { shift: e.shiftKey }));
      focusIndex(target);
    } else if (e.key === ' ' && sel.focus !== null) {
      e.preventDefault();
      setSel(clickSelect(sel, sel.focus, { toggle: true }));
    } else if (e.key === 'Enter' && sel.focus !== null) {
      e.preventDefault();
      openPageInViewer(doc.id, sel.focus);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.selected.length) {
      e.preventDefault();
      void deletePages(doc.id);
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll(doc.id);
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      void duplicatePages(doc.id);
    } else if (e.key === 'Escape') {
      clearSelection(doc.id);
    }
  };

  const onDragStart = (e: DragStartEvent) => {
    const i = indexOf(e.active.id);
    setActiveId(String(e.active.id));
    if (!sel.selected.includes(i)) setSel(clickSelect(sel, i));
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeIndex = indexOf(active.id);
    const current = getSelection(doc.id).selected;
    const moving = current.includes(activeIndex) ? current : [activeIndex];
    // Indices here are positions in the displayed order (== original while nothing is pending).
    const posOf = (pageIdx: number) => order.indexOf(pageIdx);
    const newDisplay = dragOrder(
      count,
      moving.map(posOf),
      posOf(activeIndex),
      posOf(indexOf(over.id)),
    );
    const newOrder = newDisplay.map((pos) => order[pos]!);
    setPending({ version: doc.version, order: newOrder });
    void reorderPages(doc.id, newOrder).finally(() => setPending(null));
  };

  const menuFor = (pageIndex: number): MenuEntry[] => {
    const n = sel.selected.includes(pageIndex) ? sel.selected.length : 1;
    return [
      {
        id: 'open',
        label: t('pages.openInViewer'),
        icon: <Eye size={15} />,
        shortcut: 'Enter',
        onSelect: () => openPageInViewer(doc.id, pageIndex),
      },
      { type: 'separator', id: 's0' },
      {
        id: 'rl',
        disabled: doc.state.signed,
        label: t('pages.rotateLeft'),
        icon: <RotateCcw size={15} />,
        onSelect: () => void rotatePages(doc.id, 270),
      },
      {
        id: 'rr',
        disabled: doc.state.signed,
        label: t('pages.rotateRight'),
        icon: <RotateCw size={15} />,
        onSelect: () => void rotatePages(doc.id, 90),
      },
      {
        id: 'dup',
        disabled: doc.state.signed,
        label: t('pages.duplicate'),
        icon: <Copy size={15} />,
        shortcut: 'Mod+D',
        onSelect: () => void duplicatePages(doc.id),
      },
      {
        id: 'ext',
        label: t('pages.extract'),
        icon: <FileOutput size={15} />,
        onSelect: () => void extractPages(doc.id),
      },
      { type: 'separator', id: 's1' },
      {
        id: 'blankBefore',
        disabled: doc.state.signed,
        label: t('pages.insertBlankBefore'),
        icon: <SquarePlus size={15} />,
        onSelect: () =>
          void insertBlank(
            doc.id,
            Math.min(...(sel.selected.length ? sel.selected : [pageIndex])),
            1,
          ),
      },
      {
        id: 'blankAfter',
        disabled: doc.state.signed,
        label: t('pages.insertBlankAfter'),
        icon: <SquarePlus size={15} />,
        onSelect: () =>
          void insertBlank(
            doc.id,
            Math.max(...(sel.selected.length ? sel.selected : [pageIndex])) + 1,
            1,
          ),
      },
      {
        id: 'file',
        disabled: doc.state.signed,
        label: t('pages.insertFromFile'),
        icon: <FilePlus size={15} />,
        onSelect: () => useUi.getState().openDialog('insertFromFile'),
      },
      {
        id: 'img',
        disabled: doc.state.signed,
        label: t('pages.insertImages'),
        icon: <ImagePlus size={15} />,
        onSelect: () => useUi.getState().openDialog('insertImages'),
      },
      {
        id: 'paste',
        disabled: doc.state.signed,
        label: t('pages.insertClipboard'),
        icon: <ClipboardPaste size={15} />,
        onSelect: () => void insertClipboardImage(doc.id),
      },
      { type: 'separator', id: 's2' },
      {
        id: 'del',
        label: n > 1 ? t('pages.deleteN', { count: n }) : t('pages.delete'),
        icon: <Trash2 size={15} />,
        shortcut: 'Delete',
        danger: true,
        disabled: n >= count || doc.state.signed,
        onSelect: () => void deletePages(doc.id),
      },
    ];
  };

  const items = useMemo(() => order.map(id), [order]);
  const activeIndex = activeId ? indexOf(activeId) : null;
  const dragCount =
    activeIndex !== null && sel.selected.includes(activeIndex) ? sel.selected.length : 1;

  return (
    <div className="organizer">
      {doc.busy > 0 && (
        <div className="viewer__busy">
          <ProgressBar value={null} label={t('jobs.running')} />
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={items} strategy={rectSortingStrategy}>
          <div
            ref={gridRef}
            className="organizer__grid"
            role="listbox"
            aria-multiselectable
            aria-label={t('pages.gridLabel')}
            tabIndex={sel.focus === null ? 0 : -1}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              if (e.target === gridRef.current && count > 0) {
                setSel(sel.focus === null ? clickSelect(sel, 0) : sel);
                focusIndex(sel.focus ?? 0);
              }
            }}
            onPointerDown={(e) => e.target === e.currentTarget && clearSelection(doc.id)}
            style={{ ['--thumb-w' as string]: `${width}px` }}
          >
            {order.map((pageIndex, displayIndex) => (
              <PageCard
                key={id(pageIndex)}
                doc={doc}
                pdf={pdf}
                pageIndex={pageIndex}
                displayIndex={displayIndex}
                width={width}
                selected={sel.selected.includes(pageIndex)}
                focused={sel.focus === pageIndex}
                dimmed={
                  activeIndex !== null &&
                  activeIndex !== pageIndex &&
                  sel.selected.includes(pageIndex)
                }
                menu={menuFor(pageIndex)}
                onPress={(e) => {
                  const mods = { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey };
                  setSel(
                    e.type === 'pointerdown'
                      ? pressSelect(sel, pageIndex, mods)
                      : clickSelect(sel, pageIndex, mods),
                  );
                }}
                onOpen={() => openPageInViewer(doc.id, pageIndex)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeIndex !== null && (
            <div className="page-card page-card--overlay is-selected">
              <div className="page-card__frame">
                <PageThumb doc={doc} pdf={pdf} pageIndex={activeIndex} width={width} />
                {dragCount > 1 && <span className="page-card__count">{dragCount}</span>}
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
