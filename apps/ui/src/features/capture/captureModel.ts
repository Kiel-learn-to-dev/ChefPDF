/**
 * Phone capture (L5 / I19): pure state and parameter builders for the capture dialog.
 * The dialog runs the main process session (`chef.capture`) and feeds its events here.
 */
import type { CaptureStartResult, ChefEvent, LanInterface } from '@chef/contracts';
import { moveItem } from '../convert/convertModel';

export type CapturePhase = 'idle' | 'starting' | 'waiting' | 'review' | 'error';

export interface CapturePhoto {
  /** Server ordinal (0-based, order of arrival). */
  index: number;
  /** Absolute path in the app cache (readable through chef-file). */
  path: string;
}

export interface CaptureModel {
  phase: CapturePhase;
  url: string;
  qrSvg: string;
  expiresAt: number | null;
  interfaces: LanInterface[];
  /** Photos in the order the user wants them in the PDF. */
  photos: CapturePhoto[];
  /** Error code of the `error` phase (see captureErrorKey). */
  errorCode: string | null;
  /** Information shown in the review phase, e.g. the session expired after photos arrived. */
  notice: string | null;
}

export const INITIAL_CAPTURE: CaptureModel = {
  phase: 'idle',
  url: '',
  qrSvg: '',
  expiresAt: null,
  interfaces: [],
  photos: [],
  errorCode: null,
  notice: null,
};

export type CaptureAction =
  | { type: 'starting' }
  | { type: 'started'; result: CaptureStartResult }
  | { type: 'failed'; code: string }
  | { type: 'event'; event: ChefEvent }
  | { type: 'move'; from: number; to: number }
  | { type: 'remove'; index: number }
  | { type: 'reset' };

/** Adds a photo once, keeping the photos in server order (the user can reorder afterwards). */
export function addPhoto(photos: readonly CapturePhoto[], photo: CapturePhoto): CapturePhoto[] {
  if (photos.some((p) => p.index === photo.index)) return [...photos];
  return [...photos, photo].sort((a, b) => a.index - b.index);
}

export function removePhoto(photos: readonly CapturePhoto[], index: number): CapturePhoto[] {
  return photos.filter((p) => p.index !== index);
}

export function reorderPhotos(
  photos: readonly CapturePhoto[],
  from: number,
  to: number,
): CapturePhoto[] {
  return moveItem(photos, from, to);
}

export function captureReducer(state: CaptureModel, action: CaptureAction): CaptureModel {
  switch (action.type) {
    case 'starting':
      return { ...INITIAL_CAPTURE, phase: 'starting' };
    case 'started':
      return {
        ...INITIAL_CAPTURE,
        phase: 'waiting',
        url: action.result.url,
        qrSvg: action.result.qrSvg,
        expiresAt: action.result.expiresAt,
        interfaces: action.result.interfaces,
      };
    case 'failed':
      return { ...INITIAL_CAPTURE, phase: 'error', errorCode: action.code };
    case 'move':
      return { ...state, photos: reorderPhotos(state.photos, action.from, action.to) };
    case 'remove':
      return { ...state, photos: removePhoto(state.photos, action.index) };
    case 'reset':
      return INITIAL_CAPTURE;
    case 'event':
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: CaptureModel, event: ChefEvent): CaptureModel {
  if (event.type === 'capture-image') {
    // Photos are only expected while the phone is connected to the session.
    if (state.phase !== 'waiting') return state;
    return {
      ...state,
      photos: addPhoto(state.photos, { index: event.index, path: event.path }),
    };
  }
  if (event.type !== 'capture-status' || state.phase !== 'waiting') return state;
  if (event.state === 'active') return state;
  const hasPhotos = state.photos.length > 0;
  if (event.state === 'expired') {
    return hasPhotos
      ? { ...state, phase: 'review', notice: 'EXPIRED' }
      : { ...state, phase: 'error', errorCode: 'EXPIRED' };
  }
  // done (the phone pressed Xong) or stopped (the desktop pressed Xong / cancelled).
  if (!hasPhotos) return { ...INITIAL_CAPTURE };
  return { ...state, phase: 'review', notice: null };
}

/** Message key of an error code (the dialog translates it). */
export function captureErrorKey(code: string | null): string {
  switch (code) {
    case 'NO_LAN_INTERFACE':
      return 'capture.errNoLan';
    case 'INTERFACE_NOT_FOUND':
      return 'capture.errNoInterface';
    case 'EXPIRED':
      return 'capture.errExpired';
    default:
      return 'capture.errGeneric';
  }
}

export interface CaptureOptions {
  /** Auto crop and straighten each page (pageimg.autoCrop, then pageimg.deskew). */
  autoCrop: boolean;
  /** Split two-page book spreads (pageimg.splitSpread, auto). */
  splitSpread: boolean;
  /** Whiten the background (pageimg.enhance). Off by default. */
  whiten: boolean;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  autoCrop: true,
  splitSpread: false,
  whiten: false,
};

/** Params of convert.imagesToPdf: one page per photo, page size = photo size. */
export function capturePdfParams(paths: readonly string[], outputPath: string) {
  return {
    images: [...paths],
    outputPath,
    pageSize: 'fit-image' as const,
    marginMm: 0,
    orientation: 'auto' as const,
    fit: 'fit' as const,
  };
}

export interface PlannedOp {
  opId: 'pageimg.splitSpread' | 'pageimg.autoCrop' | 'pageimg.deskew' | 'pageimg.enhance';
  params: Record<string, unknown>;
  title: 'split' | 'crop' | 'deskew' | 'whiten';
}

/**
 * Operations run on the new document, in order, for the chosen options. The crop comes before the
 * split: the gutter of a book photo is only found once the photo is cut down to the open book.
 */
export function capturePlan(options: CaptureOptions): PlannedOp[] {
  const plan: PlannedOp[] = [];
  if (options.autoCrop) {
    plan.push({ opId: 'pageimg.autoCrop', params: { minConfidence: 0.6 }, title: 'crop' });
  }
  if (options.splitSpread) {
    plan.push({ opId: 'pageimg.splitSpread', params: { mode: 'auto' }, title: 'split' });
  }
  if (options.autoCrop) {
    plan.push({ opId: 'pageimg.deskew', params: { mode: 'auto' }, title: 'deskew' });
  }
  if (options.whiten) {
    plan.push({ opId: 'pageimg.enhance', params: { whiten: true }, title: 'whiten' });
  }
  return plan;
}

/** 0-based page indices the core flagged for review (pageimg.autoCrop data.needsReview). */
export function reviewPagesOf(data: unknown): number[] {
  if (typeof data !== 'object' || data === null) return [];
  const list = (data as { needsReview?: unknown }).needsReview;
  if (!Array.isArray(list)) return [];
  return list.filter((n): n is number => Number.isInteger(n) && n >= 0);
}
