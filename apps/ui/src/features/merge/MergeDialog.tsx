import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Combine,
  FilePlus,
  FolderOpen,
  GripVertical,
  X,
  FileText,
  CircleCheck,
} from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useUi } from '../../app/state/ui';
import { useDocs } from '../../app/state/documents';
import { openFiles, PDF_FILTERS, pickSavePath, probePdf, showError } from '../../app/actions';
import { TaskDialog } from '../../components/TaskDialog';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, TextInput } from '../../components/Form';
import { EmptyState, Spinner } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { cancelJob, runOp } from '../../lib/rpc';
import { formatBytes } from '../../lib/format';
import { parsePageRanges } from '../../lib/pageRange';
import { basename, stripExt } from '../../lib/path';
import { useJobStore, jobProgress } from '../jobs/jobStore';
import './MergeDialog.css';

export interface MergeItem {
  key: string;
  path: string;
  pageCount: number | null;
  fileSize: number;
  password?: string;
  range: string;
}

let keySeq = 0;

function newItem(path: string): MergeItem {
  return { key: `m${++keySeq}`, path, pageCount: null, fileSize: 0, range: '' };
}

function rangeState(item: MergeItem): { pages?: number[]; error?: string; count: number | null } {
  if (!item.range.trim() || item.pageCount === null) return { count: item.pageCount };
  const r = parsePageRanges(item.range, item.pageCount);
  return r.ok
    ? { pages: r.pages, count: r.pages.length }
    : { error: `range.${r.error}`, count: null };
}

function Row({
  item,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  item: MergeItem;
  index: number;
  total: number;
  onChange(patch: Partial<MergeItem>): void;
  onRemove(): void;
  onMove(dir: -1 | 1): void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
  });
  const rs = rangeState(item);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'merge__row is-dragging' : 'merge__row'}
    >
      <button
        type="button"
        className="merge__grip"
        aria-label={t('merge.dragToReorder')}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} />
      </button>
      <span className="merge__index">{index + 1}</span>
      <FileText size={16} className="merge__icon" aria-hidden />
      <div className="merge__name">
        <span title={item.path}>{basename(item.path)}</span>
        <span className="merge__meta">
          {item.pageCount === null ? (
            <Spinner size={12} />
          ) : (
            t('merge.pages', { count: item.pageCount })
          )}{' '}
          · {formatBytes(item.fileSize)}
        </span>
      </div>
      <TextInput
        className="merge__range"
        value={item.range}
        placeholder={t('merge.allPages')}
        aria-label={t('merge.pageRangeFor', { name: basename(item.path) })}
        invalid={!!rs.error}
        title={rs.error ? t(rs.error) : t('range.hint')}
        onChange={(e) => onChange({ range: e.target.value })}
      />
      <div className="merge__row-actions">
        <IconButton
          label={t('common.moveUp')}
          icon={<ArrowUp size={14} />}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <IconButton
          label={t('common.moveDown')}
          icon={<ArrowDown size={14} />}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        />
        <IconButton label={t('common.remove')} icon={<X size={14} />} onClick={onRemove} />
      </div>
    </li>
  );
}

/** C4: merge several files into one (standalone op file.merge). */
export function MergeDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const initial = useUi((s) => s.dialogData) as string[] | undefined;
  const [items, setItems] = useState<MergeItem[]>(() => {
    const docs = useDocs.getState();
    const active = docs.docs.find((d) => d.id === docs.activeId);
    const start = initial?.length
      ? initial
      : active?.state.sourcePath
        ? [active.state.sourcePath]
        : [];
    return start.map(newItem);
  });
  const [bookmarks, setBookmarks] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const job = useJobStore((s) => (running ? s.jobs.find((j) => j.id === running) : undefined));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** Read page count / size (asks for a password when needed). */
  const probe = async (item: MergeItem) => {
    try {
      const info = await probePdf(item.path);
      if (!info) {
        setItems((prev) => prev.filter((i) => i.key !== item.key));
        return;
      }
      setItems((prev) =>
        prev.map((i) =>
          i.key === item.key
            ? { ...i, pageCount: info.pageCount, fileSize: info.fileSize, password: info.password }
            : i,
        ),
      );
    } catch (e) {
      showError(e, t('errors.openFailed', { name: basename(item.path) }));
      setItems((prev) => prev.filter((i) => i.key !== item.key));
    }
  };

  const add = async (paths: string[]) => {
    const fresh = paths.map(newItem);
    setItems((prev) => [...prev, ...fresh]);
    for (const item of fresh) await probe(item);
  };

  useEffect(() => {
    void (async () => {
      for (const item of items) await probe(item);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async () =>
    add(await chef().files.openDialog({ multiple: true, filters: PDF_FILTERS }));

  const states = items.map(rangeState);
  const totalPages = states.every((s) => s.count !== null)
    ? states.reduce((a, s) => a + (s.count ?? 0), 0)
    : null;
  const totalSize = items.reduce((a, i) => a + i.fileSize, 0);
  const loading = items.some((i) => i.pageCount === null);
  const invalid = states.some((s) => s.error);
  const openDocs = useDocs((s) => s.docs);
  const dirtyOpen = openDocs.filter(
    (d) => d.state.dirty && items.some((i) => i.path === d.state.sourcePath),
  );
  const warnings = [
    ...(items.length === 1 ? [t('merge.needTwo')] : []),
    ...dirtyOpen.map((d) => t('merge.unsavedWarning', { name: d.name })),
  ];

  const run = async () => {
    const first = items[0];
    if (!first) return;
    const outputPath = await pickSavePath(
      `${stripExt(basename(first.path))}_${t('merge.suffix')}.pdf`,
      first.path,
    );
    if (!outputPath) return;
    const inputs = items.map((i, idx) => ({
      path: i.path,
      ...(i.password ? { password: i.password } : {}),
      ...(states[idx]?.pages ? { pages: states[idx].pages } : {}),
    }));
    try {
      setRunning('pending');
      const r = await runOp(
        'file.merge',
        { inputs, outputPath, bookmarksFromFilenames: bookmarks },
        { title: t('merge.title'), onStarted: setRunning },
      );
      setResult(r.outputs[0] ?? outputPath);
    } catch (e) {
      showError(e, t('merge.failed'));
    } finally {
      setRunning(null);
    }
  };

  if (result) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && close()}

        icon={<CircleCheck size={18} />}
        title={t('merge.doneTitle')}
        description={t('merge.doneText', { name: basename(result) })}
        footer={
          <>
            <Button
              variant="ghost"
              icon={<FolderOpen size={15} />}
              onClick={() => void chef().files.showInFolder(result)}
            >
              {t('outputs.showInFolder')}
            </Button>
            <DialogSpacer />
            <Button onClick={close}>{t('common.close')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                close();
                void openFiles([result]);
              }}
            >
              {t('merge.openResult')}
            </Button>
          </>
        }
      />
    );
  }

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setItems((prev) =>
      arrayMove(
        prev,
        prev.findIndex((i) => i.key === e.active.id),
        prev.findIndex((i) => i.key === e.over!.id),
      ),
    );
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('merge.title')}
      icon={<Combine size={18} />}
      description={t('merge.description')}
      runLabel={t('merge.run')}
      onRun={() => void run()}
      canRun={items.length >= 2 && !loading && !invalid}
      running={!!running}
      onCancelRun={running && running !== 'pending' ? () => void cancelJob(running) : undefined}
      progress={job ? jobProgress(job) : null}
      warnings={warnings}
      preview={
        <div className="merge__summary">
          <div className="merge__summary-big">{totalPages ?? '…'}</div>
          <div className="muted">{t('merge.totalPages')}</div>
          <ol className="merge__summary-list">
            {items.slice(0, 6).map((i, idx) => (
              <li key={i.key}>
                <span>{basename(i.path)}</span>
                <span className="muted">{states[idx]?.count ?? '…'}</span>
              </li>
            ))}
            {items.length > 6 && (
              <li className="muted">{t('merge.andMore', { count: items.length - 6 })}</li>
            )}
          </ol>
        </div>
      }
      estimate={items.length ? `~${formatBytes(totalSize)}` : '–'}
    >
      <div className="merge__head">
        <span className="field__label">{t('merge.files', { count: items.length })}</span>
        <Button icon={<FilePlus size={14} />} onClick={() => void pick()}>
          {t('merge.addFiles')}
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="merge__empty">
          <EmptyState
            icon={<Combine size={22} />}
            title={t('merge.emptyTitle')}
            text={t('merge.emptyText')}
            actions={
              <Button variant="primary" onClick={() => void pick()}>
                {t('merge.addFiles')}
              </Button>
            }
          />
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
            <ul className="merge__list">
              {items.map((item, idx) => (
                <Row
                  key={item.key}
                  item={item}
                  index={idx}
                  total={items.length}
                  onChange={(patch) =>
                    setItems((prev) =>
                      prev.map((i) => (i.key === item.key ? { ...i, ...patch } : i)),
                    )
                  }
                  onRemove={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                  onMove={(dir) => setItems((prev) => arrayMove(prev, idx, idx + dir))}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <Checkbox
        checked={bookmarks}
        onChange={setBookmarks}
        label={t('merge.bookmarks')}
        hint={t('merge.bookmarksHint')}
      />
    </TaskDialog>
  );
}
