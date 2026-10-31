/**
 * Signature verification per open document (I34). Runs `sign.verify` on the session, debounced,
 * cancels a stale job and ignores its late result. The status bar and the panel both read it.
 */
import { create } from 'zustand';
import type { SignatureVerifyItem } from '@chef/contracts';
import { cancelJob, runOp } from '../../lib/rpc';
import { toChefError } from '../../lib/errors';
import { sortBySeverity } from './verifyModel';

export type VerifyPhase = 'idle' | 'running' | 'done' | 'error';

export interface VerifyEntry {
  phase: VerifyPhase;
  items: SignatureVerifyItem[];
  error: string | null;
  /** Revision the result belongs to (revision path + number). */
  revision: string | null;
}

const EMPTY: VerifyEntry = { phase: 'idle', items: [], error: null, revision: null };

interface VerifyState {
  byDoc: Record<string, VerifyEntry>;
  patch(docId: string, patch: Partial<VerifyEntry>): void;
  forget(docId: string): void;
}

export const useVerifyStore = create<VerifyState>((set) => ({
  byDoc: {},
  patch(docId, patch) {
    set((s) => ({
      byDoc: { ...s.byDoc, [docId]: { ...(s.byDoc[docId] ?? EMPTY), ...patch } },
    }));
  },
  forget(docId) {
    set((s) => {
      const next = { ...s.byDoc };
      delete next[docId];
      return { byDoc: next };
    });
  },
}));

export function verifyEntry(docId: string | undefined): VerifyEntry {
  return (docId && useVerifyStore.getState().byDoc[docId]) || EMPTY;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const generation = new Map<string, number>();
const jobs = new Map<string, string>();

/**
 * Runs the check after `delayMs`. A newer request for the same document supersedes this one:
 * its job is cancelled and its result is dropped.
 */
export function scheduleVerify(docId: string, revision: string, delayMs = 300): void {
  const pending = timers.get(docId);
  if (pending) clearTimeout(pending);
  useVerifyStore.getState().patch(docId, { phase: 'running', revision });
  timers.set(
    docId,
    setTimeout(() => {
      timers.delete(docId);
      void runVerify(docId, revision);
    }, delayMs),
  );
}

async function runVerify(docId: string, revision: string): Promise<void> {
  const gen = (generation.get(docId) ?? 0) + 1;
  generation.set(docId, gen);
  const stale = () => generation.get(docId) !== gen;
  const previous = jobs.get(docId);
  if (previous) {
    jobs.delete(docId);
    void cancelJob(previous).catch(() => undefined);
  }
  try {
    const result = await runOp(
      'sign.verify',
      {},
      {
        sessionId: docId,
        title: 'Kiểm tra chữ ký',
        silent: true,
        onStarted: (jobId) => jobs.set(docId, jobId),
      },
    );
    if (stale()) return;
    const data = result.data as { signatures?: SignatureVerifyItem[] } | null | undefined;
    useVerifyStore.getState().patch(docId, {
      phase: 'done',
      items: sortBySeverity(data?.signatures ?? []),
      error: null,
      revision,
    });
  } catch (e) {
    if (stale()) return;
    useVerifyStore.getState().patch(docId, {
      phase: 'error',
      items: [],
      error: toChefError(e).message,
      revision,
    });
  } finally {
    if (!stale()) jobs.delete(docId);
  }
}

/** Forgets the document (on close): cancels its timer and drops its result. */
export function disposeVerify(docId: string): void {
  const pending = timers.get(docId);
  if (pending) clearTimeout(pending);
  timers.delete(docId);
  generation.set(docId, (generation.get(docId) ?? 0) + 1);
  jobs.delete(docId);
  useVerifyStore.getState().forget(docId);
}
