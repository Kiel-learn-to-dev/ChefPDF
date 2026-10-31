/**
 * Signature and stamp library model (I19-I23). Pure: option defaults, clamping and the parameter
 * objects of the image ops. The ranges mirror the core's parameter descriptions.
 */
import type {
  ImageCleanupParams,
  ImageFromStrokesParams,
  ImageRemoveBackgroundParams,
  ImageTextSignatureParams,
  LibraryKind,
  StrokeParams,
} from '@chef/contracts';

export const KINDS: readonly LibraryKind[] = ['signature', 'stamp', 'initials', 'logo'];
export const NAME_MAX = 80;

export function clampTo(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export type RemoveMode = 'auto' | 'ink-color' | 'paper-white';

export interface BackgroundOptions {
  mode: RemoveMode;
  /** Colour distance for ink-color (0-200). */
  tolerance: number;
  /** paper-white: higher keeps fainter ink (0-100). */
  sensitivity: number;
  /** Soft edge in pixels (0-5). */
  feather: number;
}

export const DEFAULT_BACKGROUND: BackgroundOptions = {
  mode: 'auto',
  tolerance: 60,
  sensitivity: 50,
  feather: 1,
};

export interface CleanupOptions {
  /** Ink blobs smaller than this are removed (0 = off, 0-200). */
  minBlobPx: number;
  straighten: boolean;
  /** Grow (+) or thin (-) the strokes (-5 to 5). */
  thicken: number;
  /** 0.2-3. */
  contrast: number;
  /** Largest side in pixels (0 = keep). */
  maxSide: number;
}

/** Resize choices of the clean-up step: 0 keeps the size. */
export const CLEANUP_STEPS = [0, 400, 800, 1600] as const;

export const DEFAULT_CLEANUP: CleanupOptions = {
  minBlobPx: 0,
  straighten: false,
  thicken: 0,
  contrast: 1,
  maxSide: 0,
};

export function normalizeBackground(o: Partial<BackgroundOptions>): BackgroundOptions {
  const mode: RemoveMode = o.mode === 'ink-color' || o.mode === 'paper-white' ? o.mode : 'auto';
  return {
    mode,
    tolerance: Math.round(clampTo(o.tolerance ?? DEFAULT_BACKGROUND.tolerance, 0, 200)),
    sensitivity: Math.round(clampTo(o.sensitivity ?? DEFAULT_BACKGROUND.sensitivity, 0, 100)),
    feather: +clampTo(o.feather ?? DEFAULT_BACKGROUND.feather, 0, 5).toFixed(2),
  };
}

export function normalizeCleanup(o: Partial<CleanupOptions>): CleanupOptions {
  return {
    minBlobPx: Math.round(clampTo(o.minBlobPx ?? 0, 0, 200)),
    straighten: o.straighten === true,
    thicken: Math.round(clampTo(o.thicken ?? 0, -5, 5)),
    contrast: +clampTo(o.contrast ?? 1, 0.2, 3).toFixed(2),
    maxSide: (CLEANUP_STEPS as readonly number[]).includes(o.maxSide ?? 0) ? (o.maxSide ?? 0) : 0,
  };
}

/** Parameters of image.removeBackground (I20). */
export function removeBackgroundParams(
  o: BackgroundOptions,
  inputPath: string,
  outputPath: string,
): ImageRemoveBackgroundParams {
  const n = normalizeBackground(o);
  return {
    inputPath,
    outputPath,
    mode: n.mode,
    tolerance: n.tolerance,
    sensitivity: n.sensitivity,
    feather: n.feather,
  };
}

/** Parameters of image.cleanup (I21). The size limit is a square bound on the longest side. */
export function cleanupParams(
  o: CleanupOptions,
  inputPath: string,
  outputPath: string,
): ImageCleanupParams {
  const n = normalizeCleanup(o);
  const params: ImageCleanupParams = {
    inputPath,
    outputPath,
    minBlobPx: n.minBlobPx,
    straighten: n.straighten,
    thicken: n.thicken,
    contrast: n.contrast,
  };
  if (n.maxSide > 0) {
    params.maxWidth = n.maxSide;
    params.maxHeight = n.maxSide;
  }
  return params;
}

export interface TypedOptions {
  text: string;
  /** Bundled font, or a font file the user chose. */
  font: { kind: 'bundled' } | { kind: 'file'; path: string };
  sizePx: number;
  colorHex: string;
  slantDeg: number;
}

export const DEFAULT_TYPED: TypedOptions = {
  text: '',
  font: { kind: 'bundled' },
  sizePx: 96,
  colorHex: '#1F3A93',
  slantDeg: 0,
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Parameters of image.textSignature (I19). Empty text is refused by the caller. */
export function textSignatureParams(o: TypedOptions, outputPath: string): ImageTextSignatureParams {
  const params: ImageTextSignatureParams = {
    text: o.text.trim().slice(0, NAME_MAX),
    fontName: o.font.kind === 'bundled' ? 'BeVietnamPro' : null,
    sizePx: Math.round(clampTo(o.sizePx, 16, 400)),
    colorHex: HEX.test(o.colorHex) ? o.colorHex.toUpperCase() : '#1F3A93',
    slantDeg: +clampTo(o.slantDeg, -45, 45).toFixed(1),
    outputPath,
  };
  if (o.font.kind === 'file') params.fontPath = o.font.path;
  return params;
}

export const TYPED_FONT_EXTENSIONS = ['ttf', 'otf'];

// -- strokes (I19: drawn signatures) ---------------------------------------------------------

export interface RawPoint {
  x: number;
  y: number;
  /** ms since the stroke started. */
  t: number;
  /** PointerEvent.pressure (0-1) and pointer type ('pen' | 'mouse' | 'touch'). */
  pressure: number;
  pointerType: string;
}

/**
 * Pressure of one point, 0 = lightest, 1 = heaviest. A pen reports its own pressure. A mouse (no
 * pressure) gets a value from the speed: slow strokes are heavier, fast ones thinner, within
 * 0.5-1.0 (the rule of the drawing pad).
 */
export function pressureFor(point: RawPoint, prev: RawPoint | null): number {
  if (point.pointerType === 'pen' && point.pressure > 0) return clampTo(point.pressure, 0.05, 1);
  if (!prev) return 0.8;
  const dt = Math.max(1, point.t - prev.t);
  const speed = Math.hypot(point.x - prev.x, point.y - prev.y) / dt; // px per ms
  return +clampTo(1 - speed * 0.4, 0.5, 1).toFixed(3);
}

/** Converts recorded strokes to the core's StrokeParams (points in canvas units). */
export function strokesToParams(strokes: RawPoint[][]): StrokeParams[] {
  return strokes
    .filter((s) => s.length > 0)
    .map((s) => {
      let prev: RawPoint | null = null;
      return {
        points: s.map((p) => {
          const pressure = pressureFor(p, prev);
          prev = p;
          return {
            x: +p.x.toFixed(2),
            y: +p.y.toFixed(2),
            pressure: +pressure.toFixed(3),
            t: Math.round(p.t),
          };
        }),
      };
    });
}

export function fromStrokesParams(
  strokes: RawPoint[][],
  canvas: { width: number; height: number },
  outputPath: string,
): ImageFromStrokesParams {
  return {
    strokes: strokesToParams(strokes),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    colorHex: '#1F3A93',
    outputPath,
  };
}

/** Name for a new library item: trimmed, bounded, default when empty. */
export function itemName(raw: string, fallback: string): string {
  const trimmed = raw.trim().slice(0, NAME_MAX);
  return trimmed.length > 0 ? trimmed : fallback;
}
