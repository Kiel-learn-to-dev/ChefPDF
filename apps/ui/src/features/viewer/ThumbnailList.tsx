import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { DocTab } from '../../app/state/documents';
import { useView } from '../../app/state/viewer';
import { usePdfDocument } from './pdfCache';
import { getViewer } from './controllers';
import { PageThumb } from './PageThumb';

const THUMB_W = 120;

export function ThumbnailList({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const { pdf: loaded, stale } = usePdfDocument(doc);
  // Don't render thumbnails of the previous revision under the new version.
  const pdf = stale ? undefined : loaded;
  const view = useView(doc.id);
  const listRef = useRef<HTMLOListElement>(null);
  const count = doc.info.pageCount;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${view.page}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [view.page]);

  const go = (page: number) => getViewer(doc.id)?.goToPage(page);

  return (
    <ol ref={listRef} className="thumbs" aria-label={t('sidebar.thumbnails')}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} data-page={i + 1}>
          <button
            type="button"
            className={clsx('thumbs__item', view.page === i + 1 && 'is-current')}
            aria-current={view.page === i + 1 ? 'page' : undefined}
            aria-label={t('sidebar.goToPage', { page: i + 1 })}
            onClick={() => go(i + 1)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = Math.max(1, Math.min(count, i + 1 + (e.key === 'ArrowDown' ? 1 : -1)));
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
        </li>
      ))}
    </ol>
  );
}
