/**
 * Object editing on a page (D4, T6.02). Pure: the object list of the core (content.listObjects),
 * hit testing with z-order, selection, pixel <-> point conversion and the parameters of the
 * content.* operations. No React here.
 *
 * Coordinates: the core reports `bbox` as [x0, y0, x1, y1] in POINTS of the DISPLAYED page with the
 * origin at the top-left (y downwards). The viewer draws pages with `scale` px per point, so a
 * point (x, y) lies at (x * scale, y * scale) inside the page image. The conversion goes through
 * placementGeometry (the single place that maps frames), with rotation 0 only: while the view is
 * rotated the layer refuses to edit.
 */
import type {
  ContentAdjustImageParams,
  ContentDeleteParams,
  ContentDuplicateParams,
  ContentEraseRegionParams,
  ContentExtractImageParams,
  ContentMoveParams,
  ContentReorderParams,
  ContentReplaceImageParams,
  ContentSetColorParams,
  ContentSetOpacityParams,
  CropBox,
} from '@chef/contracts';
import {
  displayRectToScreen,
  pageGeom,
  screenBoxToDisplayRect,
  type Rect4,
  type ScreenBox,
} from '../sign/placementGeometry';

export type ObjectKind = 'text' | 'image' | 'path' | 'shading' | 'form';
export const OBJECT_KINDS: readonly ObjectKind[] = ['text', 'image', 'path', 'shading', 'form'];

/** One object of content.listObjects (fields the UI reads; the core sends more). */
export interface PageObject {
  id: string;
  pageIndex: number;
  kind: ObjectKind;
  ordinal: number;
  parentId: string | null;
  editable: boolean;
  /** [x0, y0, x1, y1], points, displayed frame, origin top-left. */
  bbox: [number, number, number, number];
  layer: string | null;
  clipped: boolean;
  /** [fill alpha, stroke alpha] from the graphics state. */
  opacity: [number, number];
  fillColor?: string | null;
  strokeColor?: string | null;
  string?: string;
  font?: string;
  fontSize?: number;
  pixelSize?: [number, number] | null;
  imageName?: string | null;
  inline?: boolean;
  smask?: boolean;
  invisible?: boolean;
}

/** Result data of content.listObjects. */
export interface ListObjectsData {
  pageIndex: number;
  digest: string;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  objects: PageObject[];
}

/** Result data of content.viewByType (per kind: count, boxes and ids). */
export interface KindSummary {
  count: number;
  bboxes: [number, number, number, number][];
  ids: string[];
}
export interface ViewByTypeData {
  pageIndex: number;
  displayWidth: number;
  displayHeight: number;
  kinds: Partial<Record<ObjectKind, KindSummary>>;
}

/** A page as drawn in the viewer: its box inside the layer and the px per point. */
export interface PageBox {
  index: number;
  /** Position of the page image inside the layer (px). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** px per point. */
  scale: number;
  dispW: number;
  dispH: number;
}

export const NUDGE_PT = 1;
export const NUDGE_BIG_PT = 10;
/** Duplicates are placed this far from the original, so the copy is visible. */
export const DUPLICATE_OFFSET_PT = 10;
/** Boxes match within this tolerance when the selection is remapped after an edit. */
const MATCH_TOLERANCE_PT = 0.6;

const round = (n: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

// ---------- geometry ----------

/** Displayed frame (points, origin top-left) -> the Rect4 of placementGeometry (y up). */
function topLeftToRect4(bbox: readonly number[], dispH: number): Rect4 {
  const [x0, y0, x1, y1] = bbox as [number, number, number, number];
  return { x1: x0, y1: dispH - y1, x2: x1, y2: dispH - y0 };
}

/** The screen box (px, relative to the page image) of a bbox in points. */
export function bboxToPageBox(
  bbox: readonly number[],
  page: Pick<PageBox, 'dispW' | 'dispH' | 'scale'>,
): ScreenBox {
  const g = pageGeom({ width: page.dispW, height: page.dispH, rotation: 0 });
  return displayRectToScreen(topLeftToRect4(bbox, page.dispH), g, page.scale);
}

/** A screen box (px relative to the page image) -> bbox in points, top-left origin. */
export function pageBoxToBbox(
  box: ScreenBox,
  page: Pick<PageBox, 'dispW' | 'dispH' | 'scale'>,
): [number, number, number, number] {
  const g = pageGeom({ width: page.dispW, height: page.dispH, rotation: 0 });
  const r = screenBoxToDisplayRect(box, g, page.scale);
  return [
    round(r.x1),
    round(dispToTop(r.y2, page.dispH)),
    round(r.x2),
    round(dispToTop(r.y1, page.dispH)),
  ];
}

function dispToTop(y: number, dispH: number): number {
  return dispH - y;
}

/** Pixel delta in the layer -> point delta (displayed frame, y downwards). */
export function pxDeltaToPt(dx: number, dy: number, scale: number): { dx: number; dy: number } {
  return { dx: round(dx / scale), dy: round(dy / scale) };
}

// ---------- hit testing and selection ----------

const EPS = 0.01;

export function bboxContains(bbox: readonly number[], x: number, y: number): boolean {
  return x >= bbox[0]! - EPS && x <= bbox[2]! + EPS && y >= bbox[1]! - EPS && y <= bbox[3]! + EPS;
}

/** Objects under a point (pt, top-left origin), topmost first (highest paint order first). */
export function hitObjects(objects: readonly PageObject[], x: number, y: number): PageObject[] {
  return objects.filter((o) => bboxContains(o.bbox, x, y)).sort((a, b) => b.ordinal - a.ordinal);
}

/**
 * Pick one of the hits. A plain click takes the topmost. A cycling click (Alt) takes the hit below
 * `previousId` (wrapping around), so overlapped objects can be reached one by one.
 */
export function pickHit(
  hits: readonly PageObject[],
  previousId: string | null,
  cycle: boolean,
): PageObject | null {
  if (hits.length === 0) return null;
  if (!cycle || previousId === null) return hits[0]!;
  const i = hits.findIndex((o) => o.id === previousId);
  if (i < 0) return hits[0]!;
  return hits[(i + 1) % hits.length]!;
}

/** Objects lying completely inside a rectangle (pt, top-left origin). Rubber-band selection. */
export function objectsInRect(
  objects: readonly PageObject[],
  rect: readonly [number, number, number, number],
): PageObject[] {
  const [x0, y0, x1, y1] = rect;
  return objects.filter((o) => {
    const [a, b, c, d] = o.bbox;
    return a >= x0 - EPS && b >= y0 - EPS && c <= x1 + EPS && d <= y1 + EPS;
  });
}

export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

export function addIds(selected: readonly string[], ids: readonly string[]): string[] {
  const out = [...selected];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Range selection on one page: the objects between `anchorId` and `targetId` in paint order.
 * Returns the ids of the range (both ends included); if the anchor is not on that page, only the
 * target.
 */
export function rangeIds(
  pageObjects: readonly PageObject[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const sorted = [...pageObjects].sort((a, b) => a.ordinal - b.ordinal);
  const t = sorted.findIndex((o) => o.id === targetId);
  if (t < 0) return [];
  const a = anchorId ? sorted.findIndex((o) => o.id === anchorId) : -1;
  if (a < 0) return [targetId];
  const [lo, hi] = a <= t ? [a, t] : [t, a];
  return sorted.slice(lo, hi + 1).map((o) => o.id);
}

/** Keeps only the selected ids that still exist in `objects`. */
export function pruneSelection(
  selected: readonly string[],
  objects: readonly PageObject[],
): string[] {
  const live = new Set(objects.map((o) => o.id));
  return selected.filter((id) => live.has(id));
}

/**
 * After an edit the ids change (they carry the revision digest). Each selected object is found
 * again in the new list: same page, same kind, same text, and a bbox equal to the old one moved by
 * `delta` (points). Objects with no match are dropped.
 */
export function remapSelection(
  previous: readonly PageObject[],
  next: readonly PageObject[],
  delta: { dx: number; dy: number },
): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const old of previous) {
    const want = [
      old.bbox[0] + delta.dx,
      old.bbox[1] + delta.dy,
      old.bbox[2] + delta.dx,
      old.bbox[3] + delta.dy,
    ];
    let best: PageObject | null = null;
    let bestDist = Infinity;
    for (const cand of next) {
      if (used.has(cand.id) || cand.pageIndex !== old.pageIndex || cand.kind !== old.kind) continue;
      if (old.kind === 'text' && cand.string !== old.string) continue;
      const dist = Math.max(...cand.bbox.map((v, i) => Math.abs(v - want[i]!)));
      if (dist <= MATCH_TOLERANCE_PT && dist < bestDist) {
        best = cand;
        bestDist = dist;
      }
    }
    if (best) {
      used.add(best.id);
      out.push(best.id);
    }
  }
  return out;
}

/** Pages of a list of ids (the ids carry the page index), sorted and unique. */
export function pagesOfIds(ids: readonly string[]): number[] {
  const pages = new Set<number>();
  for (const id of ids) {
    const m = /^p(\d+):/.exec(id);
    if (m) pages.add(Number(m[1]));
  }
  return [...pages].sort((a, b) => a - b);
}

// ---------- keyboard ----------

/** Displacement in points for an arrow key (Shift = 10 pt). Null for other keys. */
export function nudgeFor(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? NUDGE_BIG_PT : NUDGE_PT;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

/** A move is worth an operation only when it displaces by at least 0.01 pt. */
export function isMeaningfulMove(dx: number, dy: number): boolean {
  return Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01;
}

// ---------- operation parameters ----------

export function moveParams(ids: string[], dx: number, dy: number): ContentMoveParams {
  return { ids: [...ids], dx: round(dx), dy: round(dy) };
}

export function deleteParams(ids: string[]): ContentDeleteParams {
  return { ids: [...ids] };
}

export function duplicateParams(
  ids: string[],
  dx = DUPLICATE_OFFSET_PT,
  dy = DUPLICATE_OFFSET_PT,
): ContentDuplicateParams {
  return { ids: [...ids], dx, dy };
}

export function reorderParams(
  ids: string[],
  mode: ContentReorderParams['mode'],
): ContentReorderParams {
  return { ids: [...ids], mode };
}

/** Colour params: only the channels that are given ('#rrggbb'). Null when neither is set. */
export function colorParams(
  ids: string[],
  colours: { fill?: string; stroke?: string },
): ContentSetColorParams | null {
  const out: ContentSetColorParams = { ids: [...ids] };
  if (colours.fill) out.fill = colours.fill;
  if (colours.stroke) out.stroke = colours.stroke;
  return out.fill || out.stroke ? out : null;
}

export function opacityParams(ids: string[], opacity: number): ContentSetOpacityParams {
  return { ids: [...ids], opacity: Math.min(1, Math.max(0, round(opacity, 2))) };
}

export type ImageFit = 'stretch' | 'contain' | 'cover';

export function replaceImageParams(
  pageIndex: number,
  objectId: string,
  path: string,
  fit: ImageFit,
): ContentReplaceImageParams {
  return { pageIndex, objectId, path, fit, keepAspectBox: fit !== 'stretch' };
}

export interface ImageAdjust {
  crop?: CropBox;
  rotate: 0 | 90 | 180 | 270;
  flip: 'none' | 'h' | 'v';
  grayscale: boolean;
  invert: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
}

export const DEFAULT_ADJUST: ImageAdjust = {
  rotate: 0,
  flip: 'none',
  grayscale: false,
  invert: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  gamma: 1,
};

/** True when the adjustment changes nothing (the button is then disabled). */
export function isIdentityAdjust(a: ImageAdjust): boolean {
  return (
    !a.crop &&
    a.rotate === 0 &&
    a.flip === 'none' &&
    !a.grayscale &&
    !a.invert &&
    a.brightness === 0 &&
    a.contrast === 0 &&
    a.saturation === 0 &&
    a.gamma === 1
  );
}

export function adjustImageParams(
  pageIndex: number,
  objectId: string,
  a: ImageAdjust,
): ContentAdjustImageParams {
  const out: ContentAdjustImageParams = {
    pageIndex,
    objectId,
    rotate: a.rotate,
    flip: a.flip,
    grayscale: a.grayscale,
    invert: a.invert,
    brightness: clampInt(a.brightness, -100, 100),
    contrast: clampInt(a.contrast, -100, 100),
    saturation: clampInt(a.saturation, -100, 100),
    gamma: Math.min(5, Math.max(0.1, round(a.gamma, 2))),
  };
  if (a.crop) out.crop = { ...a.crop };
  return out;
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function extractImageParams(
  pageIndex: number,
  objectId: string,
  outputPath: string,
): ContentExtractImageParams {
  return { pageIndex, objectId, outputPath };
}

export interface EraseOptions {
  mode: 'cut' | 'cover';
  /** 'auto' or '#rrggbb' (cover only). */
  color: string;
  includeText: boolean;
  includeImages: boolean;
  includeVectors: boolean;
  partial: boolean;
  imageFill: 'transparent' | 'white' | 'auto';
}

export const DEFAULT_ERASE: EraseOptions = {
  mode: 'cut',
  color: 'auto',
  includeText: true,
  includeImages: true,
  includeVectors: true,
  partial: true,
  imageFill: 'transparent',
};

/** A rect in points (displayed frame, origin top-left) from two corners, normalised. */
export function normRectPt(
  a: { x: number; y: number },
  b: { x: number; y: number },
): [number, number, number, number] {
  return [
    round(Math.min(a.x, b.x)),
    round(Math.min(a.y, b.y)),
    round(Math.max(a.x, b.x)),
    round(Math.max(a.y, b.y)),
  ];
}

export function eraseRegionParams(
  pageIndex: number,
  rect: [number, number, number, number],
  o: EraseOptions,
): ContentEraseRegionParams {
  const out: ContentEraseRegionParams = {
    pageIndex,
    rect: [...rect],
    mode: o.mode,
    includeText: o.includeText,
    includeImages: o.includeImages,
    includeVectors: o.includeVectors,
    partial: o.partial,
    imageFill: o.imageFill,
  };
  if (o.mode === 'cover') out.color = o.color;
  return out;
}

/** Counts of an erase result, as the core reports them (data of content.eraseRegion). */
export interface EraseCounts {
  removedObjects: number;
  splitObjects: number;
  modifiedImages: number;
  clippedObjects: number;
  covered: number;
  skipped: string[];
}

/** Nothing removed, changed or covered: the region held no matching object. */
export function eraseChangedNothing(c: EraseCounts): boolean {
  return (
    c.removedObjects === 0 &&
    c.splitObjects === 0 &&
    c.modifiedImages === 0 &&
    c.clippedObjects === 0 &&
    c.covered === 0
  );
}

/** Millimetres for a point value, one decimal (the properties panel). */
export function ptToMmText(pt: number): string {
  return (Math.round((pt / (72 / 25.4)) * 10) / 10).toLocaleString('vi-VN');
}

/** Width and height of a bbox in points. */
export function bboxSize(bbox: readonly number[]): { w: number; h: number } {
  return { w: (bbox[2] ?? 0) - (bbox[0] ?? 0), h: (bbox[3] ?? 0) - (bbox[1] ?? 0) };
}
