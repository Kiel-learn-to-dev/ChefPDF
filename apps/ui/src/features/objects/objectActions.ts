/**
 * Operations of the object edit mode (D4-D7). The UI calls these; they run the content.* ops on
 * the document session (new revision, undo via the session) and keep the selection in step.
 *
 * After an edit the object ids change (they carry the revision digest). The selection is therefore
 * found again: the affected pages are listed once more and each selected object is matched by
 * remapSelection (moved by the displacement of the edit), or dropped when it was deleted.
 */
import type { OpResult } from '@chef/contracts';
import { chef } from '../../lib/bridge';
import { objectErrorCode } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import type { OpParams } from '../../lib/ops';
import { toast } from '../../components/Toast';
import { errorMessage, IMAGE_FILTERS, runDocOp } from '../../app/actions';
import { getDoc } from '../../app/state/documents';
import { i18n } from '../../i18n';
import {
  adjustImageParams,
  colorParams,
  deleteParams,
  duplicateParams,
  isMeaningfulMove,
  moveParams,
  opacityParams,
  pagesOfIds,
  remapSelection,
  reorderParams,
  replaceImageParams,
  extractImageParams,
  type ImageAdjust,
  type ImageFit,
  type ListObjectsData,
  type PageObject,
  type ViewByTypeData,
} from './objectModel';
import { selectedObjects, useObjectEdit } from './objectState';
const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

/** Text of a failed object operation: its own message when the core named one. */
export function objectErrorText(e: unknown): string {
  const code = objectErrorCode(e);
  if (code && i18n.exists(`objects.err.${code}`)) return t(`objects.err.${code}`);
  return errorMessage(e);
}

/** Key of the revision cache for a document (see objectState.ts). */
export function revisionKey(docId: string): string {
  const doc = getDoc(docId);
  return `${docId}:${doc?.version ?? 0}`;
}

/** Lists the objects of one page (read only, no revision). */
export async function listPageObjects(docId: string, pageIndex: number): Promise<PageObject[]> {
  const result = await runOp(
    'content.listObjects',
    { pageIndex, includeForms: false },
    { sessionId: docId, title: t('objects.listing'), silent: true },
  );
  return (result.data as ListObjectsData).objects;
}

/** Summaries by kind of one page (read only, E2). */
export async function listPageTypes(docId: string, pageIndex: number): Promise<ViewByTypeData> {
  const result = await runOp(
    'content.viewByType',
    { pageIndex },
    { sessionId: docId, title: t('objects.listing'), silent: true },
  );
  return result.data as ViewByTypeData;
}

/** Loads the pages into the cache of the current revision. */
export async function loadPages(docId: string, pages: number[]): Promise<void> {
  const key = revisionKey(docId);
  const store = useObjectEdit.getState();
  store.resetFor(key);
  for (const index of pages) {
    const objects = await listPageObjects(docId, index);
    useObjectEdit.getState().setPage(key, index, objects);
  }
}

/** Common flow: snapshot of the selection, the op, then the selection found again. */
type EditOp =
  | 'content.move'
  | 'content.delete'
  | 'content.duplicate'
  | 'content.reorder'
  | 'content.setColor'
  | 'content.setOpacity';

async function editSelection<K extends EditOp>(
  docId: string,
  opId: K,
  params: OpParams[K],
  title: string,
  delta: { dx: number; dy: number } | null,
): Promise<OpResult | null> {
  const store = useObjectEdit.getState();
  const before = selectedObjects(store.objects, store.selected);
  const result = await runDocOp(docId, opId, params, title, {
    onError: (e) => {
      if (objectErrorCode(e) === null) return false;
      toast.error(title, objectErrorText(e));
      return true;
    },
  });
  if (!result) return null;
  if (delta === null) {
    useObjectEdit.getState().setSelected([]);
  } else {
    const pages = pagesOfIds(before.map((o) => o.id));
    await loadPages(docId, pages);
    const after = Object.values(useObjectEdit.getState().objects).flat();
    useObjectEdit.getState().setSelected(remapSelection(before, after, delta));
  }
  return result;
}

const selectedIds = (): string[] => useObjectEdit.getState().selected;

export async function moveSelection(docId: string, dx: number, dy: number): Promise<boolean> {
  if (!isMeaningfulMove(dx, dy) || selectedIds().length === 0) return false;
  const r = await editSelection(
    docId,
    'content.move',
    moveParams(selectedIds(), dx, dy),
    t('objects.op.move'),
    { dx, dy },
  );
  return r !== null;
}

export async function deleteSelection(docId: string): Promise<boolean> {
  if (selectedIds().length === 0) return false;
  const r = await editSelection(
    docId,
    'content.delete',
    deleteParams(selectedIds()),
    t('objects.op.delete'),
    null,
  );
  return r !== null;
}

export async function duplicateSelection(docId: string): Promise<boolean> {
  if (selectedIds().length === 0) return false;
  const params = duplicateParams(selectedIds());
  const r = await editSelection(docId, 'content.duplicate', params, t('objects.op.duplicate'), {
    dx: params.dx ?? 0,
    dy: params.dy ?? 0,
  });
  return r !== null;
}

export async function reorderSelection(
  docId: string,
  mode: 'front' | 'back' | 'forward' | 'backward',
): Promise<boolean> {
  if (selectedIds().length === 0) return false;
  const r = await editSelection(
    docId,
    'content.reorder',
    reorderParams(selectedIds(), mode),
    t('objects.op.reorder'),
    { dx: 0, dy: 0 },
  );
  return r !== null;
}

export async function colourSelection(
  docId: string,
  colours: { fill?: string; stroke?: string },
): Promise<boolean> {
  const params = colorParams(selectedIds(), colours);
  if (!params) return false;
  const r = await editSelection(docId, 'content.setColor', params, t('objects.op.colour'), {
    dx: 0,
    dy: 0,
  });
  return r !== null;
}

export async function opacitySelection(docId: string, value: number): Promise<boolean> {
  if (selectedIds().length === 0) return false;
  const r = await editSelection(
    docId,
    'content.setOpacity',
    opacityParams(selectedIds(), value),
    t('objects.op.opacity'),
    { dx: 0, dy: 0 },
  );
  return r !== null;
}

/** The single selected image, with its page; null when the selection is not one image. */
export function selectedImage(): PageObject | null {
  const store = useObjectEdit.getState();
  const objs = selectedObjects(store.objects, store.selected);
  return objs.length === 1 && objs[0]!.kind === 'image' ? objs[0]! : null;
}

/** Runs an image op: the object keeps its id only through a revision, so the selection is cleared. */
async function imageOp<K extends 'content.replaceImage' | 'content.adjustImage'>(
  docId: string,
  opId: K,
  params: OpParams[K],
  title: string,
): Promise<boolean> {
  const img = selectedImage();
  if (!img) return false;
  const result = await runDocOp(docId, opId, params, title, {
    onError: (e) => {
      if (objectErrorCode(e) === null) return false;
      toast.error(title, objectErrorText(e));
      return true;
    },
  });
  if (!result) return false;
  await loadPages(docId, [img.pageIndex]);
  const after = useObjectEdit.getState().objects[img.pageIndex] ?? [];
  const found = remapSelection([img], after, { dx: 0, dy: 0 });
  useObjectEdit.getState().setSelected(found);
  return true;
}

/** Thay ảnh (D6): picks a PNG/JPEG file and puts it in the place of the selected image. */
export async function replaceSelectedImage(docId: string, fit: ImageFit): Promise<boolean> {
  const img = selectedImage();
  if (!img) return false;
  const [path] = await chef().files.openDialog({ multiple: false, filters: IMAGE_FILTERS });
  if (!path) return false;
  return imageOp(
    docId,
    'content.replaceImage',
    replaceImageParams(img.pageIndex, img.id, path, fit),
    t('objects.op.replaceImage'),
  );
}

/** Chỉnh ảnh (D7): brightness, contrast, rotate, flip, crop, ... of the selected image. */
export async function adjustSelectedImage(docId: string, adjust: ImageAdjust): Promise<boolean> {
  const img = selectedImage();
  if (!img) return false;
  return imageOp(
    docId,
    'content.adjustImage',
    adjustImageParams(img.pageIndex, img.id, adjust),
    t('objects.op.adjustImage'),
  );
}

/** Lưu ảnh ra… : writes the original image of the selected placement to a file. */
export async function extractSelectedImage(docId: string): Promise<boolean> {
  const img = selectedImage();
  if (!img) return false;
  const out = await chef().files.saveDialog({
    defaultPath: `${img.imageName ?? 'image'}.png`,
    filters: IMAGE_FILTERS,
  });
  if (!out) return false;
  const result = await runDocOp(
    docId,
    'content.extractImage',
    extractImageParams(img.pageIndex, img.id, out),
    t('objects.op.extractImage'),
    {
      onError: (e) => {
        if (objectErrorCode(e) === null) return false;
        toast.error(t('objects.op.extractImage'), objectErrorText(e));
        return true;
      },
    },
  );
  if (result) toast.success(t('objects.op.extractImage'), out);
  return result !== null;
}
