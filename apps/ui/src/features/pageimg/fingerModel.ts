/** Finger mask editing (T8.10): a 1-byte-per-pixel mask where 255 means "erase" (a finger) and 0
 * means "keep". The proposal from pageimg.proposeFingerMask is loaded into it, the brush paints or
 * removes erase areas, and the result goes to pageimg.removeFingers as a base64 PNG (mode mask). */

export const FINGER_BRUSH_MIN = 4;
export const FINGER_BRUSH_MAX = 120;
export const FINGER_BRUSH_DEFAULT = 24;

export interface FingerMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Parses the single page field (1-based, as the user types it). */
export function parseFingerPage(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const page = Number(trimmed);
  if (page < 1 || page > pageCount) return null;
  return page - 1;
}

export function emptyMask(width: number, height: number): FingerMask {
  return { width, height, data: new Uint8Array(width * height) };
}

/** Paints (value 255, erase) or clears (value 0, keep) a disc. Pixels outside the mask are ignored. */
export function stampDisc(
  mask: FingerMask,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 255,
) {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(mask.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(mask.height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) mask.data[y * mask.width + x] = value;
    }
  }
}

/** A brush stroke from one point to the next, stamped at a spacing of half the radius. */
export function strokeLine(
  mask: FingerMask,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  value: 0 | 255,
) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 2)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    stampDisc(mask, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, value);
  }
}

export function erasedPixels(mask: FingerMask): number {
  let count = 0;
  for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i] !== 0) count += 1;
  return count;
}

/** Reads a mask image as drawn on a canvas (RGBA bytes): a bright pixel means "erase". */
export function maskFromRgba(width: number, height: number, rgba: Uint8ClampedArray): FingerMask {
  const mask = emptyMask(width, height);
  for (let i = 0; i < width * height; i += 1) {
    mask.data[i] = rgba[i * 4]! > 127 ? 255 : 0;
  }
  return mask;
}

/** Red translucent overlay for the editor: erase areas are shown, keep areas are transparent. */
export function overlayRgba(mask: FingerMask): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i += 1) {
    if (mask.data[i] !== 0) {
      out[i * 4] = 255;
      out[i * 4 + 1] = 40;
      out[i * 4 + 2] = 40;
      out[i * 4 + 3] = 150;
    }
  }
  return out;
}

/** Grayscale RGBA bytes of the mask, for a canvas whose PNG the operation reads (white = erase). */
export function maskToGrayRgba(mask: FingerMask): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i += 1) {
    const v = mask.data[i]!;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function brushRadiusPx(sliderValue: number, mask: FingerMask): number {
  const clamped = Math.min(FINGER_BRUSH_MAX, Math.max(FINGER_BRUSH_MIN, sliderValue));
  // The slider is in units of 1/1000 of the page width, so the brush keeps its size on screen.
  return Math.max(1, Math.round((clamped / 1000) * mask.width));
}
