/**
 * Text markup from the browser selection (G1): the client rects of the selection become rects in
 * displayed points of their pages, then annots.addTextMarkup marks them. The selected text is kept
 * as the annotation contents, so the list can quote it.
 */
import { getDoc } from '../../app/state/documents';
import { toast } from '../../components/Toast';
import { i18n } from '../../i18n';
import { getViewer } from '../viewer/controllers';
import { measurePages } from '../objects/pageMeasure';
import { addMarkup } from './annotActions';
import { selectionRectsByPage, type ClientRect, type MarkupKind } from './annotModel';

/** Marks the selected text of the viewer with one kind of markup. */
export async function markupFromSelection(docId: string, kind: MarkupKind): Promise<boolean> {
  const sel = window.getSelection();
  const doc = getDoc(docId);
  const container = getViewer(docId)?.container();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !doc || !container) {
    toast.info(i18n.t('annots.title'), i18n.t('annots.selectFirst'));
    return false;
  }
  const text = sel.toString().trim();
  const origin = container.getBoundingClientRect();
  const pages = measurePages(container, origin, doc);
  const rects: ClientRect[] = Array.from(sel.getRangeAt(0).getClientRects()).map((r) => ({
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
  }));
  const perPage = selectionRectsByPage(rects, pages, { left: origin.left, top: origin.top });
  if (perPage.length === 0) {
    toast.info(i18n.t('annots.title'), i18n.t('annots.selectFirst'));
    return false;
  }
  return addMarkup(docId, perPage, kind, text);
}
