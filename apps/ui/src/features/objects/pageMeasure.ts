/**
 * Page boxes of the viewer for the layers over it (object edit, erase): where each rendered page
 * sits inside the layer, its px per point and whether it is in view. Shared by the layers so they
 * all measure the same way.
 */
import type { DocTab } from '../../app/state/documents';
import type { PageBox } from './objectModel';

export interface MeasuredPage extends PageBox {
  visible: boolean;
}

export function measurePages(container: HTMLElement, layer: DOMRect, doc: DocTab): MeasuredPage[] {
  const out: MeasuredPage[] = [];
  const view = container.getBoundingClientRect();
  for (const el of container.querySelectorAll<HTMLElement>('.pdfViewer .page[data-page-number]')) {
    const index = Number(el.dataset.pageNumber) - 1;
    const page = doc.info.pages[index];
    if (!page) continue;
    const canvas = el.querySelector<HTMLCanvasElement>('canvas');
    const r = (canvas ?? el).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const visible =
      r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right;
    out.push({
      index,
      left: r.left - layer.left,
      top: r.top - layer.top,
      width: r.width,
      height: r.height,
      scale: r.width / page.width,
      dispW: page.width,
      dispH: page.height,
      visible,
    });
  }
  return out;
}

/** The page under a point of the layer (px), if any. */
export function pageAt<P extends PageBox>(pages: P[], x: number, y: number): P | undefined {
  return pages.find(
    (p) => x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height,
  );
}

/** Layer px -> points of the page (top-left origin). */
export function pagePt(page: PageBox, pt: { x: number; y: number }): { x: number; y: number } {
  return { x: (pt.x - page.left) / page.scale, y: (pt.y - page.top) / page.scale };
}
