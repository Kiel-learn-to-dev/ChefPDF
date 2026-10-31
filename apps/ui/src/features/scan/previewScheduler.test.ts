import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewScheduler, type PreviewRunner } from './previewScheduler';

interface Flight {
  params: string;
  onStarted(jobId: string): void;
  resolve(value: string): void;
  reject(error: unknown): void;
}

function fakeRunner() {
  const flights: Flight[] = [];
  const cancelled: string[] = [];
  const runner: PreviewRunner<string, string> = {
    run(params, onStarted) {
      return new Promise<string>((resolve, reject) => {
        flights.push({ params, onStarted, resolve, reject });
      });
    },
    cancel(jobId) {
      cancelled.push(jobId);
    },
  };
  return { runner, flights, cancelled };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PreviewScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the debounce and then runs only the latest params', () => {
    const { runner, flights } = fakeRunner();
    const onResult = vi.fn();
    const s = new PreviewScheduler(runner, {
      onResult,
      onError: vi.fn(),
      isCancelled: () => false,
    });
    s.request('a');
    vi.advanceTimersByTime(200);
    s.request('b');
    vi.advanceTimersByTime(399);
    expect(flights).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flights.map((f) => f.params)).toEqual(['b']);
  });

  it('delivers the result of the latest run', async () => {
    const { runner, flights } = fakeRunner();
    const onResult = vi.fn();
    const s = new PreviewScheduler(runner, {
      onResult,
      onError: vi.fn(),
      isCancelled: () => false,
    });
    s.request('a');
    vi.advanceTimersByTime(400);
    flights[0]!.resolve('ok-a');
    await flush();
    expect(onResult).toHaveBeenCalledWith('ok-a');
  });

  it('cancels a run that is superseded, drops its result and starts the newest after it settles', async () => {
    const { runner, flights, cancelled } = fakeRunner();
    const onResult = vi.fn();
    const s = new PreviewScheduler(runner, {
      onResult,
      onError: vi.fn(),
      isCancelled: () => false,
    });
    s.request('a');
    vi.advanceTimersByTime(400);
    flights[0]!.onStarted('job-a');
    s.request('b');
    expect(cancelled).toEqual(['job-a']);
    vi.advanceTimersByTime(400);
    // The old run has not settled yet, so the new one must wait.
    expect(flights).toHaveLength(1);
    flights[0]!.resolve('stale');
    await flush();
    expect(onResult).not.toHaveBeenCalled();
    expect(flights.map((f) => f.params)).toEqual(['a', 'b']);
    flights[1]!.resolve('fresh');
    await flush();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('fresh');
  });

  it('cancels right away when the job id arrives after the request was superseded', () => {
    const { runner, flights, cancelled } = fakeRunner();
    const s = new PreviewScheduler(runner, {
      onResult: vi.fn(),
      onError: vi.fn(),
      isCancelled: () => false,
    });
    s.request('a');
    vi.advanceTimersByTime(400);
    s.request('b');
    flights[0]!.onStarted('late-job');
    expect(cancelled).toEqual(['late-job']);
  });

  it('reports errors of the latest run, but not cancellations', async () => {
    const { runner, flights } = fakeRunner();
    const onError = vi.fn();
    const s = new PreviewScheduler(runner, {
      onResult: vi.fn(),
      onError,
      isCancelled: (e) => e === 'CANCELLED',
    });
    s.request('a');
    vi.advanceTimersByTime(400);
    flights[0]!.reject('CANCELLED');
    await flush();
    expect(onError).not.toHaveBeenCalled();
    s.request('b');
    vi.advanceTimersByTime(400);
    flights[1]!.reject('INVALID_PARAMS');
    await flush();
    expect(onError).toHaveBeenCalledWith('INVALID_PARAMS');
  });

  it('dispose cancels the running job and starts nothing else', () => {
    const { runner, flights, cancelled } = fakeRunner();
    const s = new PreviewScheduler(runner, {
      onResult: vi.fn(),
      onError: vi.fn(),
      isCancelled: () => false,
    });
    s.request('a');
    vi.advanceTimersByTime(400);
    flights[0]!.onStarted('job-a');
    s.dispose();
    expect(cancelled).toEqual(['job-a']);
    s.request('b');
    vi.advanceTimersByTime(1000);
    expect(flights).toHaveLength(1);
  });

  it('never runs two jobs at the same time', () => {
    const { runner, flights } = fakeRunner();
    const s = new PreviewScheduler(runner, {
      onResult: vi.fn(),
      onError: vi.fn(),
      isCancelled: () => false,
    });
    s.request('a');
    vi.advanceTimersByTime(400);
    s.request('b');
    vi.advanceTimersByTime(400);
    s.request('c');
    vi.advanceTimersByTime(400);
    expect(flights).toHaveLength(1);
  });
});
