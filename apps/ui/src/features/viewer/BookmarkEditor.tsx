/**
 * Bookmarks editor (D3), shown in the sidebar outline panel in edit mode. The tree is edited in
 * memory (features/viewer/bookmarkTree.ts) and saved as a whole with bookmarks.set, which is a
 * session revision: the normal undo takes it back. Replace-all actions ask first. Signed
 * documents cannot be changed (buttons disabled with a tooltip).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Crosshair,
  IndentDecrease,
  IndentIncrease,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import type { BookmarkNode } from '@chef/contracts';
import type { DocTab } from '../../app/state/documents';
import { confirmDialog } from '../../app/prompts';
import { runDocOp } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, TextInput } from '../../components/Form';
import { toast } from '../../components/Toast';
import { runOp } from '../../lib/rpc';
import { ColorInput } from '../overlay/ColorInput';
import './bookmarkEditor.css';
import { useCurrentPage } from '../overlay/OverlayControls';
import {
  addAfter,
  countNodes,
  findNode,
  flatten,
  fromWire,
  indent,
  moveDown,
  moveUp,
  newNode,
  outdent,
  removeNode,
  rename,
  setPage,
  setStyle,
  toWire,
  type EditNode,
} from './bookmarkTree';

/** Local ids of the editor nodes (never sent to the core). */
let idSeq = 0;
const newId = () => `bm${++idSeq}`;

export function BookmarkEditor({ doc, onDone }: { doc: DocTab; onDone(): void }) {
  const { t } = useTranslation();
  const current = useCurrentPage(doc.id);
  const [nodes, setNodes] = useState<EditNode[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = doc.state.signed;

  /** Reads the saved tree of the document (bookmarks.get). */
  const readTree = useCallback(async (): Promise<EditNode[]> => {
    const r = await runOp(
      'bookmarks.get',
      {},
      { sessionId: doc.id, title: t('outlineEdit.loadJob'), silent: true },
    );
    const saved = (r.data as { bookmarks?: BookmarkNode[] } | null)?.bookmarks ?? [];
    return fromWire(saved, newId);
  }, [doc.id, t]);

  const load = async () => {
    setNodes(await readTree());
    setDirty(false);
    setSelected(null);
  };

  useEffect(() => {
    let alive = true;
    void readTree()
      .then((tree) => {
        if (!alive) return;
        setNodes(tree);
        setDirty(false);
        setSelected(null);
      })
      .catch(() => alive && setNodes([]));
    return () => {
      alive = false;
    };
  }, [readTree]);

  const list = nodes ?? [];
  const sel = selected ? findNode(list, selected) : null;
  const rows = flatten(list);

  /** Edits the in-memory tree. Nothing is written before Save. */
  const edit = (fn: (l: EditNode[]) => EditNode[]) => {
    setNodes((prev) => fn(prev ?? []));
    setDirty(true);
  };

  const add = () => {
    const node = newNode(newId(), t('outlineEdit.newTitle'), current);
    edit((l) => addAfter(l, selected, node));
    setSelected(node.id);
  };

  const remove = () => {
    if (!selected) return;
    edit((l) => removeNode(l, selected));
    setSelected(null);
  };

  const save = async () => {
    if (!nodes) return;
    setBusy(true);
    try {
      const r = await runDocOp(
        doc.id,
        'bookmarks.set',
        { bookmarks: toWire(nodes) },
        t('outlineEdit.saveJob', { name: doc.name }),
      );
      if (r) {
        setDirty(false);
        toast.success(
          t('outlineEdit.saved'),
          t('outlineEdit.savedCount', { count: countNodes(nodes) }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const replaceAllFromPages = async () => {
    const answer = await confirmDialog({
      title: t('outlineEdit.fromPages'),
      message: t('outlineEdit.confirmReplace'),
      tone: 'danger',
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'go', label: t('outlineEdit.replaceGo'), variant: 'danger' },
      ],
    });
    if (answer !== 'go') return;
    setBusy(true);
    try {
      const r = await runDocOp(
        doc.id,
        'bookmarks.fromPages',
        {},
        t('outlineEdit.fromPagesJob', { name: doc.name }),
      );
      if (r) await load();
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    const answer = await confirmDialog({
      title: t('outlineEdit.clear'),
      message: t('outlineEdit.confirmClear'),
      tone: 'danger',
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'go', label: t('outlineEdit.clearGo'), variant: 'danger' },
      ],
    });
    if (answer !== 'go') return;
    setBusy(true);
    try {
      const r = await runDocOp(
        doc.id,
        'bookmarks.clear',
        {},
        t('outlineEdit.clearJob', { name: doc.name }),
      );
      if (r) {
        setNodes([]);
        setSelected(null);
        setDirty(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    if (dirty) {
      const answer = await confirmDialog({
        title: t('outlineEdit.edit'),
        message: t('outlineEdit.confirmDiscard'),
        actions: [
          { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
          { id: 'go', label: t('outlineEdit.discardGo'), variant: 'danger' },
        ],
      });
      if (answer !== 'go') return;
    }
    onDone();
  };

  const locked = blocked || busy;
  const lockedTitle = blocked ? t('outlineEdit.signed') : undefined;

  if (nodes === null) return <p className="outline-edit__empty">{t('outlineEdit.loading')}</p>;

  return (
    <div className="outline-edit" aria-label={t('outlineEdit.edit')}>
      <div className="outline-edit__bar" role="toolbar" aria-label={t('outlineEdit.edit')}>
        <IconButton
          label={t('outlineEdit.add')}
          disabled={locked}
          lockedTitle={lockedTitle}
          onClick={add}
        >
          <Plus size={15} />
        </IconButton>
        <IconButton
          label={t('outlineEdit.remove')}
          disabled={locked || !sel}
          lockedTitle={lockedTitle}
          onClick={remove}
        >
          <Trash2 size={15} />
        </IconButton>
        <IconButton
          label={t('outlineEdit.indent')}
          disabled={locked || !sel}
          lockedTitle={lockedTitle}
          onClick={() => selected && edit((l) => indent(l, selected))}
        >
          <IndentIncrease size={15} />
        </IconButton>
        <IconButton
          label={t('outlineEdit.outdent')}
          disabled={locked || !sel}
          lockedTitle={lockedTitle}
          onClick={() => selected && edit((l) => outdent(l, selected))}
        >
          <IndentDecrease size={15} />
        </IconButton>
        <IconButton
          label={t('outlineEdit.up')}
          disabled={locked || !sel}
          lockedTitle={lockedTitle}
          onClick={() => selected && edit((l) => moveUp(l, selected))}
        >
          <ArrowUp size={15} />
        </IconButton>
        <IconButton
          label={t('outlineEdit.down')}
          disabled={locked || !sel}
          lockedTitle={lockedTitle}
          onClick={() => selected && edit((l) => moveDown(l, selected))}
        >
          <ArrowDown size={15} />
        </IconButton>
      </div>

      {rows.length === 0 ? (
        <p className="outline-edit__empty">{t('outlineEdit.empty')}</p>
      ) : (
        <ul className="outline-edit__tree" role="listbox" aria-label={t('outlineEdit.edit')}>
          {rows.map(({ node, depth }) => (
            <li key={node.id}>
              <button
                type="button"
                role="option"
                aria-selected={node.id === selected}
                className="outline-edit__row"
                data-selected={node.id === selected || undefined}
                style={{
                  paddingLeft: 6 + depth * 14,
                  fontWeight: node.bold ? 700 : 400,
                  fontStyle: node.italic ? 'italic' : 'normal',
                  color: node.color ?? undefined,
                }}
                onClick={() => setSelected(node.id)}
              >
                <span className="outline-edit__title">{node.title || '—'}</span>
                <span className="outline-edit__page">
                  {node.page === null
                    ? t('outlineEdit.noPage')
                    : t('outlineEdit.page', { page: node.page + 1 })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sel ? (
        <div className="outline-edit__props">
          <Field label={t('outlineEdit.titleLabel')} htmlFor="outline-edit-title">
            <TextInput
              id="outline-edit-title"
              value={sel.title}
              disabled={locked}
              onChange={(e) => edit((l) => rename(l, sel.id, e.target.value))}
            />
          </Field>
          <div className="outline-edit__row-buttons">
            <Button
              size="sm"
              disabled={locked}
              onClick={() => edit((l) => setPage(l, sel.id, current))}
            >
              <Crosshair size={14} /> {t('outlineEdit.setPage', { page: current + 1 })}
            </Button>
          </div>
          <div className="outline-edit__style">
            <ColorInput
              id="outline-edit-color"
              label={t('outlineEdit.color')}
              value={sel.color ?? '#000000'}
              onChange={(color) => edit((l) => setStyle(l, sel.id, { color }))}
            />
            <Checkbox
              checked={sel.bold}
              onChange={(bold) => edit((l) => setStyle(l, sel.id, { bold }))}
              label={t('outlineEdit.bold')}
            />
            <Checkbox
              checked={sel.italic}
              onChange={(italic) => edit((l) => setStyle(l, sel.id, { italic }))}
              label={t('outlineEdit.italic')}
            />
          </div>
        </div>
      ) : (
        <p className="outline-edit__hint">{t('outlineEdit.noSelection')}</p>
      )}

      <div className="outline-edit__footer">
        <Button
          size="sm"
          disabled={locked}
          title={lockedTitle}
          onClick={() => void replaceAllFromPages()}
        >
          {t('outlineEdit.fromPages')}
        </Button>
        <Button
          size="sm"
          disabled={locked || rows.length === 0}
          title={lockedTitle}
          onClick={() => void clearAll()}
        >
          {t('outlineEdit.clear')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={locked || !dirty}
          title={lockedTitle}
          icon={<Save size={14} />}
          onClick={() => void save()}
        >
          {t('outlineEdit.save')}
        </Button>
        <Button size="sm" onClick={() => void done()}>
          {t('outlineEdit.done')}
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  lockedTitle,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  lockedTitle?: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="outline-edit__icon"
      aria-label={label}
      title={disabled && lockedTitle ? lockedTitle : label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
