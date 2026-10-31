export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

function area(r: Rect) {
  return (r.right - r.left) * (r.bottom - r.top);
}

/**
 * Copy the part of the rendered page canvases under `rect` (client coordinates)
 * into a PNG data URL. Uses the page with the largest overlap.
 */
export function captureRegion(container: HTMLElement, rect: Rect): string | null {
  let best: { canvas: HTMLCanvasElement; hit: Rect; box: DOMRect } | null = null;
  for (const canvas of container.querySelectorAll<HTMLCanvasElement>('.page canvas')) {
    const box = canvas.getBoundingClientRect();
    const hit = intersect(rect, box);
    if (hit && (!best || area(hit) > area(best.hit))) best = { canvas, hit, box };
  }
  if (!best) return null;
  const { canvas, hit, box } = best;
  const sx = canvas.width / box.width;
  const sy = canvas.height / box.height;
  const w = Math.max(1, Math.round((hit.right - hit.left) * sx));
  const h = Math.max(1, Math.round((hit.bottom - hit.top) * sy));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, (hit.left - box.left) * sx, (hit.top - box.top) * sy, w, h, 0, 0, w, h);
  return out.toDataURL('image/png');
}
