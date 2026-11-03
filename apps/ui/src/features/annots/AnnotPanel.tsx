/**
 * Sidebar tab "Ghi chú" (G4, T7.07): the annotations of the document grouped by page, with filters
 * (kind, author, status, text), a click to jump, edit of the text, replies, review status, delete,
 * and the export and flatten actions. Replies are shown under their parent.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { Button } from '../../components/Button';
import { Select, TextInput } from '../../components/Form';
import { EmptyState } from '../../components/Misc';
import { showError } from '../../app/actions';
import { getViewer } from '../viewer/controllers';
import {
  EXPORT_FORMATS,
  SUBTYPE_KEYS,
  buildThread,
  filterAnnots,
  groupAnnotsByPage,
  kindsOf,
  quotedText,
  type AnnotFilter,
  type AnnotItem,
  type ExportFormat,
} from './annotModel';
import {
  exportAnnots,
  flattenAnnots,
  refreshAnnots,
  removeAnnot,
  replyTo,
  setStatus,
  updateText,
} from './annotActions';
import { useAnnotUi } from './annotState';
import { PALETTE } from './annotModel';

const OPACITIES = [1, 0.75, 0.5, 0.25];
type Status = AnnotFilter['status'];
const STATUSES: Status[] = ['all', 'none', 'accepted', 'rejected', 'cancelled', 'completed'];

export function AnnotPanel({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const items = useAnnotUi((s) => s.items);
  const filter = useAnnotUi((s) => s.filter);
  const selectedId = useAnnotUi((s) => s.selectedId);
  const color = useAnnotUi((s) => s.color);
  const opacity = useAnnotUi((s) => s.opacity);
  const [format, setFormat] = useState<ExportFormat>('txt');
  const blocked = doc.state.signed;

  useEffect(() => {
    refreshAnnots(doc.id).catch((e: unknown) => showError(e));
  }, [doc.id, doc.version]);

  const shown = filterAnnots(items, filter);
  const groups = groupAnnotsByPage(shown);
  const kinds = kindsOf(items);
  const set = (patch: Partial<AnnotFilter>) =>
    useAnnotUi.getState().set({ filter: { ...filter, ...patch } });

  const jump = (it: AnnotItem) => {
    useAnnotUi.getState().set({ selectedId: it.id });
    getViewer(doc.id)?.goToPage(it.pageIndex + 1);
  };

  return (
    <div className="an-panel">
      <div className="an-filters" role="group" aria-label={t('annots.palette.label')}>
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className="annot-swatch"
            style={{ background: c }}
            aria-label={t('annots.palette.colour', { colour: c })}
            aria-pressed={color === c}
            onClick={() => useAnnotUi.getState().set({ color: c })}
          />
        ))}
        <Select<string>
          aria-label={t('annots.palette.opacity')}
          value={String(opacity)}
          onChange={(v) => useAnnotUi.getState().set({ opacity: Number(v) })}
          options={OPACITIES.map((o) => ({ value: String(o), label: `${Math.round(o * 100)}%` }))}
          size="sm"
        />
      </div>
      <div className="an-filters">
        <Select<string>
          aria-label={t('annots.filter.kind')}
          value={filter.kinds[0] ?? ''}
          onChange={(v) => set({ kinds: v ? [v] : [] })}
          options={[
            { value: '', label: t('annots.filter.allKinds') },
            ...kinds.map((k) => ({ value: k, label: t(SUBTYPE_KEYS[k] ?? 'annots.kind.other') })),
          ]}
          size="sm"
        />
        <Select<Status>
          aria-label={t('annots.filter.status')}
          value={filter.status}
          onChange={(v) => set({ status: v })}
          options={STATUSES.map((s) => ({ value: s, label: t(`annots.status.${s}`) }))}
          size="sm"
        />
        <TextInput
          aria-label={t('annots.filter.author')}
          placeholder={t('annots.filter.author')}
          value={filter.author}
          onChange={(e) => set({ author: e.target.value })}
        />
        <TextInput
          aria-label={t('annots.filter.search')}
          placeholder={t('annots.filter.search')}
          value={filter.query}
          onChange={(e) => set({ query: e.target.value })}
        />
      </div>
      {items.length === 0 ? (
        <EmptyState title={t('annots.empty.title')} text={t('annots.empty.text')} />
      ) : shown.length === 0 ? (
        <EmptyState title={t('annots.noMatch')} text="" />
      ) : (
        <div className="an-list">
          {groups.map((g) => (
            <div key={g.pageIndex}>
              <div className="an-page__title">{t('annots.page', { page: g.pageIndex + 1 })}</div>
              {g.items.map((it) => (
                <AnnotRow
                  key={it.id}
                  item={it}
                  all={items}
                  selected={it.id === selectedId}
                  blocked={blocked}
                  docId={doc.id}
                  onJump={() => jump(it)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="an-footer">
        <Select<ExportFormat>
          aria-label={t('annots.export.format')}
          value={format}
          onChange={setFormat}
          options={EXPORT_FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
          size="sm"
        />
        <Button
          variant="secondary"
          disabled={items.length === 0}
          onClick={() =>
            void exportAnnots(
              doc.id,
              format,
              undefined,
              filter.kinds.length ? filter.kinds : undefined,
            )
          }
        >
          {t('annots.export.action')}
        </Button>
        <Button
          variant="secondary"
          disabled={items.length === 0 || blocked}
          title={blocked ? t('overlay.signedBlocked') : undefined}
          onClick={() =>
            void flattenAnnots(doc.id, undefined, filter.kinds.length ? filter.kinds : undefined, {
              links: true,
              formFields: true,
            })
          }
        >
          {t('annots.flatten.action')}
        </Button>
      </div>
    </div>
  );
}

function AnnotRow({
  item,
  all,
  selected,
  blocked,
  docId,
  onJump,
}: {
  item: AnnotItem;
  all: AnnotItem[];
  selected: boolean;
  blocked: boolean;
  docId: string;
  onJump(): void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'none' | 'edit' | 'reply'>('none');
  const [text, setText] = useState('');
  const thread = buildThread(all, item.id);
  const quote = quotedText(item);
  const done = async (p: Promise<boolean>) => {
    if (await p) setMode('none');
  };
  return (
    <div
      className={`an-item${selected ? ' an-item--selected' : ''}`}
      style={{ ['--an-c' as string]: item.colour ?? '#facc15' }}
      data-testid="annot-item"
      data-subtype={item.subtype}
    >
      <div className="an-item__head">
        <button type="button" className="an-item__kind" onClick={onJump}>
          {t(SUBTYPE_KEYS[item.subtype] ?? 'annots.kind.other')}
        </button>
        <span>{item.author || t('annots.noAuthor')}</span>
        {item.status && <span>{t(`annots.status.${item.status}`)}</span>}
      </div>
      {quote && <div className="an-item__quote">{quote}</div>}
      {mode === 'edit' ? (
        <TextInput
          aria-label={t('annots.edit.label')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        item.contents && !quote && <div>{item.contents}</div>
      )}
      {thread?.replies.map((r) => (
        <div key={r.id} className="an-item__reply">
          {r.author ? `${r.author}: ` : ''}
          {r.contents}
        </div>
      ))}
      {mode === 'reply' && (
        <TextInput
          aria-label={t('annots.reply.label')}
          placeholder={t('annots.reply.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div className="an-item__actions">
        {mode === 'none' ? (
          <>
            <Button
              variant="ghost"
              disabled={blocked}
              onClick={() => {
                setText(item.contents);
                setMode('edit');
              }}
            >
              {t('annots.edit.action')}
            </Button>
            <Button
              variant="ghost"
              disabled={blocked}
              onClick={() => {
                setText('');
                setMode('reply');
              }}
            >
              {t('annots.reply.action')}
            </Button>
            <Select<string>
              aria-label={t('annots.status.label')}
              value={item.status ?? 'none'}
              onChange={(v) => {
                if (!blocked) void setStatus(docId, item.id, v as Exclude<Status, 'all'>);
              }}
              options={STATUSES.filter((s) => s !== 'all').map((s) => ({
                value: s,
                label: t(`annots.status.${s}`),
              }))}
              size="sm"
            />
            <Button
              variant="ghost"
              disabled={blocked}
              onClick={() => void removeAnnot(docId, item.id)}
            >
              {t('annots.delete')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={text.trim() === ''}
              onClick={() =>
                void done(
                  mode === 'edit'
                    ? updateText(docId, item.id, text.trim())
                    : replyTo(docId, item.id, text.trim()),
                )
              }
            >
              {t('annots.save')}
            </Button>
            <Button variant="ghost" onClick={() => setMode('none')}>
              {t('common.cancel')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
