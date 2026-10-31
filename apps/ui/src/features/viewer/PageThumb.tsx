import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocTab } from '../../app/state/documents';
import { useInView, useThumbnail } from './thumbnails';

export interface PageThumbProps {
  doc: DocTab;
  pdf: PDFDocumentProxy | undefined;
  pageIndex: number;
  /** CSS width of the image box. */
  width: number;
  /** Extra visual rotation (view rotation), degrees. */
  viewRotation?: number;
}

/** Lazily rendered page image with a correctly sized placeholder. */
export function PageThumb({ doc, pdf, pageIndex, width, viewRotation = 0 }: PageThumbProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const url = useThumbnail(doc, pdf, pageIndex, width, inView);
  const size = doc.info.pages[pageIndex];
  const ratio = size ? size.height / size.width : 1.414;
  const rotated = viewRotation % 180 !== 0;
  const height = Math.round(width * ratio);
  return (
    <div
      ref={ref}
      className="page-thumb"
      style={{
        width: rotated ? height : width,
        height: rotated ? width : height,
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={
            rotated || viewRotation
              ? { width, height, transform: `rotate(${viewRotation}deg)` }
              : undefined
          }
        />
      ) : (
        <div className="page-thumb__placeholder" />
      )}
    </div>
  );
}
