/**
 * The textbox of a paragraph (D62, D65): the paragraph is drawn from the core's rows (the same plan
 * the commit writes), in the font the commit writes, with a caret and a selection placed by the text
 * index of each character. Keys go to a hidden textarea, so typing, IME and the clipboard work as in
 * a text field. Up, Down, Home and End move by the lines the reader sees. Esc drops the textbox;
 * Ctrl+Enter or a click outside writes it (one revision).
 */
import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { pagePt, type MeasuredPage } from '../objects/pageMeasure';
import {
  cancelSession,
  changeSessionText,
  commitSession,
  moveSessionCaret,
} from './textEditActions';
import { useTextEdit, type RenderFont } from './textEditState';
import type { TextLine } from './textEditModel';
import { paragraphBox, paragraphLines } from './textParagraphModel';
import {
  caretAt,
  caretFromPoint,
  lineEnd,
  lineStart,
  moveVertically,
  selectionBoxes,
  type SessionRow,
} from './textSession';
import { wordRange } from './textSelection';
import './textedit.css';

/** Ascent of a glyph as a share of its size: the glyph box sits on the baseline. */
const ASCENT = 0.8;
/** Margin (points) around the paragraph in the session area. */
const MARGIN = 3;

type Box = [number, number, number, number];

/**
 * CSS font of the glyphs: the family the commit writes when it is installed on this computer, else
 * the generic family of its style (a bundled font that is not installed shows in that style).
 */
export function renderCss(render: RenderFont | null): string {
  const generic =
    render?.style === 'serif' ? 'serif' : render?.style === 'mono' ? 'monospace' : 'sans-serif';
  if (!render?.family) return generic;
  return `"${render.family.replace(/["\\]/g, '')}", ${generic}`;
}

export function ParagraphSession({
  docId,
  page,
  lines,
}: {
  docId: string;
  page: MeasuredPage;
  lines: readonly TextLine[];
}) {
  const { t } = useTranslation();
  const session = useTextEdit((s) => s.session);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);
  const dragAnchor = useRef(0);

  // The session takes the keyboard as soon as it opens (a new paragraph or a new page), with the
  // range it opened on selected in the input: typing replaces that range, as in a word processor.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!session || !el) return;
    el.focus();
    el.setSelectionRange(
      Math.min(session.anchor, session.caret),
      Math.max(session.anchor, session.caret),
      session.caret < session.anchor ? 'backward' : 'forward',
    );
    // Only on opening: the session's own keys keep the input's selection in step afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.paragraphId, session?.pageIndex]);

  if (!session) return null;

  const k = page.scale;
  const size = session.fontSize;
  const rows: SessionRow[] = session.rows ?? [];
  const area = sessionArea(lines, session.paragraphId, rows, size);
  if (!area) return null;
  // Everything inside the area is placed relative to its corner, in screen px.
  const [ax, ay, aw, ah] = area;
  const left = page.left + ax * k;
  const top = page.top + ay * k;
  const rx = (x: number) => (x - ax) * k;
  const ry = (y: number) => (y - ay) * k;

  // The rows are drawn over the PDF text (the mask hides it) once the first preview has answered.
  const drawn = session.rows !== null;
  const colour = paragraphLines(lines, session.paragraphId)[0]?.colour ?? '#111';
  const glyphStyle = {
    fontFamily: renderCss(session.render),
    fontWeight: session.render?.bold ? 700 : 400,
    fontStyle: session.render?.italic ? 'italic' : 'normal',
    color: colour,
  };
  const at = caretAt(rows, session.caret);
  const boxes = selectionBoxes(rows, session.anchor, session.caret, size);

  const setCaret = (caret: number, anchor: number) => {
    moveSessionCaret(caret, anchor);
    inputRef.current?.setSelectionRange(
      Math.min(anchor, caret),
      Math.max(anchor, caret),
      caret < anchor ? 'backward' : 'forward',
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const st = useTextEdit.getState().session;
    if (!st) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelSession();
    } else if (mod && (e.key === 'Enter' || key === 's')) {
      // The paragraph is written; the document is saved by a later Ctrl+S.
      e.preventDefault();
      e.stopPropagation();
      void commitSession();
    } else if (mod && (key === 'z' || key === 'y')) {
      // Typing keeps its own undo; the document's undo waits until the session is written.
      e.stopPropagation();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const target = moveVertically(rows, st.caret, e.key === 'ArrowUp' ? -1 : 1);
      setCaret(target, e.shiftKey ? st.anchor : target);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const target = e.key === 'Home' ? lineStart(rows, st.caret) : lineEnd(rows, st.caret);
      setCaret(target, e.shiftKey ? st.anchor : target);
    }
  };

  const onSelect = () => {
    const el = inputRef.current;
    if (!el) return;
    const backward = el.selectionDirection === 'backward';
    moveSessionCaret(
      backward ? el.selectionStart : el.selectionEnd,
      backward ? el.selectionEnd : el.selectionStart,
    );
  };

  /** A pointer position in points on the page, from the layer that holds the page. */
  const pointOf = (e: PointerEvent<HTMLDivElement>) => {
    const layer = e.currentTarget.closest('.tedit-layer')?.getBoundingClientRect();
    if (!layer) return null;
    return pagePt(page, { x: e.clientX - layer.left, y: e.clientY - layer.top });
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    inputRef.current?.focus();
    const pt = pointOf(e);
    const index = pt ? caretFromPoint(rows, pt.x, pt.y) : null;
    if (index === null) return;
    dragging.current = true;
    const st = useTextEdit.getState().session;
    dragAnchor.current = e.shiftKey && st ? st.anchor : index;
    setCaret(index, dragAnchor.current);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const pt = pointOf(e);
    const index = pt ? caretFromPoint(rows, pt.x, pt.y) : null;
    if (index !== null) setCaret(index, dragAnchor.current);
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const st = useTextEdit.getState().session;
    if (!st) return;
    const [from, to] = wordRange(st.text, st.caret);
    setCaret(to, from);
  };

  const caretX = at ? rx(at.x) : 0;
  const caretY = at ? ry(at.baseline - ASCENT * size) : 0;

  return (
    <>
      <div
        className="tedit-sess"
        data-testid="tedit-session"
        style={{ left, top, width: aw * k, height: ah * k }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onDoubleClick={onDoubleClick}
      >
        {drawn && (
          <div
            className="tedit-sess__mask"
            style={{ left: 0, top: 0, width: aw * k, height: ah * k }}
          />
        )}
        {boxes.map((b, i) => (
          <div
            key={`s${i}`}
            className="tedit-sess__select"
            style={{ left: rx(b.left), top: ry(b.top), width: b.width * k, height: b.height * k }}
          />
        ))}
        {drawn &&
          rows.map((row, r) =>
            [...row.text].map((ch, c) =>
              ch === ' ' ? null : (
                <span
                  key={`${r}-${c}`}
                  className="tedit-sess__glyph"
                  style={{
                    ...glyphStyle,
                    left: rx(row.x + row.charX[c]!),
                    top: ry(row.baseline - ASCENT * size),
                    fontSize: size * k,
                  }}
                >
                  {ch}
                </span>
              ),
            ),
          )}
        {at && (
          <div
            className="tedit-sess__caret"
            data-testid="tedit-caret"
            style={{ left: caretX, top: caretY, height: 1.2 * size * k }}
          />
        )}
        <textarea
          ref={inputRef}
          className="tedit-sess__input"
          aria-label={t('textEdit.session.label')}
          value={session.text}
          spellCheck={false}
          style={{ left: caretX, top: caretY }}
          onChange={(e) =>
            changeSessionText(docId, e.target.value, e.target.selectionEnd, e.target.selectionStart)
          }
          onSelect={onSelect}
          onKeyDown={onKeyDown}
          // Losing the focus keeps the session: a click on the page writes it, and closing asks.
        />
      </div>
    </>
  );
}

/**
 * The area of the session in points: the paragraph box before the edit and the rows now, with a
 * margin. Null when there is neither.
 */
function sessionArea(
  lines: readonly TextLine[],
  paragraphId: string,
  rows: readonly SessionRow[],
  size: number,
): [number, number, number, number] | null {
  const boxes: Box[] = [];
  const old = paragraphBox(lines, paragraphId);
  if (old) boxes.push(old as Box);
  if (rows.length > 0) {
    boxes.push([
      Math.min(...rows.map((r) => r.x)),
      Math.min(...rows.map((r) => r.baseline - ASCENT * size)),
      Math.max(...rows.map((r) => r.x + (r.charX[r.charX.length - 1] ?? 0))),
      Math.max(...rows.map((r) => r.baseline + 0.3 * size)),
    ]);
  }
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b[0])) - MARGIN;
  const top = Math.min(...boxes.map((b) => b[1])) - MARGIN;
  const right = Math.max(...boxes.map((b) => b[2])) + MARGIN;
  const bottom = Math.max(...boxes.map((b) => b[3])) + MARGIN;
  return [left, top, right - left, bottom - top];
}
