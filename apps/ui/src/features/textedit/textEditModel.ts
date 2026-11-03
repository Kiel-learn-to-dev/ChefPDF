/**
 * Pure model of the text edit mode (D8, T7.02): line hit testing, the editor state machine, the
 * status chip of a text check, the debounced check with stale results dropped, and the param
 * builders of text.checkText / text.editLine. No DOM and no RPC here: the layer and the actions
 * use these functions.
 */
import type { TextCheckTextParams, TextEditLineParams } from '@chef/contracts';

/** A line of text.getLines (displayed frame, points, origin top-left). */
export interface TextLine {
  id: string;
  pageIndex: number;
  text: string;
  /** [left, top, right, bottom] in points. */
  bbox: number[];
  fontName: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  canEncodeAny: boolean;
  paragraphId: string | null;
  editable: boolean;
  artifact: boolean;
}

export interface CheckResult {
  supported: boolean;
  missing: string[];
  willSubstituteWith: string | null;
}

export type FitWidth = 'none' | 'shrink' | 'track';
export type FontStrategy = 'auto' | 'keep' | 'replace';

function boxOf(line: TextLine): [number, number, number, number] {
  return line.bbox as [number, number, number, number];
}

/** Hit testing: the editable line under a point (page points); the smallest box wins. */
export function hitLine(lines: readonly TextLine[], x: number, y: number): TextLine | null {
  let best: TextLine | null = null;
  let bestArea = Infinity;
  for (const line of lines) {
    if (!line.editable || line.artifact) continue;
    const [l, t, r, b] = boxOf(line);
    if (x < l || x > r || y < t || y > b) continue;
    const area = (r - l) * (b - t);
    if (area < bestArea) {
      best = line;
      bestArea = area;
    }
  }
  return best;
}

/** The next editable line in reading order (top to bottom, then left to right). */
export function nextLine(
  lines: readonly TextLine[],
  lineId: string,
  backwards = false,
): TextLine | null {
  const ordered = lines
    .filter((l) => l.editable && !l.artifact)
    .slice()
    .sort((a, b) => boxOf(a)[1] - boxOf(b)[1] || boxOf(a)[0] - boxOf(b)[0]);
  const i = ordered.findIndex((l) => l.id === lineId);
  if (i < 0) return ordered[0] ?? null;
  const j = backwards ? i - 1 : i + 1;
  return ordered[j] ?? null;
}

/** Screen box (px) of a line, from the measured page (px per point and page origin). */
export function lineScreenBox(
  line: TextLine,
  page: { left: number; top: number; scale: number },
): { left: number; top: number; width: number; height: number } {
  const [l, t, r, b] = boxOf(line);
  return {
    left: page.left + l * page.scale,
    top: page.top + t * page.scale,
    width: (r - l) * page.scale,
    height: (b - t) * page.scale,
  };
}

/** The text is what the line already says: no check, and nothing to apply. */
export function isUnchanged(line: Pick<TextLine, 'text'>, text: string): boolean {
  return text === line.text;
}

export type ChipTone = 'none' | 'ok' | 'warn' | 'error';
export interface Chip {
  tone: ChipTone;
  /** i18n key under textEdit.chip. */
  key: 'idle' | 'ok' | 'substitute' | 'missing';
  params: Record<string, string>;
}

/** Status chip of a check: ok when the font writes the text, warn when a replacement font is
 * used, error when characters are missing. Unchanged text shows no chip. */
export function chipFor(check: CheckResult | null, unchanged: boolean): Chip {
  if (unchanged || !check) return { tone: 'none', key: 'idle', params: {} };
  if (check.supported) return { tone: 'ok', key: 'ok', params: {} };
  if (check.willSubstituteWith) {
    return { tone: 'warn', key: 'substitute', params: { font: check.willSubstituteWith } };
  }
  return { tone: 'error', key: 'missing', params: { chars: check.missing.join(' ') } };
}

/** Apply is allowed when the text is covered by the line's font or by a replacement font. */
export function canApply(check: CheckResult | null): boolean {
  if (!check) return true;
  return check.supported || !!check.willSubstituteWith;
}

// -- editor state machine ----------------------------------------------------------------------

export type EditorPhase = 'editing' | 'checking' | 'ready' | 'applying';

export interface Editor {
  phase: EditorPhase;
  lineId: string;
  pageIndex: number;
  original: string;
  text: string;
  /** Latest accepted check result. */
  check: CheckResult | null;
  /** Sequence of the newest text; results of older sequences are dropped. */
  seq: number;
  /** Error text of the last failed apply (null when none). */
  error: string | null;
}

export type EditorEvent =
  | { type: 'open'; line: TextLine }
  | { type: 'type'; text: string }
  | { type: 'checking'; seq: number }
  | { type: 'checked'; seq: number; result: CheckResult }
  | { type: 'checkFailed'; seq: number }
  | { type: 'apply' }
  | { type: 'applied' }
  | { type: 'failed'; message: string }
  | { type: 'cancel' };

/**
 * Editor transitions: editing (typing) -> checking (request sent) -> ready (result shown) ->
 * applying (text.editLine running) -> closed (null). A failed apply goes back to ready with the
 * error text. Cancel (Esc) closes from any phase.
 */
export function reduceEditor(state: Editor | null, ev: EditorEvent): Editor | null {
  if (ev.type === 'open') {
    return {
      phase: 'editing',
      lineId: ev.line.id,
      pageIndex: ev.line.pageIndex,
      original: ev.line.text,
      text: ev.line.text,
      check: null,
      seq: 0,
      error: null,
    };
  }
  if (ev.type === 'cancel' || ev.type === 'applied') return null;
  if (!state) return null;
  switch (ev.type) {
    case 'type':
      if (state.phase === 'applying') return state;
      return {
        ...state,
        phase: 'editing',
        text: ev.text,
        seq: state.seq + 1,
        check: null,
        error: null,
      };
    case 'checking':
      if (state.phase === 'applying' || ev.seq !== state.seq) return state;
      return { ...state, phase: 'checking' };
    case 'checked':
      // Stale: a newer text superseded this request.
      if (ev.seq !== state.seq || state.phase !== 'checking') return state;
      return { ...state, phase: 'ready', check: ev.result };
    case 'checkFailed':
      if (ev.seq !== state.seq || state.phase !== 'checking') return state;
      return { ...state, phase: 'editing', check: null };
    case 'apply':
      if (state.phase === 'applying' || !canApply(state.check)) return state;
      return { ...state, phase: 'applying', error: null };
    case 'failed':
      return { ...state, phase: 'ready', error: ev.message };
  }
}

// -- debounced check -------------------------------------------------------------------------

export interface CheckScheduler {
  /** Asks for a check of `text` after the delay; a request still waiting is replaced. */
  schedule(seq: number, text: string): void;
  cancel(): void;
}

/**
 * Debounced text.checkText calls. A result is handed to onResult only while its sequence is the
 * newest one, so a slow answer for older text never reaches the editor.
 */
export function createCheckScheduler(opts: {
  delayMs: number;
  run(text: string): Promise<CheckResult>;
  onStart(seq: number): void;
  onResult(seq: number, result: CheckResult): void;
  onError(seq: number): void;
}): CheckScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = -1;
  return {
    schedule(seq, text) {
      latest = seq;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        opts.onStart(seq);
        opts.run(text).then(
          (result) => {
            if (seq === latest) opts.onResult(seq, result);
          },
          () => {
            if (seq === latest) opts.onError(seq);
          },
        );
      }, opts.delayMs);
    },
    cancel() {
      latest = -1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

// -- op params ---------------------------------------------------------------------------------

export function checkTextParams(lineId: string, newText: string): TextCheckTextParams {
  return { lineId, newText, keepStyle: true };
}

export function editLineParams(
  line: Pick<TextLine, 'id' | 'pageIndex'>,
  newText: string,
  opts: { fontStrategy: FontStrategy; fontName?: string | null; fitWidth: FitWidth },
): TextEditLineParams {
  const params: TextEditLineParams = {
    pageIndex: line.pageIndex,
    lineId: line.id,
    newText,
    fontStrategy: opts.fontStrategy,
    keepStyle: true,
    fitWidth: opts.fitWidth,
  };
  // A chosen font implies replace in the core; it is sent only when set.
  if (opts.fontName) params.fontName = opts.fontName;
  return params;
}

/** Codes that mean the line ids on screen are old: the lines are fetched again. */
export function needsRefetch(code: string | null): boolean {
  return code === 'STALE_OBJECT_IDS' || code === 'LINE_NOT_FOUND';
}
