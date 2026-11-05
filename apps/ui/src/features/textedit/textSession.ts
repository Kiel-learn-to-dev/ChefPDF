/**
 * Caret and selection of an open paragraph (1.1, D62). The rows come from text.previewParagraph:
 * each row has the baseline start (points, displayed frame), the x of every character after the
 * row start (charX, one more than the row) and the index in the paragraph text of every character
 * (index). The caret is a text index; this module maps it to rows and back, so keys like Up, Down,
 * Home and End move by the lines the reader sees, not by the wrapping of a hidden textarea.
 */

export interface SessionRow {
  text: string;
  /** Left of the row, points. */
  x: number;
  /** Baseline of the row, points (origin top-left, as getLines). */
  baseline: number;
  charX: number[];
  index: number[];
}

export interface Pos {
  row: number;
  /** x of the caret, points. */
  x: number;
  /** Baseline of its row, points. */
  baseline: number;
}

/** Where the caret for text index i is drawn; null when there are no rows. */
export function caretAt(rows: readonly SessionRow[], i: number): Pos | null {
  if (rows.length === 0) return null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let k = 0; k < row.index.length; k++) {
      if (row.index[k] === i) return { row: r, x: row.x + row.charX[k]!, baseline: row.baseline };
    }
  }
  // No character starts at i (a wrap space, or the end): draw after the last character before it.
  let last: Pos | null = null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let k = 0; k < row.index.length; k++) {
      if (row.index[k]! < i) {
        last = { row: r, x: row.x + row.charX[k + 1]!, baseline: row.baseline };
      }
    }
  }
  if (last) return last;
  const first = rows[0]!;
  return { row: 0, x: first.x, baseline: first.baseline };
}

/** Text index of a boundary in one row, nearest to x. */
function indexInRow(row: SessionRow, x: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let k = 0; k < row.charX.length; k++) {
    const dist = Math.abs(row.x + row.charX[k]! - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = k;
    }
  }
  const n = row.index.length;
  if (best < n) return row.index[best]!;
  return n > 0 ? row.index[n - 1]! + 1 : 0;
}

/** Text index nearest to a point (points). Picks the row whose baseline is nearest to y. */
export function caretFromPoint(rows: readonly SessionRow[], x: number, y: number): number | null {
  if (rows.length === 0) return null;
  let best = 0;
  let bestDist = Infinity;
  for (let r = 0; r < rows.length; r++) {
    const dist = Math.abs(rows[r]!.baseline - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return indexInRow(rows[best]!, x);
}

/** Up or down one visual row, keeping the caret's x. Stays put at the first or last row. */
export function moveVertically(rows: readonly SessionRow[], i: number, dir: -1 | 1): number {
  const pos = caretAt(rows, i);
  if (!pos) return i;
  const target = pos.row + dir;
  if (target < 0 || target >= rows.length) return i;
  return indexInRow(rows[target]!, pos.x);
}

/** Start of the visual row the caret is on. */
export function lineStart(rows: readonly SessionRow[], i: number): number {
  const pos = caretAt(rows, i);
  if (!pos) return i;
  const row = rows[pos.row]!;
  return row.index.length > 0 ? row.index[0]! : i;
}

/** End of the visual row the caret is on (after its last character). */
export function lineEnd(rows: readonly SessionRow[], i: number): number {
  const pos = caretAt(rows, i);
  if (!pos) return i;
  const row = rows[pos.row]!;
  return row.index.length > 0 ? row.index[row.index.length - 1]! + 1 : i;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Highlight boxes (points) of the characters between two text indices, one box per row. A box
 * covers the glyph band of the row: from the baseline up by the ascent to below it.
 */
export function selectionBoxes(
  rows: readonly SessionRow[],
  from: number,
  to: number,
  fontSize: number,
): Box[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (lo === hi) return [];
  const out: Box[] = [];
  for (const row of rows) {
    let start = -1;
    let end = -1;
    for (let k = 0; k < row.index.length; k++) {
      const at = row.index[k]!;
      if (at >= lo && at < hi) {
        if (start < 0) start = k;
        end = k + 1;
      }
    }
    if (start < 0) continue;
    const left = row.x + row.charX[start]!;
    const right = row.x + row.charX[end]!;
    out.push({
      left,
      top: row.baseline - 0.8 * fontSize,
      width: right - left,
      height: 1.2 * fontSize,
    });
  }
  return out;
}
