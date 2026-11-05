/**
 * The paragraph being typed into (D62): the paragraph is drawn from the core's rows (the same plan
 * the commit writes), with a caret and a selection placed by the text index of each character.
 * Keys go to a hidden textarea, so typing, IME and the clipboard work as in a text field. Up, Down,
 * Home and End move by the lines the reader sees. Esc drops the session; Ctrl+Enter or a click
 * outside the paragraph writes it (one revision).
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { pagePt, type MeasuredPage } from '../objects/pageMeasure';
import {
  cancelSession,
  changeSessionText,
  commitSession,
  moveSessionCaret,
} from './textEditActions';
import { useTextEdit } from './textEditState';
import type { TextLine } from './textEditModel';
import { paragraphBox } from './textParagraphModel';
import {
  caretAt,
  caretFromPoint,
  lineEnd,
  lineStart,
  moveVertically,
  selectionBoxes,
  type SessionRow,
} from './textSession';
import './textedit.css';

/** Ascent of a glyph as a share of its size: the glyph box sits on the baseline. */
const ASCENT = 0.8;
/** Margin (points) around the paragraph in the session area. */
const MARGIN = 3;

type Box = [number, number, number, number];

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

  // The session takes the keyboard as soon as it opens (a new paragraph or a new page).
  useEffect(() => {
    if (session) inputRef.current?.focus();
  }, [session?.paragraphId, session?.pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const dirty = session.text !== session.original;
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
      void commitSession(docId);
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
    const text = st.text;
    let from = Math.min(st.caret, text.length);
    let to = from;
    while (from > 0 && !/\s/.test(text[from - 1]!)) from--;
    while (to < text.length && !/\s/.test(text[to]!)) to++;
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
        {dirty && (
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
        {dirty &&
          rows.map((row, r) =>
            [...row.text].map((ch, c) =>
              ch === ' ' ? null : (
                <span
                  key={`${r}-${c}`}
                  className="tedit-sess__glyph"
                  style={{
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
          onBlur={() => {
            if (!dragging.current) void commitSession(docId);
          }}
        />
      </div>
      <div className="tedit-sess__notes" style={{ left, top: Math.max(0, top - 26) }}>
        {session.notes.map((n, i) => (
          <span
            key={i}
            className={`tedit-chip tedit-chip--${n.tone === 'error' ? 'error' : 'warn'}`}
            role="status"
          >
            {n.text}
          </span>
        ))}
        {session.committing && (
          <span className="tedit-chip tedit-chip--none">{t('textEdit.session.saving')}</span>
        )}
      </div>
      <div className="tedit-sess__hint" style={{ left, top: top + ah * k + 4 }}>
        {t('textEdit.session.hint')}
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
