/**
 * Coordinates of signature boxes (T3.12). Pure.
 *
 * Three frames are involved:
 * - user space: PDF points, origin bottom-left, UNROTATED page (what sign.* ops store in rect),
 * - displayed frame: points after /Rotate, origin bottom-left, y up (the core's frame for
 *   fixed / anchor placements, see core/chef_core/signing/anchors.py PageFrame),
 * - screen: CSS px at the current zoom, origin top-left of the page image.
 *
 * Assumptions (documented, see the report): the CropBox starts at (0, 0) of user space, so the
 * displayed size from DocumentInfo.pages is the full user size; the view rotation of the viewer is
 * 0 while a box is placed (the placement layer refuses to run otherwise).
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface Pt {
  x: number;
  y: number;
}

export interface Rect4 {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Page as DocumentInfo.pages reports it: size after rotation, /Rotate in degrees. */
export interface PageInfoLike {
  width: number;
  height: number;
  rotation: number;
}

/** Page geometry in both frames. `userW`/`userH` are the unrotated size. */
export interface PageGeom {
  /** Displayed width / height (points). */
  dispW: number;
  dispH: number;
  userW: number;
  userH: number;
  rotation: Rotation;
}

export const MM_TO_PT = 72 / 25.4;

export function normalizeRotation(value: number): Rotation {
  const r = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

export function pageGeom(page: PageInfoLike): PageGeom {
  const rotation = normalizeRotation(page.rotation);
  const swapped = rotation === 90 || rotation === 270;
  return {
    dispW: page.width,
    dispH: page.height,
    userW: swapped ? page.height : page.width,
    userH: swapped ? page.width : page.height,
    rotation,
  };
}

/** User space point -> displayed frame (y up). Same formulas as the core's PageFrame._to_display. */
export function userToDisplay(p: Pt, g: PageGeom): Pt {
  const { x: u, y: v } = p;
  switch (g.rotation) {
    case 90:
      return { x: v, y: g.userW - u };
    case 180:
      return { x: g.userW - u, y: g.userH - v };
    case 270:
      return { x: g.userH - v, y: u };
    default:
      return { x: u, y: v };
  }
}

/** Displayed frame (y up) -> user space point. Inverse of userToDisplay. */
export function displayToUser(p: Pt, g: PageGeom): Pt {
  const { x: dx, y: dy } = p;
  switch (g.rotation) {
    case 90:
      return { x: g.userW - dy, y: dx };
    case 180:
      return { x: g.userW - dx, y: g.userH - dy };
    case 270:
      return { x: dy, y: g.userH - dx };
    default:
      return { x: dx, y: dy };
  }
}

function normRect(a: Pt, b: Pt): Rect4 {
  return {
    x1: Math.min(a.x, b.x),
    y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x),
    y2: Math.max(a.y, b.y),
  };
}

/** A user space rect [x1,y1,x2,y2] -> the displayed-frame rect (normalised). */
export function rectUserToDisplay(r: readonly number[], g: PageGeom): Rect4 {
  return normRect(
    userToDisplay({ x: r[0]!, y: r[1]! }, g),
    userToDisplay({ x: r[2]!, y: r[3]! }, g),
  );
}

/** A displayed-frame rect -> user space [x1,y1,x2,y2] (normalised), as the core expects. */
export function rectDisplayToUser(r: Rect4, g: PageGeom): [number, number, number, number] {
  const a = displayToUser({ x: r.x1, y: r.y1 }, g);
  const b = displayToUser({ x: r.x2, y: r.y2 }, g);
  const n = normRect(a, b);
  return [round(n.x1), round(n.y1), round(n.x2), round(n.y2)];
}

/** Displayed frame point (y up, points) -> screen px (y down) with `scale` px per point. */
export function displayToScreen(p: Pt, g: PageGeom, scale: number): Pt {
  return { x: p.x * scale, y: (g.dispH - p.y) * scale };
}

/** Screen px (origin top-left of the page image) -> displayed frame point (y up, points). */
export function screenToDisplay(p: Pt, g: PageGeom, scale: number): Pt {
  return { x: p.x / scale, y: g.dispH - p.y / scale };
}

/** Screen box of a displayed-frame rect. */
export function displayRectToScreen(r: Rect4, g: PageGeom, scale: number): ScreenBox {
  const a = displayToScreen({ x: r.x1, y: r.y2 }, g, scale);
  const b = displayToScreen({ x: r.x2, y: r.y1 }, g, scale);
  return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** Screen box -> displayed frame rect (points). */
export function screenBoxToDisplayRect(box: ScreenBox, g: PageGeom, scale: number): Rect4 {
  const a = screenToDisplay({ x: box.left, y: box.top }, g, scale);
  const b = screenToDisplay({ x: box.left + box.width, y: box.top + box.height }, g, scale);
  return normRect(a, b);
}

/** A user space rect -> screen box (for drawing). */
export function userRectToScreen(r: readonly number[], g: PageGeom, scale: number): ScreenBox {
  return displayRectToScreen(rectUserToDisplay(r, g), g, scale);
}

/** A screen box -> user space rect (for the core). */
export function screenBoxToUserRect(
  box: ScreenBox,
  g: PageGeom,
  scale: number,
): [number, number, number, number] {
  return rectDisplayToUser(screenBoxToDisplayRect(box, g, scale), g);
}

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Fixed box at a corner of the DISPLAYED page (I27), in the displayed frame. Same rule as the
 * core's fixed placement: `margin` from both edges.
 */
export function fixedRectDisplayed(
  corner: Corner,
  width: number,
  height: number,
  margin: number,
  g: PageGeom,
): Rect4 {
  const left = corner.endsWith('left');
  const top = corner.startsWith('top');
  const x1 = left ? margin : g.dispW - margin - width;
  const y1 = top ? g.dispH - margin - height : margin;
  return { x1, y1, x2: x1 + width, y2: y1 + height };
}

/** Fixed box at a corner, as a user space rect. */
export function fixedRectUser(
  corner: Corner,
  width: number,
  height: number,
  margin: number,
  g: PageGeom,
): [number, number, number, number] {
  return rectDisplayToUser(fixedRectDisplayed(corner, width, height, margin, g), g);
}

/**
 * Keeps a screen box inside the page image (page size in px). A box larger than the page is
 * cut to the page size. Position is moved, not the size, unless the size does not fit.
 */
export function clampBoxToPage(box: ScreenBox, pageW: number, pageH: number): ScreenBox {
  const width = Math.min(box.width, pageW);
  const height = Math.min(box.height, pageH);
  const left = Math.min(Math.max(box.left, 0), pageW - width);
  const top = Math.min(Math.max(box.top, 0), pageH - height);
  return { left, top, width, height };
}

/** Size of a box in mm, from points (for the size readout). */
export function boxSizeMm(width: number, height: number, scale: number): { w: number; h: number } {
  return { w: round(width / scale / MM_TO_PT, 1), h: round(height / scale / MM_TO_PT, 1) };
}

/** Box size in points for a size in mm. */
export function mmToPt(mm: number): number {
  return mm * MM_TO_PT;
}

export function ptToMm(pt: number): number {
  return pt / MM_TO_PT;
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export { round as roundPt };
