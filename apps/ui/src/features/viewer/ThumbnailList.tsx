import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { DocTab } from '../../app/state/documents';
import { useView } from '../../app/state/viewer';
import { ContextMenu } from '../../components/Menu';
import { pageMenuEntries } from '../pages/pageMenu';
import { getSelection, usePageStore, useSelection } from '../pages/pageStore';
import { clampSelection, clickSelect, contextSelect, mouseModifiers } from '../pages/selection';
import { usePdfDocument } from './pdfCache';
import { getViewer } from './controllers';
import { PageThumb } from './PageThumb';

const THUMB_W = 120;

/**
 * Thumbnail list of the sidebar. Shares the selection of the page grid (same store, per document):
 * click selects one page and jumps to it, Ctrl/Cmd+click toggles, Shift+click selects a range.
 * Right click opens the page menu for the selection.
 */
export function ThumbnailList({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const { pdf: loaded, stale } = usePdfDocument(doc);
  // Don't render thumbnails of the previous revision under the new version.
  const pdf = stale ? undefined : loaded;
  const view = useView(doc.id);
  const sel = useSelection(doc.id);
  const setSelection = usePageStore((s) => s.setSelection);
  const listRef = useRef<HTMLOListElement>(null);
  const count = doc.info.pageCount;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${view.page}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [view.page]);

  useEffect(() => {
    setSelection(doc.id, clampSelection(getSelection(doc.id), count));
  }, [count, doc.id, setSelection]);

  const go = (page: number) => getViewer(doc.id)?.goToPage(page);

  return (
    <ol ref={listRef} className="thumbs" aria-label={t('sidebar.thumbnails')}>
      {Array.from({ length: count }, (_, i) => {
        const selected = sel.selected.includes(i);
        return (
          <li key={i} data-page={i + 1}>
            <ContextMenu
              entries={pageMenuEntries({
                docId: doc.id,
                pageIndex: i,
                selected: sel.selected,
                pageCount: count,
                signed: doc.state.signed,
              })}
            >
              <button
                type="button"
                className={clsx(
                  'thumbs__item',
                  view.page === i + 1 && 'is-current',
                  selected && 'is-selected',
                )}
                aria-current={view.page === i + 1 ? 'page' : undefined}
                aria-pressed={selected}
                aria-label={t('sidebar.goToPage', { page: i + 1 })}
                onClick={(e) => {
                  setSelection(doc.id, clickSelect(getSelection(doc.id), i, mouseModifiers(e)));
                  go(i + 1);
                }}
                onContextMenu={() => {
                  setSelection(doc.id, contextSelect(getSelection(doc.id), i));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const next = Math.max(
                      1,
                      Math.min(count, i + 1 + (e.key === 'ArrowDown' ? 1 : -1)),
                    );
                    go(next);
                    listRef.current
                      ?.querySelector<HTMLElement>(`[data-page="${next}"] button`)
                      ?.focus();
                  }
                }}
              >
                <PageThumb
                  doc={doc}
                  pdf={pdf}
                  pageIndex={i}
                  width={THUMB_W}
                  viewRotation={view.rotation}
                />
                <span className="thumbs__num">{i + 1}</span>
              </button>
            </ContextMenu>
          </li>
        );
      })}
    </ol>
  );
}
