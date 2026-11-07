import { useEffect, useMemo, useRef, useState } from 'react';
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
/** Space around each thumbnail in its row (padding, page number, gap), in px. */
const ROW_EXTRA = 64;
const LIST_PAD = 24;
/** Rows kept rendered above and below the visible part of the list, in px. */
const OVERSCAN = 600;

interface Layout {
  /** Top of each row, plus the bottom of the last row. */
  tops: number[];
  heights: number[];
  total: number;
}

/**
 * Row geometry from the page sizes. The list is windowed, so every row's position and height is
 * known before it renders; the rows are absolutely positioned inside the list.
 */
function layoutRows(
  pages: ReadonlyArray<{ width: number; height: number } | undefined>,
  count: number,
  rotated: boolean,
): Layout {
  const tops: number[] = [];
  const heights: number[] = [];
  let y = LIST_PAD;
  for (let i = 0; i < count; i += 1) {
    const size = pages[i];
    const ratio = size ? size.height / size.width : 1.414;
    const thumb = rotated ? THUMB_W : Math.round(THUMB_W * ratio);
    tops.push(y);
    heights.push(thumb + ROW_EXTRA);
    y += thumb + ROW_EXTRA;
  }
  tops.push(y);
  return { tops, heights, total: y + LIST_PAD };
}

/** Index of the row that contains `y` (the first row whose bottom lies below it). */
function rowAt(tops: number[], count: number, y: number): number {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid + 1]! > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Scrolls `scroller` just enough to show row `page` (1-based). */
function revealRowIn(scroller: HTMLElement | null | undefined, layout: Layout, page: number): void {
  const i = page - 1;
  if (!scroller || i < 0 || i >= layout.heights.length) return;
  const top = layout.tops[i]!;
  const bottom = top + layout.heights[i]!;
  if (top < scroller.scrollTop) scroller.scrollTop = top - LIST_PAD;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = bottom - scroller.clientHeight + LIST_PAD;
  }
}

/**
 * Thumbnail list of the sidebar. Shares the selection of the page grid (same store, per document):
 * click selects one page and jumps to it, Ctrl/Cmd+click toggles, Shift+click selects a range.
 * Right click opens the page menu for the selection.
 *
 * Only the rows near the visible part of the sidebar are rendered. A 1000-page file used to put
 * about 100 DOM nodes per page into the sidebar; the rest is now built when it scrolls into view.
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
  const focusPage = useRef<number | null>(null);
  const count = doc.info.pageCount;
  const rotated = view.rotation % 180 !== 0;
  const layout = useMemo(
    () => layoutRows(doc.info.pages, count, rotated),
    [doc.info.pages, count, rotated],
  );
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // The scroll container is the sidebar's content box, the parent of the list.
  useEffect(() => {
    const scroller = listRef.current?.parentElement;
    if (!scroller) return;
    const update = () => setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  const revealRow = (page: number) => revealRowIn(listRef.current?.parentElement, layout, page);

  useEffect(() => {
    revealRow(view.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal only when the page changes
  }, [view.page, layout]);

  // Keyboard focus moves to a row once it has rendered (it may have been outside the window).
  useEffect(() => {
    const page = focusPage.current;
    if (page === null) return;
    const button = listRef.current?.querySelector<HTMLElement>(`[data-page="${page}"] button`);
    if (button) {
      button.focus();
      focusPage.current = null;
    }
  });

  useEffect(() => {
    setSelection(doc.id, clampSelection(getSelection(doc.id), count));
  }, [count, doc.id, setSelection]);

  const go = (page: number) => getViewer(doc.id)?.goToPage(page);

  const first = count ? rowAt(layout.tops, count, viewport.top - OVERSCAN) : 0;
  const last = count
    ? Math.min(count - 1, rowAt(layout.tops, count, viewport.top + viewport.height + OVERSCAN))
    : -1;
  const rows = Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => {
    const i = first + k;
    const selected = sel.selected.includes(i);
    return (
      <li
        key={i}
        data-page={i + 1}
        style={{
          position: 'absolute',
          top: layout.tops[i],
          left: 0,
          right: 0,
          height: layout.heights[i],
          display: 'flex',
          justifyContent: 'center',
        }}
      >
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
                const next = Math.max(1, Math.min(count, i + 1 + (e.key === 'ArrowDown' ? 1 : -1)));
                go(next);
                focusPage.current = next;
                revealRow(next);
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
  });

  return (
    <ol
      ref={listRef}
      className="thumbs"
      aria-label={t('sidebar.thumbnails')}
      style={{ position: 'relative', height: layout.total, padding: 0 }}
    >
      {rows}
    </ol>
  );
}
