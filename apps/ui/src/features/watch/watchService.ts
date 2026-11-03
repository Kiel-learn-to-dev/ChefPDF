import { create } from 'zustand';
import type {
  Workflow,
  WorkflowRunResult,
  WatchMarkDoneParams,
  WatchReleaseParams,
  WatchScanParams,
} from '@chef/contracts';
import { runOp } from '../../lib/rpc';
import type { OpId } from '../../lib/ops';
import {
  watchDelayMs,
  watchLedgerPath,
  watchScanParams,
  workflowOutput,
  type WatchConfig,
  type WatchFileResult,
  type WatchStatus,
} from './watchModel';

const STORAGE_KEY = 'chef.watch.config.v1';
const RESULT_LIMIT = 12;

interface ReadyFile {
  path: string;
  size: number;
  mtimeNs: number;
}

interface WatchScanData {
  ready: ReadyFile[];
  pending: number;
}

export interface WatchRunRequest {
  workflow: Workflow;
  files: { path: string }[];
  variables: Record<string, string>;
  secrets: Record<string, string>;
  output: ReturnType<typeof workflowOutput>;
}

export interface WatchApi {
  scan(params: WatchScanParams): Promise<WatchScanData>;
  run(params: WatchRunRequest): Promise<WorkflowRunResult>;
  markDone(params: WatchMarkDoneParams): Promise<void>;
  release(params: WatchReleaseParams): Promise<void>;
}

export interface WatchSnapshot {
  status: WatchStatus;
  pending: number;
  queued: number;
  currentFile: string | null;
  recent: WatchFileResult[];
  error: string | null;
}

const EMPTY_SNAPSHOT: WatchSnapshot = {
  status: 'stopped',
  pending: 0,
  queued: 0,
  currentFile: null,
  recent: [],
  error: null,
};

interface PersistedWatch {
  config?: WatchConfig;
  recent?: WatchFileResult[];
  wasRunning?: boolean;
}

function readPersisted(): PersistedWatch {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedWatch) : {};
  } catch {
    return {};
  }
}

function savePersisted(config: WatchConfig | null, recent: WatchFileResult[], wasRunning: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, recent, wasRunning }));
  } catch {
    // The watch still works for this session when storage is unavailable.
  }
}

function resultRow(
  file: string,
  status: WatchFileResult['status'],
  outputPath: string | null,
  message: string | null,
): WatchFileResult {
  return { path: file, status, outputPath, message, completedAt: Date.now() };
}

/** Serial scanner/runner loop. Stopping waits until the current ready batch is recorded. */
type WatchStateUpdate =
  Partial<WatchSnapshot> | ((current: WatchSnapshot) => Partial<WatchSnapshot>);

export function createWatchController(api: WatchApi, onState: (patch: WatchStateUpdate) => void) {
  let active = false;
  let stopRequested = false;
  let wakeDelay: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      wakeDelay = () => {
        window.clearTimeout(timer);
        resolve();
      };
    });

  async function loop(
    config: WatchConfig,
    variables: Record<string, string>,
    secrets: Record<string, string>,
    ledgerPath: string,
  ) {
    let leftovers: string[] = [];
    try {
      while (!stopRequested) {
        const scanned = await api.scan(watchScanParams(config, ledgerPath));
        leftovers = scanned.ready.map((file) => file.path);
        onState({ pending: scanned.pending, queued: scanned.ready.length });
        if (stopRequested) {
          if (leftovers.length) await api.release({ ledgerPath, paths: leftovers });
          leftovers = [];
          break;
        }
        for (let index = 0; index < scanned.ready.length; index += 1) {
          const file = scanned.ready[index]!;
          onState({ currentFile: file.path, queued: scanned.ready.length - index });
          let row: WatchFileResult;
          try {
            const report = await api.run({
              workflow: config.workflow,
              files: [{ path: file.path }],
              variables,
              secrets,
              output: workflowOutput(config),
            });
            const result = report.results[0];
            row = resultRow(
              file.path,
              result?.status ?? 'failed',
              result?.outputPath ?? null,
              result?.message ?? null,
            );
          } catch (error) {
            row = resultRow(
              file.path,
              'failed',
              null,
              error instanceof Error ? error.message : String(error),
            );
          }

          leftovers = scanned.ready.slice(index + 1).map((remaining) => remaining.path);
          await api.markDone({
            ledgerPath,
            path: file.path,
            ...(row.outputPath ? { outputPath: row.outputPath } : {}),
            status: row.status,
          });
          onState((current) => ({
            recent: [row, ...current.recent].slice(0, RESULT_LIMIT),
            queued: Math.max(0, scanned.ready.length - index - 1),
          }));
          if (stopRequested) break;
        }
        if (stopRequested && leftovers.length) {
          await api.release({ ledgerPath, paths: leftovers });
          leftovers = [];
        }
        onState({ currentFile: null, queued: 0 });
        if (stopRequested) break;
        await sleep(watchDelayMs(config.pollSeconds));
        wakeDelay = null;
      }
      onState({ status: 'stopped', currentFile: null });
    } catch (error) {
      if (leftovers.length) {
        try {
          await api.release({ ledgerPath, paths: leftovers });
        } catch {
          /* preserve the original failure */
        }
      }
      onState({
        status: 'error',
        currentFile: null,
        queued: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      active = false;
      stopRequested = false;
      wakeDelay = null;
    }
  }

  return {
    start(
      config: WatchConfig,
      variables: Record<string, string>,
      secrets: Record<string, string>,
      ledgerPath: string,
    ) {
      if (active) return false;
      active = true;
      stopRequested = false;
      onState({ status: 'running', pending: 0, queued: 0, currentFile: null, error: null });
      void loop(config, variables, secrets, ledgerPath);
      return true;
    },
    stop() {
      if (!active) return;
      stopRequested = true;
      wakeDelay?.();
      onState({ status: 'stopping' });
    },
    isActive() {
      return active;
    },
  };
}

const watchApi: WatchApi = {
  async scan(params) {
    const result = await runOp('watch.scan' as OpId, params as never, {
      title: 'Watch folder',
      silent: true,
    });
    return result.data as WatchScanData;
  },
  async run(params) {
    const result = await runOp('workflow.run', params as never, {
      title: 'Watch workflow',
      silent: true,
    });
    return result.data as WorkflowRunResult;
  },
  async markDone(params) {
    await runOp('watch.markDone' as OpId, params as never, {
      title: 'Record watched file',
      silent: true,
    });
  },
  async release(params) {
    await runOp('watch.release' as OpId, params as never, {
      title: 'Release unprocessed watched files',
      silent: true,
    });
  },
};

interface WatchStore extends WatchSnapshot {
  config: WatchConfig | null;
  interrupted: boolean;
  start(
    config: WatchConfig,
    variables: Record<string, string>,
    secrets: Record<string, string>,
  ): void;
  stop(): void;
}

const persisted = readPersisted();

export const useWatchStore = create<WatchStore>((set, get) => {
  const controller = createWatchController(watchApi, (patch) => {
    set((current) => {
      const next = typeof patch === 'function' ? patch(current) : patch;
      const status = next.status ?? current.status;
      const recent = next.recent ?? current.recent;
      savePersisted(current.config, recent, status === 'running' || status === 'stopping');
      return next;
    });
  });
  return {
    ...EMPTY_SNAPSHOT,
    recent: persisted.recent ?? [],
    config: persisted.config ?? null,
    interrupted: persisted.wasRunning ?? false,
    start: (config, variables, secrets) => {
      const ledgerPath = watchLedgerPath(config.outputFolder, config.workflow.id, chefPlatform());
      set({ config, interrupted: false, error: null });
      savePersisted(config, get().recent, true);
      controller.start(config, variables, secrets, ledgerPath);
    },
    stop: () => controller.stop(),
  };
});

function chefPlatform(): string {
  return (
    window.chef?.app.platform ??
    (navigator.platform.toLowerCase().includes('win') ? 'win32' : 'posix')
  );
}
