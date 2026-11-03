import { describe, expect, it } from 'vitest';
import {
  KEEP_STYLE,
  canApplyParagraph,
  editParagraphParams,
  hasStyleChange,
  overlapHighlights,
  paragraphBox,
  paragraphLines,
  paragraphOf,
  paragraphText,
  paragraphWarnings,
  styleParagraphParams,
  type TextBlock,
} from './textParagraphModel';
import type { TextLine } from './textEditModel';

function line(
  id: string,
  paragraphId: string | null,
  bbox: number[],
  text: string,
  over: Partial<TextLine> = {},
): TextLine {
  return {
    id,
    pageIndex: 0,
    text,
    bbox,
    fontName: 'Helvetica',
    fontSize: 11,
    bold: false,
    italic: false,
    canEncodeAny: true,
    paragraphId,
    editable: true,
    artifact: false,
    ...over,
  };
}

const LINES: TextLine[] = [
  line('L2', 'P1', [72, 110, 300, 122], 'trong vòng 30 ngày'),
  line('L1', 'P1', [72, 96, 300, 108], 'Bên A thanh toán'),
  line('L3', 'P2', [72, 200, 300, 212], 'Điều khoản khác'),
  line('W', 'P1', [0, 0, 10, 10], 'WM', { artifact: true }),
  line('N', null, [72, 300, 300, 312], 'Trang 1'),
];

describe('paragraph lines and text', () => {
  it('lists the lines of a paragraph top to bottom, without artifacts', () => {
    expect(paragraphLines(LINES, 'P1').map((l) => l.id)).toEqual(['L1', 'L2']);
  });

  it('joins the lines with a space for the editor', () => {
    expect(paragraphText(LINES, 'P1')).toBe('Bên A thanh toán trong vòng 30 ngày');
    expect(paragraphText(LINES, 'missing')).toBe('');
  });

  it('boxes the paragraph as the union of its lines', () => {
    expect(paragraphBox(LINES, 'P1')).toEqual([72, 96, 300, 122]);
    expect(paragraphBox(LINES, 'missing')).toBeNull();
  });

  it('reads the paragraph of a line', () => {
    expect(paragraphOf(LINES[2]!)).toBe('P2');
    expect(paragraphOf(LINES[4]!)).toBeNull();
    expect(paragraphOf(null)).toBeNull();
  });
});

describe('style', () => {
  it('detects whether any style field changes', () => {
    expect(hasStyleChange(KEEP_STYLE)).toBe(false);
    expect(hasStyleChange({ ...KEEP_STYLE, align: 'justify' })).toBe(true);
    expect(hasStyleChange({ ...KEEP_STYLE, lineSpacing: 14 })).toBe(true);
  });

  it('applies only the chosen style fields in styleParagraph', () => {
    const p = styleParagraphParams(1, 'P1', { ...KEEP_STYLE, bold: true, color: '#c00000' });
    expect(p).toMatchObject({
      pageIndex: 1,
      paragraphId: 'P1',
      bold: true,
      color: '#c00000',
      align: 'keep',
      fontSize: 'keep',
      keepStyle: true,
    });
  });

  it('builds editParagraph params with the new text and the style', () => {
    const p = editParagraphParams(0, 'P1', 'Nội dung mới', {
      fontStrategy: 'auto',
      style: { ...KEEP_STYLE, align: 'center' },
    });
    expect(p).toMatchObject({
      paragraphId: 'P1',
      newText: 'Nội dung mới',
      align: 'center',
      lineSpacing: 'keep',
      boxWidth: 'keep',
    });
    expect(p.fontName).toBeUndefined();
    expect(
      editParagraphParams(0, 'P1', 'x', {
        fontStrategy: 'replace',
        fontName: 'serif',
        style: KEEP_STYLE,
      }).fontName,
    ).toBe('serif');
  });

  it('allows apply when the text or the style changed', () => {
    expect(canApplyParagraph('a b', 'a b', KEEP_STYLE)).toBe(false);
    expect(canApplyParagraph('a b', 'a c', KEEP_STYLE)).toBe(true);
    expect(canApplyParagraph('a b', 'a b', { ...KEEP_STYLE, italic: true })).toBe(true);
  });
});

describe('warnings', () => {
  const blocks: TextBlock[] = [
    { id: 'B1', paragraphIds: ['P1'], bbox: [72, 96, 300, 122] },
    { id: 'B2', paragraphIds: ['P2'], bbox: [72, 200, 300, 212] },
  ];

  it('finds the overlapped blocks and the overflow', () => {
    const w = paragraphWarnings(
      { overflow: 12.5, overlapsBlockIds: ['B2'], warnings: ['Dòng dài'] },
      blocks,
    );
    expect(w.overflow).toBe(12.5);
    expect(w.overlapBlocks.map((b) => b.id)).toEqual(['B2']);
    expect(w.messages).toEqual(['Dòng dài']);
  });

  it('is empty when the result is clean', () => {
    const w = paragraphWarnings({ overflow: 0, overlapsBlockIds: [] }, blocks);
    expect(w).toEqual({ overflow: 0, overlapBlocks: [], messages: [] });
    expect(paragraphWarnings(undefined, blocks).overlapBlocks).toEqual([]);
  });

  it('highlights the boxes of the overlapped blocks on their page', () => {
    expect(overlapHighlights(2, [blocks[1]!])).toEqual([
      { pageIndex: 2, rect: [72, 200, 300, 212] },
    ]);
  });
});
