import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_OPTIONS,
  INITIAL_CAPTURE,
  addPhoto,
  captureErrorKey,
  captureReducer,
  capturePdfParams,
  capturePlan,
  removePhoto,
  reorderPhotos,
  reviewPagesOf,
  type CaptureModel,
} from './captureModel';

const started = {
  sessionId: 'capture-1',
  url: 'http://192.168.1.20:5000/c/' + 'a'.repeat(32),
  qrSvg: '<svg></svg>',
  expiresAt: 1_000,
  interfaces: [{ name: 'Wi-Fi', address: '192.168.1.20' }],
};

function waiting(): CaptureModel {
  return captureReducer(INITIAL_CAPTURE, { type: 'started', result: started });
}

const img = (index: number) => ({ type: 'capture-image' as const, index, path: `/c/${index}.jpg` });
const status = (state: 'active' | 'done' | 'stopped' | 'expired', count = 0) => ({
  type: 'capture-status' as const,
  state,
  count,
  expiresAt: 1_000,
});

describe('capture state machine', () => {
  it('goes idle -> starting -> waiting with the QR and URL', () => {
    const s1 = captureReducer(INITIAL_CAPTURE, { type: 'starting' });
    expect(s1.phase).toBe('starting');
    const s2 = captureReducer(s1, { type: 'started', result: started });
    expect(s2.phase).toBe('waiting');
    expect(s2.url).toBe(started.url);
    expect(s2.qrSvg).toBe('<svg></svg>');
    expect(s2.interfaces).toHaveLength(1);
  });

  it('shows an error with the code when start fails', () => {
    const s = captureReducer(INITIAL_CAPTURE, { type: 'failed', code: 'NO_LAN_INTERFACE' });
    expect(s.phase).toBe('error');
    expect(captureErrorKey(s.errorCode)).toBe('capture.errNoLan');
  });

  it('collects photos as they arrive, in server order, once each', () => {
    let s = waiting();
    s = captureReducer(s, { type: 'event', event: img(1) });
    s = captureReducer(s, { type: 'event', event: img(0) });
    s = captureReducer(s, { type: 'event', event: img(1) });
    expect(s.photos.map((p) => p.index)).toEqual([0, 1]);
  });

  it('ignores photos outside the waiting phase', () => {
    const s = captureReducer(INITIAL_CAPTURE, { type: 'event', event: img(0) });
    expect(s.photos).toHaveLength(0);
  });

  it('moves to review on done, and returns to idle when nothing arrived', () => {
    let s = waiting();
    s = captureReducer(s, { type: 'event', event: img(0) });
    s = captureReducer(s, { type: 'event', event: status('done', 1) });
    expect(s.phase).toBe('review');
    expect(s.photos).toHaveLength(1);

    const empty = captureReducer(waiting(), { type: 'event', event: status('stopped') });
    expect(empty.phase).toBe('idle');
  });

  it('keeps the photos when the session expires, and reports it', () => {
    let s = captureReducer(waiting(), { type: 'event', event: img(0) });
    s = captureReducer(s, { type: 'event', event: status('expired', 1) });
    expect(s.phase).toBe('review');
    expect(s.notice).toBe('EXPIRED');

    const none = captureReducer(waiting(), { type: 'event', event: status('expired') });
    expect(none.phase).toBe('error');
    expect(captureErrorKey(none.errorCode)).toBe('capture.errExpired');
  });

  it('reorders and removes photos in review', () => {
    let s = waiting();
    s = captureReducer(s, { type: 'event', event: img(0) });
    s = captureReducer(s, { type: 'event', event: img(1) });
    s = captureReducer(s, { type: 'event', event: img(2) });
    s = captureReducer(s, { type: 'move', from: 2, to: 0 });
    expect(s.photos.map((p) => p.index)).toEqual([2, 0, 1]);
    s = captureReducer(s, { type: 'remove', index: 0 });
    expect(s.photos.map((p) => p.index)).toEqual([2, 1]);
  });

  it('reset returns to the initial state', () => {
    expect(captureReducer(waiting(), { type: 'reset' })).toEqual(INITIAL_CAPTURE);
  });
});

describe('photo list helpers', () => {
  const a = { index: 0, path: '/a' };
  const b = { index: 1, path: '/b' };
  it('addPhoto keeps server order and ignores duplicates', () => {
    expect(addPhoto([b], a)).toEqual([a, b]);
    expect(addPhoto([a, b], b)).toEqual([a, b]);
  });
  it('removePhoto and reorderPhotos do not mutate the input', () => {
    const list = [a, b];
    expect(removePhoto(list, 0)).toEqual([b]);
    expect(reorderPhotos(list, 0, 1)).toEqual([b, a]);
    expect(list).toEqual([a, b]);
  });
});

describe('parameter builders', () => {
  it('builds convert.imagesToPdf with fit-image pages, in the given order', () => {
    expect(capturePdfParams(['/2.jpg', '/1.jpg'], '/out.pdf')).toEqual({
      images: ['/2.jpg', '/1.jpg'],
      outputPath: '/out.pdf',
      pageSize: 'fit-image',
      marginMm: 0,
      orientation: 'auto',
      fit: 'fit',
    });
  });

  it('plans the default post-processing: crop, then straighten', () => {
    expect(capturePlan(DEFAULT_CAPTURE_OPTIONS).map((p) => p.opId)).toEqual([
      'pageimg.autoCrop',
      'pageimg.deskew',
    ]);
  });

  it('adds spread split first and whitening last, and nothing when all are off', () => {
    const plan = capturePlan({ autoCrop: true, splitSpread: true, whiten: true });
    expect(plan.map((p) => p.opId)).toEqual([
      'pageimg.splitSpread',
      'pageimg.autoCrop',
      'pageimg.deskew',
      'pageimg.enhance',
    ]);
    expect(plan[3]!.params).toEqual({ whiten: true });
    expect(capturePlan({ autoCrop: false, splitSpread: false, whiten: false })).toEqual([]);
  });

  it('reads needsReview from op data defensively', () => {
    expect(reviewPagesOf({ needsReview: [0, 4] })).toEqual([0, 4]);
    expect(reviewPagesOf({ needsReview: [-1, 2.5, 'x', 3] })).toEqual([3]);
    expect(reviewPagesOf(undefined)).toEqual([]);
    expect(reviewPagesOf({})).toEqual([]);
  });

  it('maps error codes to message keys', () => {
    expect(captureErrorKey('INTERFACE_NOT_FOUND')).toBe('capture.errNoInterface');
    expect(captureErrorKey('whatever')).toBe('capture.errGeneric');
    expect(captureErrorKey(null)).toBe('capture.errGeneric');
  });
});
