import type { OpResult, RpcMethod, RpcParams, RpcResult, SessionId } from '@chef/contracts';
import { chef } from './bridge';
import { toChefError } from './errors';
import type { OpId, OpParams } from './ops';
import { useJobStore } from '../features/jobs/jobStore';

/** Call a core method; rejects with ChefError. */
export async function call<M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
): Promise<RpcResult<M>> {
  try {
    return await chef().rpc(method, params);
  } catch (e) {
    throw toChefError(e);
  }
}

export interface RunOpOptions {
  sessionId?: SessionId;
  /** Translated label shown in the job panel. */
  title: string;
  /** Called with the job id as soon as the core accepted the job (for progress / cancel). */
  onStarted?(jobId: string): void;
}

/** Start an operation and wait for its result (job.finished). */
export async function runOp<K extends OpId>(
  opId: K,
  params: OpParams[K],
  options: RunOpOptions,
): Promise<OpResult> {
  const { jobId } = await call('ops.run', {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    opId,
    params,
  });
  const result = useJobStore
    .getState()
    .track(jobId, { opId, title: options.title, sessionId: options.sessionId });
  options.onStarted?.(jobId);
  return result;
}

export async function cancelJob(jobId: string): Promise<void> {
  await call('jobs.cancel', { jobId });
}
