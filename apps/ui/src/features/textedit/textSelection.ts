/**
 * Selection of text on the page (1.1, D65). A selection is a range of one paragraph: its anchor and
 * caret are indices into paragraphText(), the text the paragraph session edits, so the range carries
 * over to the textbox unchanged. The boxes come from the glyph pairs of text.getLines (the real
 * positions of the PDF), not from a re-flow.
 */
import type { TextLine } from './textEditModel';
import { paragraphLines } from './textParagraphModel';

/** A range of text in one paragraph. anchor and caret are text indices; equal means no range. */
export interface PageSelection {
  pageIndex: number;
  paragraphId: string;
  anchor: number;
  caret: number;
}

/** One character of a paragraph: its text index and its box (points, displayed frame). */
export interface Glyph {
  index: number;
  row: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A paragraph as the editor reads it: the same text as paragraphText(), with a box per character. */
export interface ParagraphGlyphs {
  text: string;
  glyphs: Glyph[];
  /** Number of visual rows (lines) of the paragraph. */
  rows: number;
}

/** The box of a range on one row (points). */
export interface RangeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The characters of a paragraph in the order of its text. Each line contributes its text trimmed
 * (as paragraphText does) and a join space between the lines that have text. A line without glyph
 * pairs (an older core) gets its characters spread evenly over its box.
 */
export function paragraphGlyphs(lines: readonly TextLine[], paragraphId: string): ParagraphGlyphs {
  const own = paragraphLines(lines, paragraphId);
  let text = '';
  const glyphs: Glyph[] = [];
  let row = 0;
  for (const line of own) {
    const body = line.text.trim();
    if (body.length === 0) continue;
    if (text.length > 0) text += ' ';
    const base = text.length;
    const lead = line.text.length - line.text.trimStart().length;
    const [l, t, r, b] = line.bbox as [number, number, number, number];
    const pairs = line.glyphs;
    const step = (r - l) / body.length;
    for (let k = 0; k < body.length; k++) {
      const pair = pairs && pairs.length === line.text.length ? pairs[lead + k] : undefined;
      glyphs.push({
        index: base + k,
        row,
        left: pair ? pair[0]! : l + k * step,
        right: pair ? pair[1]! : l + (k + 1) * step,
        top: t,
        bottom: b,
      });
    }
    text += body;
    row++;
  }
  return { text, glyphs, rows: row };
}

/** Text index nearest to a point (points) in a paragraph. Rows are chosen by their band, then x. */
export function indexAt(pg: ParagraphGlyphs, x: number, y: number): number {
  if (pg.glyphs.length === 0) return 0;
  // The row whose band holds y, else the nearest one.
  let best = 0;
  let bestDist = Infinity;
  for (let r = 0; r < pg.rows; r++) {
    const own = pg.glyphs.filter((g) => g.row === r);
    if (own.length === 0) continue;
    const top = own[0]!.top;
    const bottom = own[0]!.bottom;
    const dist = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  const row = pg.glyphs.filter((g) => g.row === best);
  // Boundaries of the row: before each character, and after the last one.
  let index = row[0]!.index;
  let dist = Infinity;
  for (const g of row) {
    const d = Math.abs(x - g.left);
    if (d < dist) {
      dist = d;
      index = g.index;
    }
  }
  const last = row[row.length - 1]!;
  if (Math.abs(x - last.right) < dist) index = last.index + 1;
  return index;
}

/** Boxes (points) of the characters between two text indices, one box per row. */
export function rangeBoxes(pg: ParagraphGlyphs, from: number, to: number): RangeBox[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (lo === hi) return [];
  const out: RangeBox[] = [];
  for (let r = 0; r < pg.rows; r++) {
    const inRange = pg.glyphs.filter((g) => g.row === r && g.index >= lo && g.index < hi);
    if (inRange.length === 0) continue;
    const left = Math.min(...inRange.map((g) => g.left));
    const right = Math.max(...inRange.map((g) => g.right));
    const top = inRange[0]!.top;
    const bottom = inRange[0]!.bottom;
    out.push({ left, top, width: right - left, height: bottom - top });
  }
  return out;
}

/** The word around a text index: from the start of the word to its end (whitespace splits words). */
export function wordRange(text: string, index: number): [number, number] {
  const at = Math.min(index, text.length);
  let from = at;
  let to = at;
  while (from > 0 && !/\s/.test(text[from - 1]!)) from--;
  while (to < text.length && !/\s/.test(text[to]!)) to++;
  return [from, to];
}

/** A range clamped to a text of the given length (after a re-read changed the text). */
export function clampRange(
  anchor: number,
  caret: number,
  length: number,
): { anchor: number; caret: number } {
  return {
    anchor: Math.max(0, Math.min(anchor, length)),
    caret: Math.max(0, Math.min(caret, length)),
  };
}
