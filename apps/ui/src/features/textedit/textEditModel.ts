/**
 * Lines of the text edit mode: the line type of text.getLines and the hit test of a point on the
 * page. The paragraph session (ParagraphSession.tsx, D62) edits the paragraph under the caret; it
 * uses these functions to find the paragraph and to draw its boxes.
 */

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
  /** '#rrggbb' of the text, or null when the core does not know it. */
  colour?: string | null;
  canEncodeAny: boolean;
  paragraphId: string | null;
  editable: boolean;
  artifact: boolean;
  /** [left, right] in points of every character of `text` (one pair per index, reading order). */
  glyphs?: [number, number][];
}

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
