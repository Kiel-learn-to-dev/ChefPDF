/**
 * Operations of the text edit mode (D8, T7.02). They run text.* ops on the document session: a
 * line edit is a new revision (undo through the session), after which the lines are read again.
 */
import type { OpResult } from '@chef/contracts';
import { textErrorCode, type TextErrorCode } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import { toast } from '../../components/Toast';
import { errorMessage, runDocOp, showError } from '../../app/actions';
import { getDoc } from '../../app/state/documents';
import { i18n } from '../../i18n';
import {
  checkTextParams,
  editLineParams,
  needsRefetch,
  type CheckResult,
  type Editor,
  type TextLine,
} from './textEditModel';
import { useTextEdit, type ReplacementFont } from './textEditState';
import {
  KEEP_STYLE,
  editParagraphParams,
  overlapHighlights,
  pageOfParagraph,
  paragraphCentre,
  paragraphWarnings,
  reselectParagraph,
  styleParagraphParams,
  type ParagraphInfo,
  type ParagraphResultData,
  type ParagraphStyle,
  type TextBlock,
} from './textParagraphModel';
import { useHighlight } from '../redact/highlight';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

/** Text of a failed text operation: the Vietnamese text of its code when there is one. */
export function textErrorText(e: unknown): string {
  const code: TextErrorCode | null = textErrorCode(e);
  if (code && i18n.exists(`textEdit.err.${code}`)) return t(`textEdit.err.${code}`);
  return errorMessage(e);
}

/** Key of the line cache of a document (see textEditState.ts). */
export function textRevisionKey(docId: string): string {
  return `${docId}:${getDoc(docId)?.version ?? 0}`;
}

/** Lines, blocks and paragraph info of one page (read only). */
export async function listPageText(
  docId: string,
  pageIndex: number,
): Promise<{ lines: TextLine[]; blocks: TextBlock[]; paragraphs: ParagraphInfo[] }> {
  const result = await runOp(
    'text.getLines',
    { pageIndex },
    { sessionId: docId, title: t('textEdit.listing'), silent: true },
  );
  const data = result.data as
    { lines?: TextLine[]; blocks?: TextBlock[]; paragraphs?: ParagraphInfo[] } | undefined;
  return {
    lines: data?.lines ?? [],
    blocks: data?.blocks ?? [],
    paragraphs: data?.paragraphs ?? [],
  };
}

/** Lines of one page (read only). */
export async function listPageLines(docId: string, pageIndex: number): Promise<TextLine[]> {
  return (await listPageText(docId, pageIndex)).lines;
}

/** Loads the replacement fonts once per session. */
export async function loadFonts(docId: string): Promise<ReplacementFont[]> {
  const known = useTextEdit.getState().fonts;
  if (known) return known;
  const result = await runOp(
    'text.listFonts',
    {},
    { sessionId: docId, title: t('textEdit.listing'), silent: true },
  );
  const fonts = ((result.data as { fonts?: ReplacementFont[] } | undefined)?.fonts ?? []).slice();
  useTextEdit.getState().setFonts(fonts);
  return fonts;
}

/** text.checkText: would the text fit the font of the line? Changes nothing. */
export async function checkLine(
  docId: string,
  lineId: string,
  newText: string,
): Promise<CheckResult> {
  const result = await runOp('text.checkText', checkTextParams(lineId, newText), {
    sessionId: docId,
    title: t('textEdit.checking'),
    silent: true,
  });
  return result.data as CheckResult;
}

/** Reads the lines of the pages again for the current revision (after an edit or a jump). */
export async function reloadLines(docId: string, pages: number[]): Promise<void> {
  const key = textRevisionKey(docId);
  useTextEdit.getState().resetFor(key);
  for (const index of pages) {
    const { lines, blocks, paragraphs } = await listPageText(docId, index);
    useTextEdit.getState().setPage(key, index, lines, blocks, paragraphs);
  }
}

/** Paragraph mode: the text of a paragraph is replaced and re-flowed (text.editParagraph). */
export async function applyParagraph(docId: string): Promise<boolean> {
  const para = useTextEdit.getState().paraEditor;
  if (!para) return false;
  const store = useTextEdit.getState();
  const style: ParagraphStyle = para.style;
  store.patchParagraph({ applying: true, error: null });
  const result = await runDocOp(
    docId,
    'text.editParagraph',
    editParagraphParams(para.pageIndex, para.paragraphId, para.text, {
      fontStrategy: store.fontStrategy,
      fontName: store.fontName,
      style,
    }),
    t('textEdit.op.paragraph'),
    {
      toastWarnings: false,
      onError: (e) => {
        if (textErrorCode(e) === null) return false;
        useTextEdit.getState().patchParagraph({ applying: false, error: textErrorText(e) });
        return true;
      },
    },
  );
  if (!result) {
    useTextEdit.getState().patchParagraph({ applying: false });
    return false;
  }
  await afterParagraph(docId, para.pageIndex, result.data as ParagraphResultData | undefined);
  return true;
}

/** After a paragraph op: warnings to the user, the overlapped blocks drawn, lines read again. */
async function afterParagraph(
  docId: string,
  pageIndex: number,
  data: ParagraphResultData | undefined,
): Promise<void> {
  // Read the old lines before they are dropped by the reload: the paragraph keeps its place.
  const before = useTextEdit.getState();
  const oldId = before.paraEditor?.paragraphId ?? before.selectedParagraphId;
  const centre = oldId ? paragraphCentre(before.lines[pageIndex] ?? [], oldId) : null;
  warnParagraph(docId, pageIndex, data);
  useTextEdit.getState().closeParagraph();
  await reloadLines(docId, [pageIndex]).catch((e: unknown) => showError(e));
  if (oldId) selectAfterReload(pageIndex, oldId, centre);
}

/** Toast and highlights for the overflow and the overlapped blocks of a paragraph change. */
function warnParagraph(docId: string, pageIndex: number, data: ParagraphResultData | undefined) {
  const blocks: TextBlock[] = useTextEdit.getState().blocks[pageIndex] ?? [];
  const w = paragraphWarnings(data, blocks);
  const parts: string[] = [];
  if (w.overflow > 0) parts.push(t('textEdit.warn.overflow', { pt: w.overflow }));
  if (w.overlapBlocks.length > 0) {
    parts.push(t('textEdit.warn.overlap', { count: w.overlapBlocks.length }));
    useHighlight.getState().show(docId, overlapHighlights(pageIndex, w.overlapBlocks));
  }
  parts.push(...w.messages);
  if (parts.length > 0) toast.warning(t('textEdit.op.paragraph'), parts.join(' '));
}

/** Selects the paragraph that replaces oldId on a page read again (see reselectParagraph). */
function selectAfterReload(pageIndex: number, oldId: string, centre: [number, number] | null) {
  const lines = useTextEdit.getState().lines[pageIndex] ?? [];
  useTextEdit.getState().setSelectedParagraph(reselectParagraph(lines, oldId, centre));
}

/**
 * Format bar (D14): one style change on a paragraph, applied at once. Each change is one revision,
 * so one Ctrl+Z undoes one change. The bar takes no new change while one runs.
 */
export function applyFormat(
  docId: string,
  patch: Partial<ParagraphStyle>,
  fontName: string | null = null,
): Promise<boolean> {
  const run = formatQueue.then(() => runFormat(docId, patch, fontName));
  formatQueue = run.catch(() => false);
  return run;
}

/** Changes queued by the format bar: each runs after the one before (one op at a time). */
let formatQueue: Promise<boolean> = Promise.resolve(true);

/** Runs one format change on the paragraph that is selected when it starts (not when queued). */
async function runFormat(
  docId: string,
  patch: Partial<ParagraphStyle>,
  fontName: string | null,
): Promise<boolean> {
  const store = useTextEdit.getState();
  const paragraphId = store.selectedParagraphId;
  const pageIndex = paragraphId ? pageOfParagraph(paragraphId) : null;
  if (!paragraphId || pageIndex === null) return false;
  const centre = paragraphCentre(store.lines[pageIndex] ?? [], paragraphId);
  store.setFormatBusy(true);
  try {
    const result = await runDocOp(
      docId,
      'text.styleParagraph',
      styleParagraphParams(pageIndex, paragraphId, { ...KEEP_STYLE, ...patch }, 'auto', fontName),
      t('textEdit.op.style'),
      { toastWarnings: false },
    );
    if (!result) return false;
    warnParagraph(docId, pageIndex, result.data as ParagraphResultData | undefined);
    await reloadLines(docId, [pageIndex]);
    selectAfterReload(pageIndex, paragraphId, centre);
    return true;
  } catch (e) {
    showError(e);
    return false;
  } finally {
    useTextEdit.getState().setFormatBusy(false);
  }
}

/** Warnings of a finished text.editLine, as text lines for the toast. */
export function editWarnings(data: unknown): string[] {
  const d = data as
    | { fontFrom?: string | null; fontTo?: string | null; overflow?: number; warnings?: string[] }
    | undefined;
  const out: string[] = [];
  if (d?.fontTo && d.fontTo !== d.fontFrom) out.push(t('textEdit.warn.font', { font: d.fontTo }));
  if ((d?.overflow ?? 0) > 0) out.push(t('textEdit.warn.overflow', { pt: d!.overflow }));
  for (const w of d?.warnings ?? []) out.push(w);
  return out;
}

/**
 * Applies the open editor: text.editLine with the options of the editor. Failures keep the editor
 * open with the Vietnamese error; a stale id refetches the lines.
 */
export async function applyEditor(docId: string, editor: Editor): Promise<boolean> {
  const store = useTextEdit.getState();
  const opts = {
    fontStrategy: store.fontStrategy,
    fontName: store.fontName,
    fitWidth: store.fitWidth,
  };
  const params = editLineParams(
    { id: editor.lineId, pageIndex: editor.pageIndex },
    editor.text,
    opts,
  );
  const result: OpResult | null = await runDocOp(
    docId,
    'text.editLine',
    params,
    t('textEdit.op.edit'),
    {
      toastWarnings: false,
      onError: (e) => {
        const code = textErrorCode(e);
        if (code === null) return false;
        useTextEdit.getState().dispatch({ type: 'failed', message: textErrorText(e) });
        if (needsRefetch(code)) void reloadLines(docId, [editor.pageIndex]);
        return true;
      },
    },
  );
  if (!result) return false;
  const warnings = editWarnings(result.data);
  if (warnings.length > 0) toast.warning(t('textEdit.op.edit'), warnings.join(' '));
  useTextEdit.getState().dispatch({ type: 'applied' });
  await reloadLines(docId, [editor.pageIndex]).catch((e: unknown) => showError(e));
  return true;
}
