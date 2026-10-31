import { beforeEach, describe, expect, it } from 'vitest';
import type { OpResult } from '@chef/contracts';
import { ChefError } from '../../lib/errors';
import { jobProgress, resetJobStore, selectRunningCount, useJobStore } from './jobStore';

const result: OpResult = {
  state: {
    sessionId: 's1',
    sourcePath: null,
    revisionPath: '/r1.pdf',
    revision: 1,
    canUndo: true,
    canRedo: false,
    dirty: true,
    signed: false,
  },
  changedPages: 'all',
  warnings: [],
  outputs: [],
};

describe('job store', () => {
  beforeEach(() => resetJobStore());

  it('tracks progress and resolves on finish', async () => {
    const store = useJobStore.getState();
    const p = store.track('j1', { opId: 'page.rotate', title: 'Xoay' });
    expect(selectRunningCount(useJobStore.getState())).toBe(1);
    store.handle({
      name: 'job.progress',
      payload: { jobId: 'j1', done: 1, total: 4, message: 'x' },
    });
    const job = useJobStore.getState().jobs[0]!;
    expect(job.done).toBe(1);
    expect(jobProgress(job)).toBe(0.25);
    store.handle({ name: 'job.finished', payload: { jobId: 'j1', result } });
    await expect(p).resolves.toBe(result);
    expect(useJobStore.getState().jobs[0]!.status).toBe('finished');
    expect(selectRunningCount(useJobStore.getState())).toBe(0);
  });

  it('rejects with ChefError on failure', async () => {
    const store = useJobStore.getState();
    const p = store.track('j2', { opId: 'page.delete', title: 'Xóa' });
    store.handle({
      name: 'job.failed',
      payload: {
        jobId: 'j2',
        error: { code: -32602, message: 'bad', data: { kind: 'INVALID_PARAMS' } },
      },
    });
    await expect(p).rejects.toMatchObject({ kind: 'INVALID_PARAMS' });
    await p.catch((e: unknown) => expect(e).toBeInstanceOf(ChefError));
  });

  it('rejects with CANCELLED', async () => {
    const store = useJobStore.getState();
    const p = store.track('j3', { opId: 'file.split', title: 'Tách' });
    store.handle({ name: 'job.cancelled', payload: { jobId: 'j3' } });
    await expect(p).rejects.toMatchObject({ kind: 'CANCELLED' });
  });

  it('buffers events that arrive before track()', async () => {
    const store = useJobStore.getState();
    store.handle({ name: 'job.finished', payload: { jobId: 'early', result } });
    const p = store.track('early', { opId: 'page.rotate', title: 'Xoay' });
    await expect(p).resolves.toBe(result);
  });

  it('indeterminate progress and clearing', () => {
    const store = useJobStore.getState();
    void store.track('a', { opId: 'x', title: 'A' });
    void store.track('b', { opId: 'x', title: 'B' }).catch(() => undefined);
    expect(jobProgress(useJobStore.getState().jobs[0]!)).toBeNull();
    store.handle({ name: 'job.cancelled', payload: { jobId: 'b' } });
    store.clearFinished();
    expect(useJobStore.getState().jobs.map((j) => j.id)).toEqual(['a']);
    store.dismiss('a');
    expect(useJobStore.getState().jobs).toHaveLength(1);
  });
});
