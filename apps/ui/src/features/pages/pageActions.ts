/**
 * Page organizer actions (C2, C3). Each one is an op on the core; the
 * selection is remapped afterwards so it follows the affected pages.
 */
import {
  announceOutputs,
  IMAGE_FILTERS,
  openFiles,
  pickSavePath,
  runDocOp,
} from '../../app/actions';
import { getDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { toast } from '../../components/Toast';
import { i18n } from '../../i18n';
import { chef } from '../../lib/bridge';
import type { RotateAngle } from '../../lib/ops';
import { formatPageRanges } from '../../lib/pageRange';
import { basename, stripExt } from '../../lib/path';
import { getSelection, usePageStore } from './pageStore';
import {
  clampSelection,
  emptySelection,
  selectAll as selectAllPages,
  type Selection,
} from './selection';
import { isIdentity, moveToGap, remapAfterReorder } from './reorder';
import { getViewer } from '../viewer/controllers';
import { useViewStore } from '../../app/state/viewer';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);

function setSel(docId: string, sel: Selection) {
  usePageStore.getState().setSelection(docId, sel);
}

function select(docId: string, pages: number[]) {
  const sorted = [...pages].sort((a, b) => a - b);
  setSel(docId, {
    selected: sorted,
    anchor: sorted[0] ?? null,
    focus: sorted[sorted.length - 1] ?? null,
  });
}

/** Pages an action applies to: the selection, else the current page. */
export function targetPages(docId: string): number[] {
  const sel = getSelection(docId).selected;
  if (sel.length) return sel;
  const page = useViewStore.getState().views[docId]?.page ?? 1;
  return [page - 1];
}

/** Insert position after the selection (or after the current page). */
export function insertionPoint(
  docId: string,
  where: 'before' | 'after' | 'start' | 'end' = 'after',
): number {
  const doc = getDoc(docId);
  const count = doc?.info.pageCount ?? 0;
  if (where === 'start') return 0;
  if (where === 'end') return count;
  const pages = targetPages(docId);
  return where === 'before' ? Math.min(...pages) : Math.min(count, Math.max(...pages) + 1);
}

/** Signed documents only allow non-rewriting ops (extract/split/merge); see BLOCKED_BY_SIGNATURE. */
export function isSigned(docId: string): boolean {
  return !!getDoc(docId)?.state.signed;
}

function blockedBySignature(docId: string): boolean {
  if (!isSigned(docId)) return false;
  toast.warning(t('signed.blockedTitle'), t('errors.BLOCKED_BY_SIGNATURE'), [
    { label: t('signed.makeCopy'), onClick: () => void editableCopy(docId) },
  ]);
  return true;
}

/** Extract every page into a new (unsigned) file and open it, to edit a copy of a signed document. */
export async function editableCopy(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const outputPath = await pickSavePath(
    `${stripExt(doc.name)}_${t('signed.copySuffix')}.pdf`,
    doc.state.sourcePath,
  );
  if (!outputPath) return;
  const pages = Array.from({ length: doc.info.pageCount }, (_, i) => i);
  const r = await runDocOp(docId, 'page.extract', { pages, outputPath }, t('signed.makeCopy'));
  if (r) await openFiles([r.outputs[0] ?? outputPath]);
}

export function pagesLabel(pages: number[]): string {
  return pages.length === 1
    ? t('pages.pageN', { page: pages[0]! + 1 })
    : t('pages.pagesN', { count: pages.length, ranges: formatPageRanges(pages) });
}

export async function rotatePages(docId: string, angle: RotateAngle, pages = targetPages(docId)) {
  if (blockedBySignature(docId)) return;
  await runDocOp(docId, 'page.rotate', { pages, angle }, t('ops.rotate'));
}

export async function deletePages(docId: string, pages = targetPages(docId)) {
  if (blockedBySignature(docId)) return;
  const doc = getDoc(docId);
  if (!doc) return;
  if (pages.length >= doc.info.pageCount) {
    toast.warning(t('ops.delete'), t('pages.cannotDeleteAll'));
    return;
  }
  const r = await runDocOp(docId, 'page.delete', { pages }, t('ops.delete'));
  if (r) {
    const first = Math.min(...pages);
    const count = getDoc(docId)?.info.pageCount ?? 0;
    select(docId, count ? [Math.min(first, count - 1)] : []);
  }
}

export async function duplicatePages(docId: string, pages = targetPages(docId)) {
  if (blockedBySignature(docId)) return;
  const r = await runDocOp(docId, 'page.duplicate', { pages }, t('ops.duplicate'));
  if (r) {
    // Each copy lands right after its source: copy of sorted[i] is at sorted[i] + i + 1.
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    select(
      docId,
      sorted.map((p, i) => p + i + 1),
    );
  }
}

export async function extractPages(docId: string, pages = targetPages(docId)) {
  const doc = getDoc(docId);
  if (!doc) return;
  const name = `${stripExt(doc.name)}_${t('pages.extractSuffix')}_${formatPageRanges(pages).replaceAll(',', '_')}.pdf`;
  const outputPath = await pickSavePath(name, doc.state.sourcePath);
  if (!outputPath) return;
  const r = await runDocOp(docId, 'page.extract', { pages, outputPath }, t('ops.extract'));
  if (r) announceOutputs(t('pages.extracted'), r.outputs.length ? r.outputs : [outputPath]);
}

export async function reorderPages(docId: string, order: number[]) {
  if (blockedBySignature(docId)) return;
  if (isIdentity(order)) return;
  const before = getSelection(docId).selected;
  const r = await runDocOp(docId, 'page.reorder', { order }, t('ops.reorder'));
  if (r) select(docId, remapAfterReorder(order, before));
}

/** Move the selection one step left/right (keyboard reorder). */
export async function nudgeSelection(docId: string, dir: -1 | 1) {
  const doc = getDoc(docId);
  const pages = getSelection(docId).selected;
  if (!doc || pages.length === 0) return;
  const count = doc.info.pageCount;
  const gap = dir < 0 ? Math.min(...pages) - 1 : Math.max(...pages) + 2;
  if (gap < 0 || gap > count) return;
  await reorderPages(docId, moveToGap(count, pages, gap));
}

export async function insertBlank(
  docId: string,
  at: number,
  count: number,
  size?: { width: number; height: number },
) {
  if (blockedBySignature(docId)) return;
  const r = await runDocOp(
    docId,
    'page.insertBlank',
    { at, count, ...(size ?? {}) },
    t('ops.insertBlank'),
  );
  if (r)
    select(
      docId,
      Array.from({ length: count }, (_, i) => at + i),
    );
}

export async function insertFromFile(
  docId: string,
  at: number,
  path: string,
  pages?: number[],
  password?: string,
) {
  if (blockedBySignature(docId)) return null;
  const before = getDoc(docId)?.info.pageCount ?? 0;
  const r = await runDocOp(
    docId,
    'page.insertFromFile',
    { at, path, ...(pages ? { pages } : {}), ...(password ? { password } : {}) },
    t('ops.insertFromFile', { name: basename(path) }),
  );
  if (r) {
    const added = (getDoc(docId)?.info.pageCount ?? before) - before;
    select(
      docId,
      Array.from({ length: Math.max(0, added) }, (_, i) => at + i),
    );
  }
  return r;
}

export async function insertImages(
  docId: string,
  at: number,
  images: ({ path: string } | { dataUrl: string })[],
  pageSize: 'image' | 'a4' | 'letter',
  margin: number,
) {
  if (blockedBySignature(docId)) return null;
  const r = await runDocOp(
    docId,
    'page.insertImages',
    { at, images, pageSize, margin },
    t('ops.insertImages'),
  );
  if (r)
    select(
      docId,
      Array.from({ length: images.length }, (_, i) => at + i),
    );
  return r;
}

export async function pickImages(): Promise<string[]> {
  return chef().files.openDialog({ multiple: true, filters: IMAGE_FILTERS });
}

export async function insertClipboardImage(docId: string, at = insertionPoint(docId)) {
  if (blockedBySignature(docId)) return;
  const dataUrl = await chef().clipboard.readImagePng();
  if (!dataUrl) {
    toast.info(t('pages.clipboardEmpty'));
    return;
  }
  await insertImages(docId, at, [{ dataUrl }], 'image', 0);
}

export function selectAll(docId: string) {
  const count = getDoc(docId)?.info.pageCount ?? 0;
  setSel(docId, selectAllPages(count));
}

export function clearSelection(docId: string) {
  setSel(docId, emptySelection);
}

/** Keep selections valid when the page count changes. */
export function clampDocSelection(docId: string) {
  const count = getDoc(docId)?.info.pageCount ?? 0;
  setSel(docId, clampSelection(getSelection(docId), count));
}

export function openPageInViewer(docId: string, pageIndex: number) {
  useViewStore.getState().patch(docId, { page: pageIndex + 1, location: undefined });
  useUi.getState().set({ functionTab: 'view' });
  setTimeout(() => getViewer(docId)?.goToPage(pageIndex + 1), 50);
}
