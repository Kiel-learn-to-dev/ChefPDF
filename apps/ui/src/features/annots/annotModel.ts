/**
 * Pure model of the annotations (G1-G5, T7.06-T7.07): the colours, the rects of a text selection,
 * the params of the annots.add* ops, ink smoothing, the list (grouping, filters, threads), and the
 * params of export and flatten. Coordinates are displayed points, origin top-left.
 */
import type {
  AnnotsAddFreeTextParams,
  AnnotsAddInkParams,
  AnnotsAddNoteParams,
  AnnotsAddShapeParams,
  AnnotsAddTextMarkupParams,
  AnnotsExportParams,
  AnnotsFlattenParams,
} from '@chef/contracts';

export const PALETTE = ['#FFE14D', '#8BE28B', '#7DD3FC', '#F9A8D4', '#FCA5A5', '#000000'] as const;

export type MarkupKind = 'highlight' | 'underline' | 'strike' | 'squiggly';
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';
export type NoteIcon =
  'Note' | 'Comment' | 'Key' | 'Help' | 'NewParagraph' | 'Paragraph' | 'Insert';

/** An annotation of annots.list. */
export interface AnnotItem {
  id: string;
  pageIndex: number;
  subtype: string;
  rect: number[];
  contents: string;
  author: string;
  modified: string | null;
  colour: string | null;
  opacity: number;
  replies: string[];
  inReplyTo: string | null;
  status: 'accepted' | 'rejected' | 'cancelled' | 'completed' | null;
  quads: number[][];
  icon: string | null;
  hidden?: boolean;
}

// -- selection -----------------------------------------------------------------------------------

export interface ClientRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PageSpot {
  index: number;
  /** Layer px of the page's top-left corner, its size in px, and px per point. */
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * The rects of a text selection, per page, in displayed points. A client rect belongs to the page
 * that holds its centre; rects outside every page are dropped; very thin or empty rects too.
 */
export function selectionRectsByPage(
  rects: readonly ClientRect[],
  pages: readonly PageSpot[],
  origin: { left: number; top: number },
): { pageIndex: number; rects: number[][] }[] {
  const byPage = new Map<number, number[][]>();
  for (const r of rects) {
    const cx = (r.left + r.right) / 2 - origin.left;
    const cy = (r.top + r.bottom) / 2 - origin.top;
    const page = pages.find(
      (p) => cx >= p.left && cx <= p.left + p.width && cy >= p.top && cy <= p.top + p.height,
    );
    if (!page) continue;
    const l = (r.left - origin.left - page.left) / page.scale;
    const t = (r.top - origin.top - page.top) / page.scale;
    const rr = (r.right - origin.left - page.left) / page.scale;
    const b = (r.bottom - origin.top - page.top) / page.scale;
    if (rr - l < 0.5 || b - t < 0.5) continue;
    const list = byPage.get(page.index) ?? [];
    list.push([round(l), round(t), round(rr), round(b)]);
    byPage.set(page.index, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, list]) => ({ pageIndex, rects: list }));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// -- params of the add ops -----------------------------------------------------------------------

export function textMarkupParams(
  pageIndex: number,
  kind: MarkupKind,
  rects: number[][],
  opts: { color: string; opacity: number; contents: string; author: string },
): AnnotsAddTextMarkupParams {
  return {
    pageIndex,
    kind,
    rects,
    color: opts.color,
    opacity: opts.opacity,
    contents: opts.contents,
    author: opts.author,
  };
}

export function noteParams(
  pageIndex: number,
  at: { x: number; y: number },
  contents: string,
  opts: { author: string; icon: NoteIcon; color: string },
): AnnotsAddNoteParams {
  return {
    pageIndex,
    left: round(at.x),
    top: round(at.y),
    contents,
    author: opts.author,
    icon: opts.icon,
    color: opts.color,
  };
}

export function freeTextParams(
  pageIndex: number,
  rect: number[],
  text: string,
  opts: { author: string; color: string; fontSize: number },
): AnnotsAddFreeTextParams {
  return { pageIndex, rect, text, author: opts.author, color: opts.color, fontSize: opts.fontSize };
}

/** A drag from a to b: a line or an arrow takes the two points, a rect or an ellipse the box. */
export function shapeParams(
  pageIndex: number,
  kind: ShapeKind,
  a: { x: number; y: number },
  b: { x: number; y: number },
  opts: { author: string; color: string; width: number; fill?: string },
): AnnotsAddShapeParams {
  const base = { pageIndex, kind, color: opts.color, width: opts.width, author: opts.author };
  const fill = opts.fill ? { fill: opts.fill } : {};
  if (kind === 'line' || kind === 'arrow') {
    return { ...base, points: [round(a.x), round(a.y), round(b.x), round(b.y)] };
  }
  return {
    ...base,
    ...fill,
    rect: [
      round(Math.min(a.x, b.x)),
      round(Math.min(a.y, b.y)),
      round(Math.max(a.x, b.x)),
      round(Math.max(a.y, b.y)),
    ],
  };
}

/** Ink: strokes of points, each smoothed and rounded to 0.1 pt. Strokes of one point are dropped. */
export function inkParams(
  pageIndex: number,
  strokes: readonly (readonly { x: number; y: number }[])[],
  opts: { author: string; color: string; width: number },
): AnnotsAddInkParams | null {
  const out = strokes
    .map((s) => simplify(s, 0.6))
    .filter((s) => s.length >= 2)
    .map((s) => s.map((p) => [round(p.x), round(p.y)]));
  if (out.length === 0) return null;
  return {
    pageIndex,
    strokes: out,
    color: opts.color,
    width: opts.width,
    author: opts.author,
    opacity: 1,
  };
}

/** Ramer-Douglas-Peucker: drops the points that do not change the stroke by more than tol points. */
export function simplify(
  points: readonly { x: number; y: number }[],
  tol: number,
): { x: number; y: number }[] {
  if (points.length <= 2) return points.slice();
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i]!, first, last);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [first, last];
  const left = simplify(points.slice(0, idx + 1), tol);
  const right = simplify(points.slice(idx), tol);
  return [...left.slice(0, -1), ...right];
}

function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// -- list ----------------------------------------------------------------------------------------

export interface AnnotFilter {
  /** Subtypes to show; empty = all. */
  kinds: string[];
  author: string;
  status: 'all' | 'none' | 'accepted' | 'rejected' | 'cancelled' | 'completed';
  query: string;
}

export const EMPTY_FILTER: AnnotFilter = { kinds: [], author: '', status: 'all', query: '' };

/** Replies are shown under their parent, so they are not listed on their own. */
export function isTopLevel(item: AnnotItem): boolean {
  return item.inReplyTo === null;
}

export function filterAnnots(items: readonly AnnotItem[], f: AnnotFilter): AnnotItem[] {
  const author = f.author.trim().toLowerCase();
  const query = f.query.trim().toLowerCase();
  return items.filter((it) => {
    if (f.kinds.length > 0 && !f.kinds.includes(it.subtype)) return false;
    if (author && !it.author.toLowerCase().includes(author)) return false;
    if (f.status === 'none' && it.status !== null) return false;
    if (f.status !== 'all' && f.status !== 'none' && it.status !== f.status) return false;
    if (query) {
      const hay = `${it.contents} ${it.author} ${it.subtype}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

/** Top-level annotations grouped by page, in page order; each group is in document order. */
export function groupAnnotsByPage(
  items: readonly AnnotItem[],
): { pageIndex: number; items: AnnotItem[] }[] {
  const byPage = new Map<number, AnnotItem[]>();
  for (const it of items.filter(isTopLevel)) {
    const list = byPage.get(it.pageIndex) ?? [];
    list.push(it);
    byPage.set(it.pageIndex, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, list]) => ({ pageIndex, items: list }));
}

/** A thread: the annotation and its replies (in the order of the list), by id. */
export interface Thread {
  root: AnnotItem;
  replies: AnnotItem[];
}

export function buildThread(items: readonly AnnotItem[], rootId: string): Thread | null {
  const byId = new Map(items.map((it) => [it.id, it]));
  const root = byId.get(rootId);
  if (!root) return null;
  const replies = items.filter((it) => it.inReplyTo === rootId);
  return { root, replies };
}

/** Text shown for a highlight: the text it marks (kept in /Contents when it was added). */
export function quotedText(item: AnnotItem): string {
  return item.subtype === 'Highlight' ||
    item.subtype === 'Underline' ||
    item.subtype === 'StrikeOut' ||
    item.subtype === 'Squiggly'
    ? item.contents
    : '';
}

export const SUBTYPE_KEYS: Record<string, string> = {
  Highlight: 'annots.kind.highlight',
  Underline: 'annots.kind.underline',
  StrikeOut: 'annots.kind.strike',
  Squiggly: 'annots.kind.squiggly',
  Text: 'annots.kind.note',
  FreeText: 'annots.kind.freeText',
  Ink: 'annots.kind.ink',
  Line: 'annots.kind.line',
  Square: 'annots.kind.rect',
  Circle: 'annots.kind.ellipse',
};

// -- export and flatten --------------------------------------------------------------------------

export type ExportFormat = NonNullable<AnnotsExportParams['format']>;
export const EXPORT_FORMATS: readonly ExportFormat[] = ['txt', 'md', 'html', 'csv', 'xlsx', 'json'];

export function exportParams(
  outputPath: string,
  format: ExportFormat,
  pages: number[] | undefined,
  kinds: string[] | undefined,
): AnnotsExportParams {
  const p: AnnotsExportParams = { outputPath, format };
  if (pages && pages.length > 0) p.pages = [...new Set(pages)].sort((a, b) => a - b);
  if (kinds && kinds.length > 0) p.kinds = kinds;
  return p;
}

export function flattenParams(
  pages: number[] | undefined,
  kinds: string[] | undefined,
  keep: { links: boolean; formFields: boolean },
): AnnotsFlattenParams {
  const p: AnnotsFlattenParams = { keepLinks: keep.links, keepFormFields: keep.formFields };
  if (pages && pages.length > 0) p.pages = [...new Set(pages)].sort((a, b) => a - b);
  if (kinds && kinds.length > 0) p.kinds = kinds;
  return p;
}

/** Subtypes present in the list, sorted: the choices of the kind filter. */
export function kindsOf(items: readonly AnnotItem[]): string[] {
  return [...new Set(items.map((it) => it.subtype))].sort();
}
