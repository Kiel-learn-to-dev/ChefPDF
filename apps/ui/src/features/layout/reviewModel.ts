export const TEXT_KINDS = [
  'heading',
  'paragraph',
  'header',
  'footer',
  'pageNumber',
  'footnote',
  'unknown',
] as const;
export type TextKind = (typeof TEXT_KINDS)[number];
export interface Block {
  kind: string;
  runs?: { text: string }[];
  bbox: number[];
  level?: number;
}
export interface Page {
  index: number;
  width: number;
  height: number;
  blocks: Block[];
}
export interface DocumentModel {
  pages: Page[];
}
export interface Change {
  pageIndex: number;
  blockIndex: number;
  kind: TextKind;
  level?: number;
  text?: string;
}

export function textOf(block: Block): string {
  return block.runs?.map((run) => run.text).join('') ?? '';
}
export function reviewedBlock(
  block: Block,
  changes: Change[],
  pageIndex: number,
  blockIndex: number,
) {
  const change = changes.find(
    (item) => item.pageIndex === pageIndex && item.blockIndex === blockIndex,
  );
  return {
    kind: change?.kind ?? block.kind,
    level: change?.level ?? block.level ?? 1,
    text: change?.text ?? textOf(block),
  };
}
export function regionStyle(
  page: Page,
  block: Block,
): { left: string; top: string; width: string; height: string } | null {
  const [x0, y0, x1, y1] = block.bbox;
  if (
    !page.width ||
    !page.height ||
    x0 === undefined ||
    y0 === undefined ||
    x1 === undefined ||
    y1 === undefined
  )
    return null;
  return {
    left: `${(100 * x0) / page.width}%`,
    top: `${(100 * y0) / page.height}%`,
    width: `${(100 * (x1 - x0)) / page.width}%`,
    height: `${(100 * (y1 - y0)) / page.height}%`,
  };
}
export function setChange(changes: Change[], change: Change): Change[] {
  return [
    ...changes.filter(
      (c) => c.pageIndex !== change.pageIndex || c.blockIndex !== change.blockIndex,
    ),
    change,
  ];
}
