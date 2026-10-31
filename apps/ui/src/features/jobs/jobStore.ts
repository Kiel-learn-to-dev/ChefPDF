import { create } from 'zustand';
import type { JobId, OpResult, RpcNotifications, SessionId } from '@chef/contracts';
import { ChefError } from '../../lib/errors';

export type JobStatus = 'running' | 'finished' | 'failed' | 'cancelled';

export interface Job {
  id: JobId;
  opId: string;
  /** Already translated, user-facing label. */
  title: string;
  sessionId?: SessionId;
  status: JobStatus;
  done: number;
  total: number;
  message?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface JobMeta {
  opId: string;
  title: string;
  sessionId?: SessionId;
  /** Not listed in the job panel (quick background runs such as scan previews). */
  silent?: boolean;
}

type JobEvent =
  | { name: 'job.progress'; payload: RpcNotifications['job.progress'] }
  | { name: 'job.finished'; payload: RpcNotifications['job.finished'] }
  | { name: 'job.failed'; payload: RpcNotifications['job.failed'] }
  | { name: 'job.cancelled'; payload: RpcNotifications['job.cancelled'] };

interface Waiter {
  resolve: (r: OpResult) => void;
  reject: (e: Error) => void;
}

interface JobState {
  jobs: Job[];
  /** Start tracking a job; resolves with the op result or rejects with ChefError. */
  track(jobId: JobId, meta: JobMeta): Promise<OpResult>;
  handle(event: JobEvent): void;
  dismiss(jobId: JobId): void;
  clearFinished(): void;
}

const MAX_KEPT = 30;
const waiters = new Map<JobId, Waiter>();
/** Jobs tracked without a row in the job list. */
const silent = new Set<JobId>();
/** Terminal events that arrived before `track` was called (race between ops.run reply and notifications). */
const early = new Map<JobId, JobEvent[]>();

export const useJobStore = create<JobState>((set, get) => ({
  jobs: [],

  track(jobId, meta) {
    const promise = new Promise<OpResult>((resolve, reject) =>
      waiters.set(jobId, { resolve, reject }),
    );
    const { silent: quiet, ...rest } = meta;
    if (quiet) silent.add(jobId);
    else {
      const job: Job = {
        id: jobId,
        ...rest,
        status: 'running',
        done: 0,
        total: 0,
        startedAt: Date.now(),
      };
      set((s) => ({ jobs: [job, ...s.jobs.filter((j) => j.id !== jobId)].slice(0, MAX_KEPT) }));
    }
    const buffered = early.get(jobId);
    if (buffered) {
      early.delete(jobId);
      buffered.forEach((ev) => get().handle(ev));
    }
    return promise;
  },

  handle(event) {
    const { jobId } = event.payload;
    if (!silent.has(jobId) && !get().jobs.some((j) => j.id === jobId)) {
      early.set(jobId, [...(early.get(jobId) ?? []), event]);
      return;
    }
    const patch = (p: Partial<Job>) =>
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, ...p } : j)) }));
    const waiter = waiters.get(jobId);
    switch (event.name) {
      case 'job.progress':
        patch({
          done: event.payload.done,
          total: event.payload.total,
          message: event.payload.message,
        });
        return;
      case 'job.finished':
        patch({
          status: 'finished',
          endedAt: Date.now(),
          done: Math.max(1, get().jobs.find((j) => j.id === jobId)?.total ?? 1),
          message: undefined,
        });
        waiters.delete(jobId);
        silent.delete(jobId);
        waiter?.resolve(event.payload.result);
        return;
      case 'job.failed':
        patch({ status: 'failed', endedAt: Date.now(), error: event.payload.error.message });
        waiters.delete(jobId);
        silent.delete(jobId);
        waiter?.reject(ChefError.fromRpcError(event.payload.error));
        return;
      case 'job.cancelled':
        patch({ status: 'cancelled', endedAt: Date.now() });
        waiters.delete(jobId);
        silent.delete(jobId);
        waiter?.reject(new ChefError('CANCELLED', 'cancelled'));
        return;
    }
  },

  dismiss(jobId) {
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId || j.status === 'running') }));
  },

  clearFinished() {
    set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'running') }));
  },
}));

export function isJobEvent(name: string): name is JobEvent['name'] {
  return (
    name === 'job.progress' ||
    name === 'job.finished' ||
    name === 'job.failed' ||
    name === 'job.cancelled'
  );
}

export const selectRunningCount = (s: JobState) =>
  s.jobs.filter((j) => j.status === 'running').length;

/** Progress in [0, 1], or null when indeterminate. */
export function jobProgress(job: Job): number | null {
  if (job.status !== 'running') return 1;
  return job.total > 0 ? Math.min(1, job.done / job.total) : null;
}

/** Test helper. */
export function resetJobStore() {
  waiters.clear();
  early.clear();
  silent.clear();
  useJobStore.setState({ jobs: [] });
}
