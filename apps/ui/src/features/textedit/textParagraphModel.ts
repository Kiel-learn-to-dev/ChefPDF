/**
 * Pure model of the paragraph mode (D9, T7.03): the lines of a paragraph, its text for the editor
 * (lines joined by a space, the core re-flows them), the params of text.editParagraph and
 * text.styleParagraph, and the warnings of a paragraph change (overflow, blocks it overlaps).
 */
import type { TextEditParagraphParams, TextStyleParagraphParams } from '@chef/contracts';
import type { TextLine } from './textEditModel';

export interface TextBlock {
  id: string;
  paragraphIds: string[];
  /** [left, top, right, bottom], displayed points. */
  bbox: number[];
}

/** Lines of one paragraph, top to bottom then left to right. */
export function paragraphLines(lines: readonly TextLine[], paragraphId: string): TextLine[] {
  return lines
    .filter((l) => l.paragraphId === paragraphId && l.editable && !l.artifact)
    .slice()
    .sort((a, b) => a.bbox[1]! - b.bbox[1]! || a.bbox[0]! - b.bbox[0]!);
}

/** The text the editor shows: the lines in order, joined by a space (soft line breaks). */
export function paragraphText(lines: readonly TextLine[], paragraphId: string): string {
  return paragraphLines(lines, paragraphId)
    .map((l) => l.text.trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/** Union box of a paragraph's lines (points), or null when it has no lines. */
export function paragraphBox(lines: readonly TextLine[], paragraphId: string): number[] | null {
  const ls = paragraphLines(lines, paragraphId);
  if (ls.length === 0) return null;
  return [
    Math.min(...ls.map((l) => l.bbox[0]!)),
    Math.min(...ls.map((l) => l.bbox[1]!)),
    Math.max(...ls.map((l) => l.bbox[2]!)),
    Math.max(...ls.map((l) => l.bbox[3]!)),
  ];
}

export type ParaAlign = 'keep' | 'left' | 'center' | 'right' | 'justify';
export type Keep<T> = 'keep' | T;

/** A style change. Every field defaults to 'keep', so only the chosen fields change. */
export interface ParagraphStyle {
  align: Keep<'left' | 'center' | 'right' | 'justify'>;
  /** Pitch in points, or 'keep'. */
  lineSpacing: Keep<number>;
  fontSize: Keep<number>;
  color: Keep<string>;
  bold: Keep<boolean>;
  italic: Keep<boolean>;
}

export const KEEP_STYLE: ParagraphStyle = {
  align: 'keep',
  lineSpacing: 'keep',
  fontSize: 'keep',
  color: 'keep',
  bold: 'keep',
  italic: 'keep',
};

/** True when the style asks for at least one change. */
export function hasStyleChange(style: ParagraphStyle): boolean {
  return (Object.keys(KEEP_STYLE) as (keyof ParagraphStyle)[]).some((k) => style[k] !== 'keep');
}

export interface EditParagraphOpts {
  fontStrategy: 'auto' | 'keep' | 'replace';
  fontName?: string | null;
  /** Alignment, size and the other style fields are applied with the text. */
  style: ParagraphStyle;
  boxWidth?: Keep<number>;
}

/** text.editParagraph params: new text (soft wraps are re-flowed by the core). */
export function editParagraphParams(
  pageIndex: number,
  paragraphId: string,
  newText: string,
  opts: EditParagraphOpts,
): TextEditParagraphParams {
  const params: TextEditParagraphParams = {
    pageIndex,
    paragraphId,
    newText,
    fontStrategy: opts.fontStrategy,
    keepStyle: true,
    align: opts.style.align,
    lineSpacing: opts.style.lineSpacing,
    fontSize: opts.style.fontSize,
    color: opts.style.color,
    bold: opts.style.bold,
    italic: opts.style.italic,
    boxWidth: opts.boxWidth ?? 'keep',
  };
  if (opts.fontName) params.fontName = opts.fontName;
  return params;
}

/** text.styleParagraph params: the style only, the text is kept. */
export function styleParagraphParams(
  pageIndex: number,
  paragraphId: string,
  style: ParagraphStyle,
  fontStrategy: 'auto' | 'keep' | 'replace' = 'auto',
): TextStyleParagraphParams {
  return {
    pageIndex,
    paragraphId,
    fontStrategy,
    keepStyle: true,
    align: style.align,
    lineSpacing: style.lineSpacing,
    fontSize: style.fontSize,
    color: style.color,
    bold: style.bold,
    italic: style.italic,
    boxWidth: 'keep',
  };
}

/** The data of a finished paragraph op (the parts the UI reads). */
export interface ParagraphResultData {
  overflow?: number;
  overlapsBlockIds?: string[];
  fontFrom?: string | null;
  fontTo?: string | null;
  warnings?: string[];
}

export interface ParagraphWarnings {
  overflow: number;
  /** Blocks the new text runs into; their boxes are highlighted. */
  overlapBlocks: TextBlock[];
  /** Message lines for the toast. */
  messages: string[];
}

/** Warnings of a paragraph result: overflow past the next block or page bottom, overlapped blocks. */
export function paragraphWarnings(
  data: ParagraphResultData | undefined,
  blocks: readonly TextBlock[],
): ParagraphWarnings {
  const overflow = data?.overflow ?? 0;
  const ids = data?.overlapsBlockIds ?? [];
  const overlapBlocks = blocks.filter((b) => ids.includes(b.id));
  // The core's own warning sentences; overflow and overlap are rendered by the UI.
  const messages = [...(data?.warnings ?? [])];
  return { overflow, overlapBlocks, messages };
}

/** Highlight boxes of the overlapped blocks (page + rect), for the viewer. */
export function overlapHighlights(
  pageIndex: number,
  blocks: readonly TextBlock[],
): { pageIndex: number; rect: number[] }[] {
  return blocks.map((b) => ({ pageIndex, rect: b.bbox }));
}

/** The paragraph id of a line, or null when the line has none. */
export function paragraphOf(line: TextLine | null): string | null {
  return line?.paragraphId ?? null;
}

/** Apply is allowed when the text changed or a style was chosen. */
export function canApplyParagraph(original: string, text: string, style: ParagraphStyle): boolean {
  return text.trim() !== original.trim() || hasStyleChange(style);
}
