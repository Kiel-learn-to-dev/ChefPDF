import { describe, expect, it } from 'vitest';
import {
  caretAt,
  caretFromPoint,
  lineEnd,
  lineStart,
  moveVertically,
  selectionBoxes,
  type SessionRow,
} from './textSession';

// "ab cd" laid out as two rows: "ab" then "cd". The space between them is not in any row.
const ROWS: SessionRow[] = [
  { text: 'ab', x: 72, baseline: 100, charX: [0, 10, 20], index: [0, 1] },
  { text: 'cd', x: 72, baseline: 114, charX: [0, 10, 20], index: [3, 4] },
];

describe('caret and text index', () => {
  it('draws the caret before a character at its x', () => {
    expect(caretAt(ROWS, 0)).toEqual({ row: 0, x: 72, baseline: 100 });
    expect(caretAt(ROWS, 4)).toEqual({ row: 1, x: 82, baseline: 114 });
  });

  it('draws the caret after the last character before a wrap space and at the end', () => {
    expect(caretAt(ROWS, 2)).toEqual({ row: 0, x: 92, baseline: 100 });
    expect(caretAt(ROWS, 5)).toEqual({ row: 1, x: 92, baseline: 114 });
  });

  it('maps a point back to the nearest text index', () => {
    expect(caretFromPoint(ROWS, 92, 100)).toBe(2);
    expect(caretFromPoint(ROWS, 72, 113)).toBe(3);
    expect(caretFromPoint(ROWS, 500, 114)).toBe(5);
  });

  it('round-trips every character position', () => {
    for (const row of ROWS) {
      for (let k = 0; k < row.index.length; k++) {
        const i = row.index[k]!;
        const at = caretAt(ROWS, i)!;
        expect(caretFromPoint(ROWS, at.x, at.baseline)).toBe(i);
      }
    }
  });
});

describe('moving the caret by visual rows', () => {
  it('moves up and down keeping the x of the caret', () => {
    expect(moveVertically(ROWS, 4, -1)).toBe(1);
    expect(moveVertically(ROWS, 1, 1)).toBe(4);
  });

  it('stays put at the first and last row', () => {
    expect(moveVertically(ROWS, 0, -1)).toBe(0);
    expect(moveVertically(ROWS, 4, 1)).toBe(4);
  });

  it('goes to the start and the end of the visual row', () => {
    expect(lineStart(ROWS, 4)).toBe(3);
    expect(lineEnd(ROWS, 4)).toBe(5);
    expect(lineEnd(ROWS, 0)).toBe(2);
  });
});

describe('selection boxes', () => {
  it('gives one box per row that holds selected characters', () => {
    const boxes = selectionBoxes(ROWS, 0, 5, 10);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ left: 72, width: 20 });
    expect(boxes[1]).toMatchObject({ left: 72, width: 20 });
  });

  it('gives nothing for an empty selection', () => {
    expect(selectionBoxes(ROWS, 2, 2, 10)).toEqual([]);
  });
});
