/**
 * Draws the highlight boxes (highlight.ts) on the pages of the viewer. A pure overlay: it never
 * takes the mouse, and it is hidden while the view is rotated (the boxes would not line up).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { DocTab } from '../../app/state/documents';
import { useViewStore } from '../../app/state/viewer';
import { useHighlight, type HighlightItem } from './highlight';
import './redact.css';

const NO_ITEMS: HighlightItem[] = [];

interface PageBox {
  index: number;
  left: number;
  top: number;
  scale: number;
}

function measure(container: HTMLElement, layer: DOMRect, doc: DocTab): PageBox[] {
  const out: PageBox[] = [];
  for (const el of container.querySelectorAll<HTMLElement>('.pdfViewer .page[data-page-number]')) {
    const index = Number(el.dataset.pageNumber) - 1;
    const page = doc.info.pages[index];
    if (!page) continue;
    const canvas = el.querySelector<HTMLCanvasElement>('canvas');
    const r = (canvas ?? el).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      index,
      left: r.left - layer.left,
      top: r.top - layer.top,
      scale: r.width / page.width,
    });
  }
  return out;
}

export function HighlightLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  // A selector must return a stable value: a fresh [] per call would loop the store subscription.
  const items = useHighlight((s) => (s.docId === doc.id ? s.items : NO_ITEMS));
  const rotated = useViewStore((s) => (s.views[doc.id]?.rotation ?? 0) !== 0);
  const [pages, setPages] = useState<PageBox[]>([]);
  const key = useRef('');

  // Page boxes follow the viewer: measured after each render (guarded) and on scroll / resize.
  const remeasure = () => {
    const container = getContainer();
    const layer = layerRef.current;
    if (!container || !layer) return;
    const next = measure(container, layer.getBoundingClientRect(), doc);
    const k = JSON.stringify(next);
    if (k !== key.current) {
      key.current = k;
      setPages(next);
    }
  };

  useLayoutEffect(() => {
    if (items.length > 0) remeasure();
  });

  useLayoutEffect(() => {
    if (items.length === 0) return;
    const container = getContainer();
    if (!container) return;
    container.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);
    const ro = new ResizeObserver(remeasure);
    ro.observe(container);
    return () => {
      container.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, doc.id]);

  const visible = (item: HighlightItem) => pages.find((p) => p.index === item.pageIndex);

  return (
    <div ref={layerRef} className="hl-layer" data-testid="highlight-layer" aria-hidden>
      {!rotated &&
        items.map((item, i) => {
          const p = visible(item);
          if (!p) return null;
          const [x1, y1, x2, y2] = item.rect as [number, number, number, number];
          return (
            <div
              key={`${item.pageIndex}-${i}`}
              className="hl-box"
              data-testid="highlight-box"
              style={{
                left: p.left + x1 * p.scale,
                top: p.top + y1 * p.scale,
                width: (x2 - x1) * p.scale,
                height: (y2 - y1) * p.scale,
              }}
            />
          );
        })}
    </div>
  );
}
