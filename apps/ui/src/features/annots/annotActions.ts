/**
 * Operations of the annotations (G1-G5). Each change is a new revision on the session (undo
 * through the session); the list is read again afterwards, because annotation ids carry the
 * revision digest. Export writes a file and leaves the document unchanged.
 */
import type { OpResult } from '@chef/contracts';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { runDocOp, showError, errorMessage } from '../../app/actions';
import { confirmDialog } from '../../app/prompts';
import { toast } from '../../components/Toast';
import { useSettings } from '../../app/state/settings';
import { i18n } from '../../i18n';
import {
  flattenParams,
  exportParams,
  noteParams,
  freeTextParams,
  inkParams,
  shapeParams,
  textMarkupParams,
  type AnnotItem,
  type ExportFormat,
  type MarkupKind,
  type NoteIcon,
  type ShapeKind,
} from './annotModel';
import { useAnnotUi } from './annotState';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

/** The author of new annotations: the name in the settings (may be empty). */
export function annotAuthor(): string {
  return useSettings.getState().settings.userName ?? '';
}

/** Reads the annotations of the document (read only). */
export async function loadAnnots(docId: string): Promise<AnnotItem[]> {
  const result = await runOp(
    'annots.list',
    {},
    {
      sessionId: docId,
      title: t('annots.title'),
      silent: true,
    },
  );
  return (result.data as { annots?: AnnotItem[] } | undefined)?.annots ?? [];
}

export async function refreshAnnots(docId: string): Promise<void> {
  useAnnotUi.getState().setItems(await loadAnnots(docId));
}

/** One document change of the annotations: the list is read again when it went through. */
async function change(
  docId: string,
  opId: Parameters<typeof runDocOp>[1],
  params: Parameters<typeof runDocOp>[2],
  title: string,
): Promise<OpResult | null> {
  const result = await runDocOp(docId, opId, params, title, {
    toastWarnings: true,
    onError: (e) => {
      toast.error(title, errorMessage(e));
      return true;
    },
  });
  if (result) await refreshAnnots(docId).catch((e: unknown) => showError(e));
  return result;
}

/** Highlight, underline, strike or squiggly under the rects of each page of a selection. */
export async function addMarkup(
  docId: string,
  pages: { pageIndex: number; rects: number[][] }[],
  kind: MarkupKind,
  contents: string,
): Promise<boolean> {
  const { color, opacity } = useAnnotUi.getState();
  const title = t(`annots.op.${kind}`);
  let done = false;
  for (const p of pages) {
    const r = await change(
      docId,
      'annots.addTextMarkup',
      textMarkupParams(p.pageIndex, kind, p.rects, {
        color,
        opacity,
        contents,
        author: annotAuthor(),
      }),
      title,
    );
    if (!r) return done;
    done = true;
  }
  return done;
}

export async function addNote(
  docId: string,
  pageIndex: number,
  at: { x: number; y: number },
  text: string,
  icon: NoteIcon,
): Promise<boolean> {
  const { color } = useAnnotUi.getState();
  const r = await change(
    docId,
    'annots.addNote',
    noteParams(pageIndex, at, text, { author: annotAuthor(), icon, color }),
    t('annots.op.note'),
  );
  return r !== null;
}

export async function addFreeText(
  docId: string,
  pageIndex: number,
  rect: number[],
  text: string,
): Promise<boolean> {
  const { color } = useAnnotUi.getState();
  const r = await change(
    docId,
    'annots.addFreeText',
    freeTextParams(pageIndex, rect, text, { author: annotAuthor(), color, fontSize: 12 }),
    t('annots.op.freeText'),
  );
  return r !== null;
}

export async function addInk(
  docId: string,
  pageIndex: number,
  strokes: { x: number; y: number }[][],
): Promise<boolean> {
  const { color } = useAnnotUi.getState();
  const params = inkParams(pageIndex, strokes, { author: annotAuthor(), color, width: 2 });
  if (!params) return false;
  const r = await change(docId, 'annots.addInk', params, t('annots.op.ink'));
  return r !== null;
}

export async function addShape(
  docId: string,
  pageIndex: number,
  kind: ShapeKind,
  a: { x: number; y: number },
  b: { x: number; y: number },
): Promise<boolean> {
  const { color } = useAnnotUi.getState();
  const r = await change(
    docId,
    'annots.addShape',
    shapeParams(pageIndex, kind, a, b, { author: annotAuthor(), color, width: 1.5 }),
    t(`annots.op.${kind}`),
  );
  return r !== null;
}

export async function updateText(docId: string, id: string, contents: string): Promise<boolean> {
  return (await change(docId, 'annots.update', { id, contents }, t('annots.op.update'))) !== null;
}

export async function removeAnnot(docId: string, id: string): Promise<boolean> {
  return (await change(docId, 'annots.remove', { ids: [id] }, t('annots.op.remove'))) !== null;
}

export async function replyTo(docId: string, id: string, text: string): Promise<boolean> {
  const r = await change(
    docId,
    'annots.reply',
    { id, text, author: annotAuthor() },
    t('annots.op.reply'),
  );
  return r !== null;
}

export async function setStatus(
  docId: string,
  id: string,
  status: 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'none',
): Promise<boolean> {
  return (await change(docId, 'annots.setStatus', { id, status }, t('annots.op.status'))) !== null;
}

/** Xuất ghi chú…: a save dialog, then annots.export (the document is not changed). */
export async function exportAnnots(
  docId: string,
  format: ExportFormat,
  pages: number[] | undefined,
  kinds: string[] | undefined,
): Promise<boolean> {
  const out = await chef().files.saveDialog({ defaultPath: `ghi-chu.${format}` });
  if (!out) return false;
  try {
    await runOp('annots.export', exportParams(out, format, pages, kinds), {
      sessionId: docId,
      title: t('annots.op.export'),
    });
    toast.success(t('annots.op.export'), out);
    return true;
  } catch (e) {
    showError(e, t('annots.op.export'));
    return false;
  }
}

/** Làm phẳng ghi chú…: burns the annotations into the page, after a confirmation. */
export async function flattenAnnots(
  docId: string,
  pages: number[] | undefined,
  kinds: string[] | undefined,
  keep: { links: boolean; formFields: boolean },
): Promise<boolean> {
  const answer = await confirmDialog({
    title: t('annots.flatten.title'),
    message: t('annots.flatten.body'),
    tone: 'danger',
    actions: [
      { id: 'cancel', label: t('common.cancel'), variant: 'secondary' },
      { id: 'apply', label: t('annots.flatten.confirm'), variant: 'danger' },
    ],
  });
  if (answer !== 'apply') return false;
  return (
    (await change(
      docId,
      'annots.flatten',
      flattenParams(pages, kinds, keep),
      t('annots.op.flatten'),
    )) !== null
  );
}
