/**
 * Operations of the text edit mode (D8, D62). A paragraph session previews the text it would have
 * (text.previewParagraph, read only, the same plan the commit uses) and commits it once
 * (text.editParagraph: one revision, one Ctrl+Z). The format bar changes the style of a paragraph
 * the same way. Commits and style changes run in one queue, so they never overlap.
 */
import { textErrorCode, type TextErrorCode } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import { toast } from '../../components/Toast';
import { errorMessage, onBeforeClose, runDocOp, showError } from '../../app/actions';
import { confirmDialog } from '../../app/prompts';
import { getDoc } from '../../app/state/documents';
import { i18n } from '../../i18n';
import { caretFromPoint, type SessionRow } from './textSession';
import { hitLine, type TextLine } from './textEditModel';
import {
  DEFAULT_PAGES,
  DEFAULT_TEXT_FORM,
  addTextParams,
  type TextForm,
} from '../overlay/overlayModel';
import { applyOverlay } from '../overlay/overlayActions';
import { clampRange, indexAt, paragraphGlyphs, wordRange } from './textSelection';
import {
  useTextEdit,
  type RenderFont,
  type ReplacementFont,
  type SessionNote,
} from './textEditState';
import {
  KEEP_STYLE,
  editParagraphParams,
  overlapHighlights,
  paragraphCentre,
  paragraphLines,
  charsLabel,
  paragraphWarnings,
  reselectParagraph,
  styleParagraphParams,
  paragraphText,
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

/** Reads the lines of the pages again for the current revision (after an edit or a jump). */
export async function reloadLines(docId: string, pages: number[]): Promise<void> {
  const key = textRevisionKey(docId);
  useTextEdit.getState().resetFor(key);
  for (const index of pages) {
    const { lines, blocks, paragraphs } = await listPageText(docId, index);
    useTextEdit.getState().setPage(key, index, lines, blocks, paragraphs);
  }
}

/** Runs jobs one after another: commits and style changes share this queue. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => undefined);
  return run;
}

// ---------- The paragraph session ----------

/** Where a session puts its caret when it opens: at the end, at a point, or on a range (D65). */
export type SessionPlace =
  | { at: 'end' }
  | { at: 'point'; x: number; y: number }
  | { at: 'range'; anchor: number; caret: number };

/**
 * The notes a preview shows, once each: the core's warnings (they already name the font that takes
 * over, by its family), characters that no font writes, overflow and overlap.
 */
export function previewNotes(data: ParagraphResultData & { missing?: string[] }): SessionNote[] {
  const notes: SessionNote[] = (data.warnings ?? []).map((text) => ({ tone: 'warn', text }));
  if (data.missing && data.missing.length > 0 && !data.fontTo) {
    notes.push({
      tone: 'error',
      text: t('textEdit.chip.missing', { chars: charsLabel(data.missing) }),
    });
  }
  if ((data.overflow ?? 0) > 0) {
    notes.push({ tone: 'warn', text: t('textEdit.warn.overflow', { pt: data.overflow }) });
  }
  if ((data.overlapsBlockIds ?? []).length > 0) {
    notes.push({
      tone: 'warn',
      text: t('textEdit.warn.overlap', { count: data.overlapsBlockIds?.length ?? 0 }),
    });
  }
  return notes;
}

/**
 * Opens a session on a paragraph of the current revision, with the caret or the range of `place`.
 * The first preview gives the rows that the caret uses. Runs in the queue, after a pending session
 * has been written (see editSelection).
 */
async function startSessionBody(
  docId: string,
  pageIndex: number,
  paragraphId: string,
  place: SessionPlace,
): Promise<void> {
  const lines = useTextEdit.getState().lines[pageIndex] ?? [];
  const own = paragraphLines(lines, paragraphId);
  if (own.length === 0) return;
  const text = paragraphText(lines, paragraphId);
  const range = place.at === 'range' ? clampRange(place.anchor, place.caret, text.length) : null;
  useTextEdit.getState().openSession({
    docId,
    pageIndex,
    paragraphId,
    original: text,
    fontSize: own[0]!.fontSize,
    anchor: range?.anchor,
    caret: range?.caret,
  });
  const seq = useTextEdit.getState().session?.seq ?? 0;
  const data = await previewRequest(docId, pageIndex, paragraphId, text);
  const s = useTextEdit.getState().session;
  if (!s || s.paragraphId !== paragraphId || s.seq !== seq || !data) return;
  const rows = (data.rows as SessionRow[] | undefined) ?? [];
  if (range) {
    useTextEdit.getState().patchSession({
      rows,
      render: data.render ?? null,
      notes: previewNotes(data),
      anchor: range.anchor,
      caret: range.caret,
    });
    return;
  }
  const at =
    place.at === 'point' ? (caretFromPoint(rows, place.x, place.y) ?? text.length) : text.length;
  useTextEdit.getState().patchSession({
    rows,
    render: data.render ?? null,
    notes: previewNotes(data),
    caret: at,
    anchor: at,
  });
}

/** Writes a session still open (a failed write stays open), then tells whether none is left. */
async function closePendingSession(): Promise<boolean> {
  if (useTextEdit.getState().session) await doCommit();
  return useTextEdit.getState().session === null;
}

/**
 * The Sửa button and Enter: writes the session that is open, then opens a textbox on the text
 * selected on the page (D65). The selection is read after the write, since a write can move the
 * paragraph and the range with it.
 */
export function editSelection(docId: string): Promise<void> {
  return enqueue(async () => {
    if (!(await closePendingSession())) return;
    const sel = useTextEdit.getState().selection;
    if (!sel) return;
    await startSessionBody(docId, sel.pageIndex, sel.paragraphId, {
      at: 'range',
      anchor: sel.anchor,
      caret: sel.caret,
    });
  });
}

/**
 * A press on the page: writes the session that is open, then selects the text under the point (its
 * paragraph only). Shift extends the selection from its anchor; `word` selects the word there (a
 * double click). A press on no text clears the selection.
 */
export function selectAt(
  docId: string,
  pageIndex: number,
  point: { x: number; y: number },
  options: { extend?: boolean; word?: boolean } = {},
): Promise<void> {
  return enqueue(async () => {
    if (!(await closePendingSession())) return;
    if (!(await closePendingDraft())) return;
    const lines = useTextEdit.getState().lines[pageIndex] ?? [];
    const hit = hitLine(lines, point.x, point.y);
    if (!hit || !hit.paragraphId) {
      useTextEdit.getState().setSelection(null);
      return;
    }
    const paragraphId = hit.paragraphId;
    const pg = paragraphGlyphs(lines, paragraphId);
    const index = indexAt(pg, point.x, point.y);
    if (options.word) {
      const [from, to] = wordRange(pg.text, index);
      useTextEdit.getState().setSelection({ pageIndex, paragraphId, anchor: from, caret: to });
      return;
    }
    const prev = useTextEdit.getState().selection;
    const anchor = options.extend && prev && prev.paragraphId === paragraphId ? prev.anchor : index;
    useTextEdit.getState().setSelection({ pageIndex, paragraphId, anchor, caret: index });
  });
}

/** A press on the page margin: writes the textbox that is open and clears the selection. */
export function clearSelection(): Promise<void> {
  return enqueue(async () => {
    if (!(await closePendingSession())) return;
    if (!(await closePendingDraft())) return;
    useTextEdit.getState().setSelection(null);
  });
}

// ---------- Thêm văn bản (D66) ----------

/** Size of a new text box (points); Tùy chọn… changes the size, colour and page of the next one. */
export const NEW_TEXT_SIZE = 12;

/**
 * Writes the new text box as one overlay text (overlay.addText, one revision). Empty text only
 * closes the box. A failed write keeps the box open with its text.
 */
async function doCommitDraft(): Promise<boolean> {
  const d = useTextEdit.getState().draft;
  if (!d) return true;
  const docId = d.docId;
  if (d.text.trim() === '') {
    useTextEdit.getState().closeDraft();
    return true;
  }
  const pageCount = getDoc(docId)?.info.pageCount ?? d.pageIndex + 1;
  const form: TextForm = {
    ...DEFAULT_TEXT_FORM,
    text: d.text,
    fontSize: NEW_TEXT_SIZE,
    unit: 'pt',
    x: d.x,
    y: d.y,
    pages: DEFAULT_PAGES,
  };
  const ok = await applyOverlay(
    docId,
    'overlay.addText',
    addTextParams(form, d.pageIndex, pageCount),
    t('textEdit.op.addText'),
  );
  if (ok) useTextEdit.getState().closeDraft();
  return ok;
}

/** Writes the open text box, if it has one (a failed write keeps it open). */
async function closePendingDraft(): Promise<boolean> {
  if (useTextEdit.getState().draft) await doCommitDraft();
  return useTextEdit.getState().draft === null;
}

/** Writes the text box that is open (Ctrl+Enter, a press elsewhere, or leaving the mode). */
export function commitDraft(): Promise<boolean> {
  return enqueue(() => doCommitDraft());
}

/**
 * A press on the page with the add-text tool on: writes what is open, then starts a text box at the
 * point (points, displayed frame).
 */
export function startDraft(
  docId: string,
  pageIndex: number,
  point: { x: number; y: number },
): Promise<void> {
  return enqueue(async () => {
    if (!(await closePendingSession())) return;
    if (!(await closePendingDraft())) return;
    useTextEdit.getState().setSelection(null);
    useTextEdit.getState().openDraft({ docId, pageIndex, x: point.x, y: point.y });
  });
}

/** Drops the text box that is open, without writing it (Esc). */
export function cancelDraft(): void {
  useTextEdit.getState().closeDraft();
}

/** A drag over the page: the caret of the selection follows the point, within its paragraph. */
export function dragSelection(point: { x: number; y: number }): void {
  const sel = useTextEdit.getState().selection;
  if (!sel) return;
  const pg = paragraphGlyphs(useTextEdit.getState().lines[sel.pageIndex] ?? [], sel.paragraphId);
  useTextEdit.getState().setSelection({ ...sel, caret: indexAt(pg, point.x, point.y) });
}

/** One preview of `newText` as the paragraph of the session would have it (read only). */
async function previewRequest(
  docId: string,
  pageIndex: number,
  paragraphId: string,
  newText: string,
): Promise<PreviewData | null> {
  try {
    const result = await runOp(
      'text.previewParagraph',
      {
        pageIndex,
        paragraphId,
        newText,
        fontStrategy: 'auto',
        fontName: useTextEdit.getState().fontName ?? undefined,
      },
      { sessionId: docId, title: t('textEdit.checking'), silent: true },
    );
    return result.data as PreviewData | null;
  } catch (e) {
    const s = useTextEdit.getState().session;
    if (s) {
      useTextEdit.getState().patchSession({
        rows: null,
        notes: [{ tone: 'error', text: textErrorText(e) }],
      });
    }
    return null;
  }
}

/** The answer of text.previewParagraph: the commit's plan, its rows and the font they are drawn in. */
type PreviewData = ParagraphResultData & {
  missing?: string[];
  rows?: unknown[];
  render?: RenderFont;
};

let previewTimer: number | undefined;

/**
 * The text of the session changed: its preview is asked again after a short pause. An answer that
 * comes after a newer keystroke is dropped (seq).
 */
export function changeSessionText(
  docId: string,
  text: string,
  caret: number,
  anchor: number,
): void {
  const s = useTextEdit.getState().session;
  if (!s) return;
  useTextEdit.getState().patchSession({ text, caret, anchor, seq: s.seq + 1 });
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void runPreview(docId), 60);
}

/** Moves the caret and the selection end without changing the text. */
export function moveSessionCaret(caret: number, anchor: number): void {
  useTextEdit.getState().patchSession({ caret, anchor });
}

async function runPreview(docId: string): Promise<void> {
  const s = useTextEdit.getState().session;
  if (!s) return;
  const { seq, text, paragraphId, pageIndex } = s;
  const data = await previewRequest(docId, pageIndex, paragraphId, text);
  const now = useTextEdit.getState().session;
  if (!now || now.seq !== seq || !data) return;
  useTextEdit.getState().patchSession({
    rows: (data.rows as SessionRow[] | undefined) ?? [],
    render: data.render ?? null,
    notes: previewNotes(data),
  });
}

/**
 * Writes the session's text into the paragraph: one text.editParagraph, one revision. Unchanged
 * text only closes the session. A failure keeps the session open with the Vietnamese error.
 */
export function commitSession(): Promise<boolean> {
  return enqueue(() => doCommit());
}

async function doCommit(): Promise<boolean> {
  const s = useTextEdit.getState().session;
  if (!s || s.committing) return false;
  const docId = s.docId;
  if (s.text === s.original) {
    useTextEdit.getState().closeSession();
    return true;
  }
  const { pageIndex, paragraphId, text } = s;
  const range = { anchor: s.anchor, caret: s.caret };
  const centre = paragraphCentre(useTextEdit.getState().lines[pageIndex] ?? [], paragraphId);
  useTextEdit.getState().patchSession({ committing: true });
  const store = useTextEdit.getState();
  const result = await runDocOp(
    docId,
    'text.editParagraph',
    editParagraphParams(pageIndex, paragraphId, text, {
      fontStrategy: store.fontStrategy,
      fontName: store.fontName,
      style: KEEP_STYLE,
    }),
    t('textEdit.op.paragraph'),
    {
      toastWarnings: false,
      onError: (e) => {
        if (textErrorCode(e) === null) return false;
        useTextEdit.getState().patchSession({
          committing: false,
          notes: [{ tone: 'error', text: textErrorText(e) }],
        });
        return true;
      },
    },
  );
  if (!result) {
    useTextEdit.getState().patchSession({ committing: false });
    return false;
  }
  warnParagraph(docId, pageIndex, result.data as ParagraphResultData | undefined);
  useTextEdit.getState().closeSession();
  await reloadLines(docId, [pageIndex]).catch((e: unknown) => showError(e));
  selectAfterReload(pageIndex, paragraphId, centre, range);
  return true;
}

/** Drops the session without writing anything (Esc). */
export function cancelSession(): void {
  window.clearTimeout(previewTimer);
  useTextEdit.getState().closeSession();
}

// ---------- Format bar ----------

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

/**
 * Selects the paragraph that replaces oldId on a page read again (see reselectParagraph), with the
 * range clamped to its new text. Nothing is selected when the paragraph is not found.
 */
export function selectAfterReload(
  pageIndex: number,
  oldId: string,
  centre: [number, number] | null,
  range: { anchor: number; caret: number },
): void {
  const lines = useTextEdit.getState().lines[pageIndex] ?? [];
  const id = reselectParagraph(lines, oldId, centre);
  if (!id) {
    useTextEdit.getState().setSelection(null);
    return;
  }
  const length = paragraphGlyphs(lines, id).text.length;
  useTextEdit.getState().setSelection({
    pageIndex,
    paragraphId: id,
    ...clampRange(range.anchor, range.caret, length),
  });
}

/**
 * Format bar (D14): one style change on the selected paragraph, applied at once. A session that is
 * open is committed first (it is queued before the change), so the style applies to the new text.
 */
export function applyFormat(
  docId: string,
  patch: Partial<ParagraphStyle>,
  fontName: string | null = null,
): Promise<boolean> {
  return enqueue(() => runFormat(docId, patch, fontName));
}

async function runFormat(
  docId: string,
  patch: Partial<ParagraphStyle>,
  fontName: string | null,
): Promise<boolean> {
  // Text still being typed is written first, so the style applies to the text the reader sees.
  if (useTextEdit.getState().session) await doCommit();
  const store = useTextEdit.getState();
  const sel = store.selection;
  if (!sel) return false;
  const { paragraphId, pageIndex } = sel;
  const range = { anchor: sel.anchor, caret: sel.caret };
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
    selectAfterReload(pageIndex, paragraphId, centre, range);
    return true;
  } catch (e) {
    showError(e);
    return false;
  } finally {
    useTextEdit.getState().setFormatBusy(false);
  }
}

// Closing a document with an open paragraph session asks first: write the typed text, drop it, or
// stay (1.1). A failed write keeps the document open with the session.
onBeforeClose(async (docId) => {
  const s = useTextEdit.getState().session;
  const d = useTextEdit.getState().draft;
  const openSession = !!s && s.docId === docId && s.text !== s.original;
  const newText = !!d && d.docId === docId && d.text.trim() !== '';
  if (!openSession && !newText) {
    cancelSession();
    cancelDraft();
    return true;
  }
  const answer = await confirmDialog({
    title: t('close.sessionTitle'),
    message: t('close.sessionMessage'),
    actions: [
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
      { id: 'discard', label: t('close.sessionDiscard') },
      { id: 'save', label: t('close.sessionSave'), variant: 'primary' },
    ],
  });
  if (answer === null || answer === 'cancel') return false;
  if (answer === 'discard') {
    cancelSession();
    cancelDraft();
    return true;
  }
  // The open textbox is written first; a failed write keeps the document open.
  if (!(await commitSession())) return false;
  return commitDraft();
});
