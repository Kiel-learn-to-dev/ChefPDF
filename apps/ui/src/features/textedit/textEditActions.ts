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
import { useTextEdit, type ReplacementFont, type SessionNote } from './textEditState';
import {
  KEEP_STYLE,
  editParagraphParams,
  overlapHighlights,
  pageOfParagraph,
  paragraphCentre,
  paragraphLines,
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

/** The notes a preview shows: the font that takes over, missing characters, overflow, overlap. */
export function previewNotes(data: ParagraphResultData & { missing?: string[] }): SessionNote[] {
  const notes: SessionNote[] = [];
  // The core keeps the paragraph's font (fontTo null) or writes it with a registry font. `missing`
  // lists what the original font lacks: it is only an error when nothing takes over.
  if (data.fontTo) {
    notes.push({ tone: 'warn', text: t('textEdit.warn.font', { font: data.fontTo }) });
  } else if (data.missing && data.missing.length > 0) {
    notes.push({
      tone: 'error',
      text: t('textEdit.chip.missing', { chars: data.missing.join(' ') }),
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
  for (const w of data.warnings ?? []) notes.push({ tone: 'warn', text: w });
  return notes;
}

/**
 * Opens a session on a paragraph of the current revision. The caret goes to the point clicked (in
 * points) when there is one, else to the end. The first preview gives the rows that the caret uses.
 * Runs in the queue, after a pending session has been written (see openSessionAt).
 */
async function startSessionBody(
  docId: string,
  pageIndex: number,
  paragraphId: string,
  point: { x: number; y: number } | null,
): Promise<void> {
  const lines = useTextEdit.getState().lines[pageIndex] ?? [];
  const own = paragraphLines(lines, paragraphId);
  if (own.length === 0) return;
  const text = paragraphText(lines, paragraphId);
  useTextEdit.getState().openSession({
    docId,
    pageIndex,
    paragraphId,
    original: text,
    fontSize: own[0]!.fontSize,
  });
  const seq = useTextEdit.getState().session?.seq ?? 0;
  const data = await previewRequest(docId, pageIndex, paragraphId, text);
  const s = useTextEdit.getState().session;
  if (!s || s.paragraphId !== paragraphId || s.seq !== seq || !data) return;
  const rows = (data.rows as SessionRow[] | undefined) ?? [];
  const caret = point ? (caretFromPoint(rows, point.x, point.y) ?? text.length) : text.length;
  useTextEdit.getState().patchSession({
    rows,
    notes: previewNotes(data),
    caret,
    anchor: caret,
  });
}

/** Writes a session still open (a failed write stays open), then tells whether none is left. */
async function closePendingSession(docId: string): Promise<boolean> {
  if (useTextEdit.getState().session) await doCommit(docId);
  return useTextEdit.getState().session === null;
}

/** Opens a session on a paragraph (Enter on the selected paragraph). */
export function startSession(docId: string, pageIndex: number, paragraphId: string): Promise<void> {
  return enqueue(async () => {
    if (!(await closePendingSession(docId))) return;
    await startSessionBody(docId, pageIndex, paragraphId, null);
  });
}

/**
 * A click at a point of the page: writes the session that is open, then opens the paragraph under
 * the point of the lines as they are now (a write can move the paragraphs). A click on no paragraph
 * only clears the selection.
 */
export function openSessionAt(
  docId: string,
  pageIndex: number,
  point: { x: number; y: number },
): Promise<void> {
  return enqueue(async () => {
    if (!(await closePendingSession(docId))) return;
    const lines = useTextEdit.getState().lines[pageIndex] ?? [];
    const hit = hitLine(lines, point.x, point.y);
    if (!hit || !hit.paragraphId) {
      useTextEdit.getState().setSelectedParagraph(null);
      return;
    }
    await startSessionBody(docId, pageIndex, hit.paragraphId, point);
  });
}

/** One preview of `newText` as the paragraph of the session would have it (read only). */
async function previewRequest(
  docId: string,
  pageIndex: number,
  paragraphId: string,
  newText: string,
): Promise<(ParagraphResultData & { missing?: string[]; rows?: unknown[] }) | null> {
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
    return result.data as (ParagraphResultData & { missing?: string[]; rows?: unknown[] }) | null;
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
    notes: previewNotes(data),
  });
}

/**
 * Writes the session's text into the paragraph: one text.editParagraph, one revision. Unchanged
 * text only closes the session. A failure keeps the session open with the Vietnamese error.
 */
export function commitSession(docId: string): Promise<boolean> {
  return enqueue(() => doCommit(docId));
}

async function doCommit(docId: string): Promise<boolean> {
  const s = useTextEdit.getState().session;
  if (!s || s.committing) return false;
  if (s.text === s.original) {
    useTextEdit.getState().closeSession();
    return true;
  }
  const { pageIndex, paragraphId, text } = s;
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
  selectAfterReload(pageIndex, paragraphId, centre);
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

/** Selects the paragraph that replaces oldId on a page read again (see reselectParagraph). */
function selectAfterReload(pageIndex: number, oldId: string, centre: [number, number] | null) {
  const lines = useTextEdit.getState().lines[pageIndex] ?? [];
  useTextEdit.getState().setSelectedParagraph(reselectParagraph(lines, oldId, centre));
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
  if (useTextEdit.getState().session) await doCommit(docId);
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

// Closing a document with an open paragraph session asks first: write the typed text, drop it, or
// stay (1.1). A failed write keeps the document open with the session.
onBeforeClose(async (docId) => {
  const s = useTextEdit.getState().session;
  if (!s || s.docId !== docId) return true;
  if (s.text === s.original) {
    cancelSession();
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
    return true;
  }
  return commitSession(docId);
});
