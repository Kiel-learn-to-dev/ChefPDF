/**
 * Drawing, moving and resizing a signature box on a page image (T3.12). Pure: works in screen px
 * of one page (origin top-left, page size in px). Snapping: the box never leaves the page.
 */
import { clampBoxToPage, type ScreenBox } from './placementGeometry';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface PageSizePx {
  width: number;
  height: number;
}

/** Smallest box the user can draw, in px (about 4 mm at 100%). */
export const MIN_BOX_PX = 12;

/** Box from a drag: the two corners, normalised and clamped to the page. */
export function boxFromDrag(
  start: { x: number; y: number },
  current: { x: number; y: number },
  page: PageSizePx,
  aspect: number | null,
): ScreenBox {
  const sx = clampX(start.x, page.width);
  const sy = clampY(start.y, page.height);
  const cx = clampX(current.x, page.width);
  const cy = clampY(current.y, page.height);
  let width = Math.abs(cx - sx);
  let height = Math.abs(cy - sy);
  if (aspect) {
    // Keep the aspect of the first drag: the larger side decides.
    if (width / Math.max(height, 1e-9) > aspect) height = width / aspect;
    else width = height * aspect;
  }
  const left = cx >= sx ? sx : sx - width;
  const top = cy >= sy ? sy : sy - height;
  return clampBoxToPage({ left, top, width, height }, page.width, page.height);
}

function clampX(x: number, w: number) {
  return Math.min(Math.max(x, 0), w);
}
function clampY(y: number, h: number) {
  return Math.min(Math.max(y, 0), h);
}

/** Moves a box by (dx, dy) and keeps it on the page. */
export function moveBox(box: ScreenBox, dx: number, dy: number, page: PageSizePx): ScreenBox {
  return clampBoxToPage(
    { ...box, left: box.left + dx, top: box.top + dy },
    page.width,
    page.height,
  );
}

/**
 * Resizes a box by dragging one handle. The opposite edge stays fixed. With `aspect` (width /
 * height) the box keeps its shape. Sizes never go below MIN_BOX_PX or outside the page.
 */
export function resizeBox(
  box: ScreenBox,
  handle: Handle,
  dx: number,
  dy: number,
  page: PageSizePx,
  aspect: number | null = null,
): ScreenBox {
  let left = box.left;
  let top = box.top;
  let right = box.left + box.width;
  let bottom = box.top + box.height;
  if (handle.includes('w')) left = clampX(left + dx, page.width);
  if (handle.includes('e')) right = clampX(right + dx, page.width);
  if (handle.includes('n')) top = clampY(top + dy, page.height);
  if (handle.includes('s')) bottom = clampY(bottom + dy, page.height);
  let width = Math.max(right - left, MIN_BOX_PX);
  let height = Math.max(bottom - top, MIN_BOX_PX);
  if (aspect) {
    const corner = handle.length === 2;
    if (corner) {
      if (width / height > aspect) height = width / aspect;
      else width = height * aspect;
    } else if (handle === 'e' || handle === 'w') height = width / aspect;
    else width = height * aspect;
  }
  // The fixed edge decides the position.
  const newLeft = handle.includes('w') ? box.left + box.width - width : box.left;
  const newTop = handle.includes('n') ? box.top + box.height - height : box.top;
  return clampBoxToPage({ left: newLeft, top: newTop, width, height }, page.width, page.height);
}

/** Keeps a box's shape but fits it into the page (used when the page size changes). */
export function fitBox(box: ScreenBox, page: PageSizePx): ScreenBox {
  return clampBoxToPage(box, page.width, page.height);
}

/** The eight handle positions of a box, as centre points (for hit testing and drawing). */
export function handlePoints(box: ScreenBox): { handle: Handle; x: number; y: number }[] {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const r = box.left + box.width;
  const b = box.top + box.height;
  return [
    { handle: 'nw', x: box.left, y: box.top },
    { handle: 'n', x: cx, y: box.top },
    { handle: 'ne', x: r, y: box.top },
    { handle: 'e', x: r, y: cy },
    { handle: 'se', x: r, y: b },
    { handle: 's', x: cx, y: b },
    { handle: 'sw', x: box.left, y: b },
    { handle: 'w', x: box.left, y: cy },
  ];
}
