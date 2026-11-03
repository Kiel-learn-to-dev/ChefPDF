import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDocs, type DocTab } from '../../app/state/documents';
import { useView } from '../../app/state/viewer';
import { usePdfDocument } from './pdfCache';
import { EventBus, PDFLinkService, PDFViewer } from './viewerLib';

/** A second, independent pdf.js viewer; navigation does not affect the main document. */
export function ComparePane({ primary }: { primary: DocTab }) {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const [selectedId, setSelectedId] = useState(primary.id);
  const doc = docs.find((item) => item.id === selectedId) ?? primary;
  const view = useView(doc.id);
  const { pdf } = usePdfDocument(doc);
  const container = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const linkRef = useRef<PDFLinkService | null>(null);
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const eventBus = new EventBus();
    const links = new PDFLinkService({ eventBus });
    const viewer = new PDFViewer({
      container: container.current!,
      viewer: inner.current!,
      eventBus,
      linkService: links,
    });
    links.setViewer(viewer);
    viewerRef.current = viewer;
    linkRef.current = links;
    eventBus.on('pagesinit', () => {
      viewer.currentScaleValue = 'page-width';
      setCount(viewer.pagesCount);
      setPage(viewer.currentPageNumber);
    });
    eventBus.on('pagechanging', (event: { pageNumber: number }) => setPage(event.pageNumber));
    return () => {
      viewer.setDocument(null as unknown as PDFDocumentProxy);
      links.setDocument(null);
      viewerRef.current = null;
      linkRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !pdf) return;
    viewer.setDocument(pdf);
    linkRef.current?.setDocument(pdf, null);
    setPage(1);
  }, [pdf]);

  return (
    <section className="compare-pane" aria-label={t('viewer.split')}>
      <div className="compare-pane__controls">
        <select
          aria-label={t('viewer.compareDocument')}
          value={doc.id}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {docs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <input
          aria-label={t('viewer.comparePage')}
          type="number"
          min={1}
          max={count || 1}
          value={page}
          onChange={(event) => {
            const target = Number(event.target.value);
            if (viewerRef.current && Number.isInteger(target) && target >= 1 && target <= count)
              viewerRef.current.currentPageNumber = target;
          }}
        />
        <span>/ {count}</span>
      </div>
      <div className="viewer compare-pane__viewer" data-night={view.night}>
        <div
          className="viewer__scroll"
          ref={container}
          tabIndex={0}
          role="document"
          aria-label={t('viewer.region', { name: doc.name })}
        >
          <div className="pdfViewer" ref={inner} />
        </div>
      </div>
    </section>
  );
}
