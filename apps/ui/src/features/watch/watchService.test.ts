import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRunResult } from '@chef/contracts';
import { createWatchController, type WatchApi, type WatchSnapshot } from './watchService';
import type { WatchConfig } from './watchModel';

const config = {
  sourceFolder: '/in',
  outputFolder: '/out',
  workflow: { id: 'sample', name: 'Sample', steps: [] },
  pollSeconds: 1,
  settleSeconds: 0,
  pattern: '*.pdf',
} as unknown as WatchConfig;

describe('watch controller', () => {
  it('does not start a file when stopped while a scan is still in flight', async () => {
    let finishScan!: (value: {
      ready: { path: string; size: number; mtimeNs: number }[];
      pending: number;
    }) => void;
    const scanPending = new Promise<{
      ready: { path: string; size: number; mtimeNs: number }[];
      pending: number;
    }>((resolve) => {
      finishScan = resolve;
    });
    const api: WatchApi = {
      scan: vi.fn(() => scanPending),
      run: vi.fn().mockResolvedValue({ results: [], summary: {} }),
      markDone: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    };
    let status: WatchSnapshot['status'] = 'stopped';
    const controller = createWatchController(api, (update) => {
      const patch =
        typeof update === 'function'
          ? update({ status, pending: 0, queued: 0, currentFile: null, recent: [], error: null })
          : update;
      status = patch.status ?? status;
    });
    controller.start(config, {}, {}, '/out/.ledger');
    controller.stop();
    finishScan({ ready: [{ path: '/in/waiting.pdf', size: 1, mtimeNs: 1 }], pending: 0 });
    await vi.waitFor(() => expect(status).toBe('stopped'));
    expect(api.run).not.toHaveBeenCalled();
    expect(api.release).toHaveBeenCalledWith({
      ledgerPath: '/out/.ledger',
      paths: ['/in/waiting.pdf'],
    });
  });

  it('records the active file and stops before the rest of the ready batch', async () => {
    let releaseRun!: () => void;
    const runPending = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const files = [
      { path: '/in/a.pdf', size: 10, mtimeNs: 1 },
      { path: '/in/b.pdf', size: 10, mtimeNs: 1 },
    ];
    const leased = new Set<string>();
    const scan = vi.fn(async () => {
      const ready = files.filter((file) => !leased.has(file.path));
      ready.forEach((file) => leased.add(file.path));
      return { ready, pending: 0 };
    });
    const run = vi.fn(async (): Promise<WorkflowRunResult> => {
      await runPending;
      return {
        results: [
          {
            path: '/in/a.pdf',
            status: 'done',
            outputPath: '/out/a.pdf',
            message: null,
            outputs: [],
            warnings: [],
          },
        ],
        summary: { total: 1, done: 1, failed: 0, skipped: 0 },
      } as unknown as WorkflowRunResult;
    });
    const markDone = vi.fn(async (params: { path: string }) => {
      leased.delete(params.path);
      const index = files.findIndex((file) => file.path === params.path);
      if (index >= 0) files.splice(index, 1);
    });
    const release = vi.fn(async (params: { paths?: string[] }) =>
      (params.paths ?? []).forEach((path) => leased.delete(path)),
    );
    const api: WatchApi = { scan, run, markDone, release };
    let snapshot: WatchSnapshot = {
      status: 'stopped',
      pending: 0,
      queued: 0,
      currentFile: null,
      recent: [],
      error: null,
    };
    const controller = createWatchController(api, (update) => {
      snapshot = { ...snapshot, ...(typeof update === 'function' ? update(snapshot) : update) };
    });
    controller.start(config, {}, {}, '/out/.ledger');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.stop();
    releaseRun();
    await vi.waitFor(() => expect(snapshot.status).toBe('stopped'));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(markDone).toHaveBeenCalledWith({
      ledgerPath: '/out/.ledger',
      path: '/in/a.pdf',
      outputPath: '/out/a.pdf',
      status: 'done',
    });
    expect(release).toHaveBeenCalledWith({ ledgerPath: '/out/.ledger', paths: ['/in/b.pdf'] });
    expect(snapshot.recent[0]?.status).toBe('done');
    expect(snapshot.queued).toBe(0);

    controller.start(config, {}, {}, '/out/.ledger');
    await vi.waitFor(() => expect(markDone).toHaveBeenCalledTimes(2));
    controller.stop();
    await vi.waitFor(() => expect(snapshot.status).toBe('stopped'));
    expect(markDone.mock.calls[1]?.[0].path).toBe('/in/b.pdf');
  });

  it('records failed workflow runs instead of losing the source from the queue', async () => {
    const api: WatchApi = {
      scan: vi
        .fn()
        .mockResolvedValue({ ready: [{ path: '/in/b.pdf', size: 1, mtimeNs: 1 }], pending: 0 }),
      run: vi.fn().mockRejectedValue(new Error('bad PDF')),
      markDone: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    let snapshot: WatchSnapshot = {
      status: 'stopped',
      pending: 0,
      queued: 0,
      currentFile: null,
      recent: [],
      error: null,
    };
    const controller = createWatchController(api, (update) => {
      snapshot = { ...snapshot, ...(typeof update === 'function' ? update(snapshot) : update) };
    });
    controller.start(config, {}, {}, '/out/.ledger');
    await vi.waitFor(() => expect(api.markDone).toHaveBeenCalled());
    controller.stop();
    await vi.waitFor(() => expect(snapshot.status).toBe('stopped'));
    expect(api.markDone).toHaveBeenCalledWith({
      ledgerPath: '/out/.ledger',
      path: '/in/b.pdf',
      status: 'failed',
    });
    expect(snapshot.recent[0]?.message).toBe('bad PDF');
  });
});
