import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingLog } from '../src/main/logger';
import {
  SidecarManager,
  resolveCoreCommand,
  splitCommandLine,
  type CoreStatus,
} from '../src/main/sidecar';

const MOCK_CORE = path.resolve(__dirname, 'mock-core.mjs');

describe('splitCommandLine', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommandLine('node  "C:\\My Dir\\core.mjs" --x \'a b\'')).toEqual([
      'node',
      'C:\\My Dir\\core.mjs',
      '--x',
      'a b',
    ]);
    expect(splitCommandLine('a ""')).toEqual(['a', '']);
  });

  it('rejects unterminated quotes', () => {
    expect(() => splitCommandLine('node "x')).toThrow(/quote/);
  });
});

describe('resolveCoreCommand', () => {
  const base = {
    dataDir: '/data',
    resourcesPath: '/opt/app/resources',
    repoRoot: '/repo',
    platform: 'linux' as NodeJS.Platform,
  };

  it('uses uv from the repo root in dev', () => {
    expect(resolveCoreCommand({ ...base, isPackaged: false })).toEqual({
      command: 'uv',
      args: ['run', '--project', 'core', 'python', '-m', 'chef_core', '--data-dir', '/data'],
      cwd: '/repo',
    });
  });

  it('uses the PyInstaller onedir build when packaged', () => {
    expect(resolveCoreCommand({ ...base, isPackaged: true })).toEqual({
      command: path.join('/opt/app/resources', 'core', 'chef-core'),
      args: ['--data-dir', '/data'],
      cwd: path.join('/opt/app/resources', 'core'),
    });
    expect(resolveCoreCommand({ ...base, isPackaged: true, platform: 'win32' }).command).toMatch(
      /chef-core\.exe$/,
    );
  });

  it('honours CHEF_CORE_CMD and appends --data-dir', () => {
    expect(
      resolveCoreCommand({ ...base, isPackaged: true, override: 'node "/x y/mock.mjs" --fast' }),
    ).toEqual({
      command: 'node',
      args: ['/x y/mock.mjs', '--fast', '--data-dir', '/data'],
      cwd: undefined,
    });
  });
});

describe('SidecarManager (with mock core)', () => {
  const managers: SidecarManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.stop()));
  });

  function setup(
    env: Record<string, string> = {},
    opts: Partial<ConstructorParameters<typeof SidecarManager>[0]> = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-sidecar-'));
    const log = new RotatingLog(path.join(dir, 'logs', 'core.log'));
    const statuses: CoreStatus[] = [];
    const notifications: [string, unknown][] = [];
    const m = new SidecarManager({
      core: { command: process.execPath, args: [MOCK_CORE, '--data-dir', dir] },
      log,
      env: { ...process.env, ...env },
      backoffInitialMs: 50,
      backoffMaxMs: 200,
      ...opts,
    });
    m.on('status', (s) => statuses.push(s));
    m.on('notification', (method, params) => notifications.push([method, params]));
    managers.push(m);
    return { m, dir, log, statuses, notifications };
  }

  function waitForStatus(m: SidecarManager, status: CoreStatus, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (m.status === status) return resolve();
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${status}`)), timeoutMs);
      const on = (s: CoreStatus) => {
        if (s === status) {
          clearTimeout(t);
          m.off('status', on);
          resolve();
        }
      };
      m.on('status', on);
    });
  }

  it('starts, answers ping and logs stderr', async () => {
    const { m, log, statuses } = setup();
    m.start();
    // Requests made before ready wait for the core.
    await expect(m.request('system.ping', {})).resolves.toEqual({
      version: '0.0.0-mock',
      python: 'mock',
    });
    expect(statuses).toEqual(['starting', 'ready']);
    expect(fs.readFileSync(log.file, 'utf8')).toContain('mock-core: started');
  });

  it('round-trips UTF-8 text', async () => {
    const { m } = setup();
    m.start();
    await expect(m.request('mock.unicode', {})).resolves.toEqual({
      text: 'Nghị định – tiếng Việt ✓',
    });
  });

  it('forwards job notifications from ops.run', async () => {
    const { m, notifications } = setup();
    m.start();
    const { jobId } = (await m.request('ops.run', {
      opId: 'page.rotate',
      params: { pages: [0], angle: 90 },
    })) as {
      jobId: string;
    };
    await new Promise<void>((resolve) => {
      const check = () =>
        notifications.some(([n]) => n === 'job.finished') ? resolve() : setTimeout(check, 10);
      check();
    });
    const names = notifications.map(([n]) => n);
    expect(names).toEqual(['job.progress', 'job.progress', 'job.progress', 'job.finished']);
    expect(notifications[3]?.[1]).toMatchObject({ jobId, result: { changedPages: 'all' } });
  });

  it('propagates structured errors', async () => {
    const { m } = setup();
    m.start();
    await expect(m.request('nope.nothing', {})).rejects.toMatchObject({ code: -32601 });
    await expect(m.request('ops.run', {})).rejects.toMatchObject({
      code: -32602,
      data: { kind: 'INVALID_PARAMS' },
    });
  });

  it('restarts after a crash and fails in-flight requests', async () => {
    const { m, statuses } = setup();
    m.start();
    await waitForStatus(m, 'ready');
    const firstPid = m.pid;
    const sleeping = m.request('mock.sleep', { ms: 5000 });
    await m.request('mock.crash', {});
    await expect(sleeping).rejects.toMatchObject({ data: { kind: 'INTERNAL' } });
    await waitForStatus(m, 'ready');
    expect(m.pid).not.toBe(firstPid);
    expect(statuses).toEqual(['starting', 'ready', 'crashed', 'restarting', 'starting', 'ready']);
    await expect(m.request('system.ping', {})).resolves.toBeTruthy();
  });

  it('kills and restarts a core that does not answer the startup ping', async () => {
    const { m, statuses } = setup(
      { MOCK_CORE_STARTUP_DELAY_MS: '60000' },
      { startupTimeoutMs: 300 },
    );
    m.start();
    await waitForStatus(m, 'restarting');
    expect(statuses.slice(0, 3)).toEqual(['starting', 'crashed', 'restarting']);
  });

  it('keeps retrying with backoff when the core exits immediately', async () => {
    const { m, statuses, log } = setup({ MOCK_CORE_EXIT_ON_START: '2' });
    m.start();
    await new Promise((r) => setTimeout(r, 1200));
    const crashes = statuses.filter((s) => s === 'crashed').length;
    expect(crashes).toBeGreaterThanOrEqual(3);
    expect(crashes).toBeLessThan(15); // backoff, not a hot loop
    expect(fs.readFileSync(log.file, 'utf8')).toMatch(/restarting core in 200 ms/);
  });

  it('fails requests when the core never becomes ready', async () => {
    const { m } = setup({ MOCK_CORE_EXIT_ON_START: '1' }, { readyWaitMs: 300 });
    m.start();
    await expect(m.request('system.ping', {})).rejects.toMatchObject({
      data: { kind: 'INTERNAL' },
    });
  });

  it('stops gracefully via system.shutdown', async () => {
    const { m, log, statuses } = setup();
    m.start();
    await waitForStatus(m, 'ready');
    await m.stop();
    expect(m.pid).toBeUndefined();
    expect(fs.readFileSync(log.file, 'utf8')).toMatch(/core exited \(code 0/);
    expect(statuses).not.toContain('crashed');
  });
});

describe('RotatingLog', () => {
  it('rotates by size and keeps maxFiles backups', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-log-'));
    const file = path.join(dir, 'core.log');
    const log = new RotatingLog(file, { maxBytes: 100, maxFiles: 2 });
    for (let i = 0; i < 10; i++) log.write(`${String(i).repeat(60)}\n`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['core.log', 'core.log.1', 'core.log.2']);
    expect(fs.readFileSync(file, 'utf8')).toContain('9'.repeat(60));
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('8'.repeat(60));
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toContain('7'.repeat(60));
  });
});
