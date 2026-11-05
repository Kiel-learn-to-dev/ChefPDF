import { describe, expect, it } from 'vitest';
import type { TextLine } from './textEditModel';
import { paragraphText } from './textParagraphModel';
import { clampRange, indexAt, paragraphGlyphs, rangeBoxes, wordRange } from './textSelection';

const P = 'P0:aaaaaaaaaaaa:0';

/** A line whose characters are 10 pt wide, starting at x = left. */
function line(id: string, text: string, top: number, left = 0): TextLine {
  const glyphs: [number, number][] = [...text].map((_, k) => [left + k * 10, left + (k + 1) * 10]);
  return {
    id,
    pageIndex: 0,
    text,
    bbox: [left, top, left + text.length * 10, top + 10],
    fontName: 'F',
    fontSize: 10,
    bold: false,
    italic: false,
    canEncodeAny: true,
    paragraphId: P,
    editable: true,
    artifact: false,
    glyphs,
  };
}

const LINES = [line('a', 'Hợp đồng', 0), line('b', 'này', 12)];

describe('paragraphGlyphs', () => {
  it('reads the same text as paragraphText, with a join space between lines', () => {
    const pg = paragraphGlyphs(LINES, P);
    expect(pg.text).toBe(paragraphText(LINES, P));
    expect(pg.text).toBe('Hợp đồng này');
    expect(pg.rows).toBe(2);
  });

  it('indexes each character by its place in the text', () => {
    const pg = paragraphGlyphs(LINES, P);
    expect(pg.glyphs.map((g) => g.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
    expect(pg.glyphs[8]).toMatchObject({ row: 1, left: 0, right: 10 });
  });

  it('spreads the characters over the box when a line has no glyph pairs', () => {
    const bare = { ...line('c', 'abcd', 0), glyphs: undefined };
    const pg = paragraphGlyphs([bare], P);
    expect(pg.glyphs.map((g) => g.left)).toEqual([0, 10, 20, 30]);
    expect(pg.glyphs[3]!.right).toBe(40);
  });

  it('uses the glyph pairs of the untrimmed text', () => {
    const padded = {
      ...line('d', '  ab', 0),
      glyphs: [
        [0, 5],
        [5, 10],
        [10, 20],
        [20, 30],
      ] as [number, number][],
    };
    const pg = paragraphGlyphs([padded], P);
    expect(pg.text).toBe('ab');
    expect(pg.glyphs.map((g) => g.left)).toEqual([10, 20]);
  });
});

describe('indexAt', () => {
  const pg = paragraphGlyphs(LINES, P);

  it('gives the boundary nearest the point in its row', () => {
    expect(indexAt(pg, 0, 5)).toBe(0);
    expect(indexAt(pg, 33, 5)).toBe(3);
    expect(indexAt(pg, 200, 5)).toBe(8);
  });

  it('picks the row by its band, and the start of a row by x', () => {
    expect(indexAt(pg, 4, 17)).toBe(9);
    expect(indexAt(pg, 25, 17)).toBe(11);
  });

  it('clamps a point beyond the paragraph to its ends', () => {
    expect(indexAt(pg, -50, -50)).toBe(0);
    expect(indexAt(pg, 500, 500)).toBe(12);
  });
});

describe('rangeBoxes', () => {
  const pg = paragraphGlyphs(LINES, P);

  it('gives one box per row the range touches', () => {
    expect(rangeBoxes(pg, 2, 5)).toEqual([{ left: 20, top: 0, width: 30, height: 10 }]);
    expect(rangeBoxes(pg, 6, 10)).toEqual([
      { left: 60, top: 0, width: 20, height: 10 },
      { left: 0, top: 12, width: 10, height: 10 },
    ]);
  });

  it('is empty for a collapsed range', () => {
    expect(rangeBoxes(pg, 4, 4)).toEqual([]);
  });
});

describe('wordRange', () => {
  it('selects the word around the index', () => {
    expect(wordRange('Hợp đồng này', 1)).toEqual([0, 3]);
    expect(wordRange('Hợp đồng này', 5)).toEqual([4, 8]);
  });

  it('stops at the ends of the text', () => {
    expect(wordRange('Hợp đồng này', 0)).toEqual([0, 3]);
    expect(wordRange('Hợp đồng này', 99)).toEqual([9, 12]);
  });
});

describe('clampRange', () => {
  it('keeps a range inside a text that got shorter', () => {
    expect(clampRange(3, 40, 10)).toEqual({ anchor: 3, caret: 10 });
    expect(clampRange(-2, 4, 10)).toEqual({ anchor: 0, caret: 4 });
  });
});
