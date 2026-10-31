/**
 * Runs an op by its string id (for ops the typed OpParams table does not list yet, e.g. the
 * trust store and the template proof). Same job tracking as runOp in lib/rpc.ts.
 */
import { toChefError } from './errors';
import { call } from './rpc';
import { useJobStore } from '../features/jobs/jobStore';

export async function runLooseOp(opId: string, params: unknown, title: string): Promise<unknown> {
  try {
    const { jobId } = await call('ops.run', { opId, params });
    const result = await useJobStore.getState().track(jobId, { opId, title, silent: true });
    return result.data ?? null;
  } catch (e) {
    throw toChefError(e);
  }
}
