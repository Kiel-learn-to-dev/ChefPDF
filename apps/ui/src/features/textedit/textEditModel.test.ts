import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canApply,
  checkTextParams,
  chipFor,
  createCheckScheduler,
  editLineParams,
  hitLine,
  isUnchanged,
  lineScreenBox,
  needsRefetch,
  nextLine,
  reduceEditor,
  type CheckResult,
  type Editor,
  type TextLine,
} from './textEditModel';

function line(over: Partial<TextLine> & { id: string; bbox: number[] }): TextLine {
  return {
    pageIndex: 0,
    text: 'Hợp đồng',
    fontName: 'Helvetica',
    fontSize: 11,
    bold: false,
    italic: false,
    canEncodeAny: true,
    paragraphId: null,
    editable: true,
    artifact: false,
    ...over,
  };
}

const OK: CheckResult = { supported: true, missing: [], willSubstituteWith: null };
const SUBST: CheckResult = { supported: false, missing: ['ệ'], willSubstituteWith: 'BeVietnamPro' };
const MISSING: CheckResult = { supported: false, missing: ['ệ', '₫'], willSubstituteWith: null };

describe('hitLine', () => {
  it('returns the smallest editable line under the point', () => {
    const big = line({ id: 'L1', bbox: [0, 0, 300, 100] });
    const small = line({ id: 'L2', bbox: [10, 10, 100, 20] });
    expect(hitLine([big, small], 50, 15)?.id).toBe('L2');
    expect(hitLine([big, small], 200, 50)?.id).toBe('L1');
  });

  it('skips artifacts, locked lines and points outside every box', () => {
    const artifact = line({ id: 'A', bbox: [0, 0, 100, 100], artifact: true });
    const locked = line({ id: 'B', bbox: [0, 0, 100, 100], editable: false });
    expect(hitLine([artifact, locked], 10, 10)).toBeNull();
    expect(hitLine([line({ id: 'C', bbox: [0, 0, 10, 10] })], 50, 50)).toBeNull();
  });
});

describe('nextLine', () => {
  const lines = [
    line({ id: 'b', bbox: [0, 40, 100, 50] }),
    line({ id: 'a', bbox: [0, 10, 100, 20] }),
    line({ id: 'c', bbox: [0, 70, 100, 80], artifact: true }),
    line({ id: 'd', bbox: [0, 90, 100, 100] }),
  ];

  it('moves in reading order and skips artifacts', () => {
    expect(nextLine(lines, 'a')?.id).toBe('b');
    expect(nextLine(lines, 'b')?.id).toBe('d');
    expect(nextLine(lines, 'd')).toBeNull();
    expect(nextLine(lines, 'd', true)?.id).toBe('b');
  });
});

describe('lineScreenBox', () => {
  it('maps points to px with the page origin and scale', () => {
    const box = lineScreenBox(line({ id: 'x', bbox: [10, 20, 110, 32] }), {
      left: 5,
      top: 7,
      scale: 2,
    });
    expect(box).toEqual({ left: 25, top: 47, width: 200, height: 24 });
  });
});

describe('isUnchanged', () => {
  it('compares with the text of the line', () => {
    const l = line({ id: 'x', bbox: [0, 0, 1, 1], text: 'Giá' });
    expect(isUnchanged(l, 'Giá')).toBe(true);
    expect(isUnchanged(l, 'Giá.')).toBe(false);
  });
});

describe('chipFor and canApply', () => {
  it('shows no chip while the text is unchanged or unchecked', () => {
    expect(chipFor(OK, true).tone).toBe('none');
    expect(chipFor(null, false).tone).toBe('none');
  });

  it('maps supported, substituted and missing results', () => {
    expect(chipFor(OK, false)).toMatchObject({ tone: 'ok', key: 'ok' });
    expect(chipFor(SUBST, false)).toEqual({
      tone: 'warn',
      key: 'substitute',
      params: { font: 'BeVietnamPro' },
    });
    expect(chipFor(MISSING, false)).toEqual({
      tone: 'error',
      key: 'missing',
      params: { chars: 'ệ ₫' },
    });
  });

  it('allows apply only when a font covers the text', () => {
    expect(canApply(OK)).toBe(true);
    expect(canApply(SUBST)).toBe(true);
    expect(canApply(MISSING)).toBe(false);
    expect(canApply(null)).toBe(true);
  });
});

describe('reduceEditor', () => {
  const base = line({ id: 'L1', bbox: [0, 0, 10, 10], text: 'Cũ' });
  let state: Editor | null;

  beforeEach(() => {
    state = reduceEditor(null, { type: 'open', line: base });
  });

  it('starts editing with the line text', () => {
    expect(state).toMatchObject({ phase: 'editing', lineId: 'L1', original: 'Cũ', text: 'Cũ' });
  });

  it('walks editing -> checking -> ready -> applying', () => {
    state = reduceEditor(state, { type: 'type', text: 'Mới' });
    expect(state).toMatchObject({ phase: 'editing', seq: 1 });
    state = reduceEditor(state, { type: 'checking', seq: 1 });
    expect(state?.phase).toBe('checking');
    state = reduceEditor(state, { type: 'checked', seq: 1, result: OK });
    expect(state).toMatchObject({ phase: 'ready', check: OK });
    state = reduceEditor(state, { type: 'apply' });
    expect(state?.phase).toBe('applying');
    expect(reduceEditor(state, { type: 'applied' })).toBeNull();
  });

  it('drops a check result for an older text', () => {
    state = reduceEditor(state, { type: 'type', text: 'a' });
    state = reduceEditor(state, { type: 'checking', seq: 1 });
    state = reduceEditor(state, { type: 'type', text: 'ab' });
    const before = state;
    state = reduceEditor(state, { type: 'checked', seq: 1, result: OK });
    expect(state).toBe(before);
    expect(state?.phase).toBe('editing');
  });

  it('does not apply when characters are missing', () => {
    state = reduceEditor(state, { type: 'type', text: 'ệ' });
    state = reduceEditor(state, { type: 'checking', seq: 1 });
    state = reduceEditor(state, { type: 'checked', seq: 1, result: MISSING });
    const before = state;
    expect(reduceEditor(state, { type: 'apply' })).toBe(before);
  });

  it('keeps the editor open with the error after a failed apply, and cancel closes it', () => {
    state = reduceEditor(state, { type: 'apply' });
    state = reduceEditor(state, { type: 'failed', message: 'LINE_NOT_FOUND' });
    expect(state).toMatchObject({ phase: 'ready', error: 'LINE_NOT_FOUND' });
    expect(reduceEditor(state, { type: 'cancel' })).toBeNull();
  });
});

describe('createCheckScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for the delay and runs only the newest text', async () => {
    const run = vi.fn(async () => OK);
    const onResult = vi.fn();
    const sched = createCheckScheduler({
      delayMs: 250,
      run,
      onStart: () => {},
      onResult,
      onError: () => {},
    });
    sched.schedule(1, 'a');
    vi.advanceTimersByTime(100);
    sched.schedule(2, 'ab');
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('ab');
    await vi.runAllTicks();
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledWith(2, OK);
  });

  it('drops a late result of an older request', async () => {
    let resolveFirst: (r: CheckResult) => void = () => {};
    const run = vi
      .fn<(text: string) => Promise<CheckResult>>()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(MISSING);
    const onResult = vi.fn();
    const sched = createCheckScheduler({
      delayMs: 10,
      run,
      onStart: () => {},
      onResult,
      onError: () => {},
    });
    sched.schedule(1, 'x');
    vi.advanceTimersByTime(10);
    sched.schedule(2, 'xy');
    vi.advanceTimersByTime(10);
    await Promise.resolve();
    resolveFirst(OK);
    await vi.runAllTicks();
    await Promise.resolve();
    expect(onResult.mock.calls.map((c) => c[0])).toEqual([2]);
  });

  it('cancel drops everything pending', () => {
    const run = vi.fn(async () => OK);
    const sched = createCheckScheduler({
      delayMs: 10,
      run,
      onStart: () => {},
      onResult: () => {},
      onError: () => {},
    });
    sched.schedule(1, 'x');
    sched.cancel();
    vi.advanceTimersByTime(50);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('op params', () => {
  it('builds text.checkText params that keep the style', () => {
    expect(checkTextParams('A0:d:3', 'Mới')).toEqual({
      lineId: 'A0:d:3',
      newText: 'Mới',
      keepStyle: true,
    });
  });

  it('builds text.editLine params and sends fontName only when chosen', () => {
    const l = { id: 'L', pageIndex: 2 };
    expect(editLineParams(l, 'x', { fontStrategy: 'auto', fitWidth: 'shrink' })).toEqual({
      pageIndex: 2,
      lineId: 'L',
      newText: 'x',
      fontStrategy: 'auto',
      keepStyle: true,
      fitWidth: 'shrink',
    });
    const withFont = editLineParams(l, 'x', {
      fontStrategy: 'replace',
      fontName: 'serif',
      fitWidth: 'none',
    });
    expect(withFont.fontName).toBe('serif');
  });

  it('flags the stale id errors for a refetch', () => {
    expect(needsRefetch('STALE_OBJECT_IDS')).toBe(true);
    expect(needsRefetch('LINE_NOT_FOUND')).toBe(true);
    expect(needsRefetch('TEXT_GLYPH_MISSING')).toBe(false);
  });
});
