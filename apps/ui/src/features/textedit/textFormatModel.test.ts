import { describe, expect, it } from 'vitest';
import type { TextLine } from './textEditModel';
import {
  currentFormat,
  pageOfParagraph,
  paragraphCentre,
  paragraphIndex,
  reselectParagraph,
  type ParagraphInfo,
} from './textParagraphModel';

function line(
  id: string,
  paragraphId: string,
  top: number,
  extra: Partial<TextLine> = {},
): TextLine {
  return {
    id,
    pageIndex: 0,
    text: id,
    bbox: [60, top, 200, top + 12],
    fontName: 'F',
    fontSize: 10,
    bold: false,
    italic: false,
    canEncodeAny: true,
    paragraphId,
    editable: true,
    artifact: false,
    ...extra,
  };
}

const LINES = [
  line('a1', 'P0:aaaaaaaaaaaa:0', 100),
  line('a2', 'P0:aaaaaaaaaaaa:0', 112),
  line('b1', 'P0:aaaaaaaaaaaa:1', 300, { bold: true, colour: '#ff0000', fontSize: 12 }),
];

describe('paragraph ids', () => {
  it('reads the page and the position of a paragraph id', () => {
    expect(pageOfParagraph('P3:0123456789ab:7')).toBe(3);
    expect(paragraphIndex('P3:0123456789ab:7')).toBe(7);
    expect(pageOfParagraph('bad')).toBeNull();
    expect(paragraphIndex('bad')).toBeNull();
  });
});

describe('currentFormat', () => {
  const info: ParagraphInfo[] = [
    { id: 'P0:aaaaaaaaaaaa:0', align: 'left', indent: 0 },
    { id: 'P0:aaaaaaaaaaaa:1', align: 'center', indent: 18 },
  ];

  it('takes size, weight and colour from the first line and align and indent from the paragraph', () => {
    expect(currentFormat(LINES, info, 'P0:aaaaaaaaaaaa:1')).toEqual({
      align: 'none',
      indent: 18,
      fontSize: 12,
      bold: true,
      italic: false,
      colour: '#ff0000',
    });
  });

  it('gives the alignment of a paragraph of two lines or more', () => {
    expect(currentFormat(LINES, info, 'P0:aaaaaaaaaaaa:0')?.align).toBe('left');
  });

  it('is null when the paragraph is not on the page', () => {
    expect(currentFormat(LINES, info, 'P0:aaaaaaaaaaaa:9')).toBeNull();
  });
});

describe('reselectParagraph', () => {
  it('keeps the paragraph with the same position after the page is read again', () => {
    const next = LINES.map((l) => ({
      ...l,
      paragraphId: l.paragraphId?.replace(/a/g, 'b') ?? null,
    }));
    expect(reselectParagraph(next, 'P0:aaaaaaaaaaaa:1', null)).toBe('P0:bbbbbbbbbbbb:1');
  });

  it('falls back to the paragraph that holds the old centre', () => {
    const centre = paragraphCentre(LINES, 'P0:aaaaaaaaaaaa:0');
    const moved = [line('x1', 'P0:cccccccccccc:5', 90), line('x2', 'P0:cccccccccccc:5', 102)];
    expect(reselectParagraph(moved, 'P0:aaaaaaaaaaaa:0', centre)).toBe('P0:cccccccccccc:5');
  });

  it('is null when neither the position nor the centre is on the page', () => {
    const centre = paragraphCentre(LINES, 'P0:aaaaaaaaaaaa:1');
    const other = [line('x1', 'P0:cccccccccccc:0', 100)];
    expect(reselectParagraph(other, 'P0:aaaaaaaaaaaa:1', centre)).toBeNull();
  });
});
