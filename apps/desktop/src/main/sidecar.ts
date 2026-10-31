/**
 * Core sidecar manager (docs/CONTRACTS.md section 2): spawns the Python core, speaks JSON-RPC
 * over stdio, writes stderr to a rotating log, restarts with backoff on crash.
 * Pure Node: no Electron imports.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { JsonRpcClient, LineDecoder, internalError, type RequestOptions } from './rpc';
import type { RotatingLog } from './logger';

export type CoreStatus = 'starting' | 'ready' | 'crashed' | 'restarting';

export interface CoreCommand {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * Splits a command line into argv. Supports "double" and 'single' quotes; backslashes are
 * literal (Windows paths), so quoting is the only way to embed spaces.
 */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in command line');
  if (inToken) out.push(cur);
  return out;
}

export interface ResolveCoreOptions {
  dataDir: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** `process.resourcesPath` (packaged). */
  resourcesPath: string;
  /** Repository root (dev). */
  repoRoot: string;
  /** Value of env CHEF_CORE_CMD, if any. */
  override?: string | undefined;
}

/** Resolves how to launch the core; `--data-dir <dir>` is always appended. */
export function resolveCoreCommand(o: ResolveCoreOptions): CoreCommand {
  const dataArgs = ['--data-dir', o.dataDir];
  if (o.override && o.override.trim()) {
    const [command, ...args] = splitCommandLine(o.override.trim());
    if (!command) throw new Error('CHEF_CORE_CMD is empty');
    return { command, args: [...args, ...dataArgs], cwd: o.isPackaged ? undefined : o.repoRoot };
  }
  if (o.isPackaged) {
    const exe = o.platform === 'win32' ? 'chef-core.exe' : 'chef-core';
    const dir = path.join(o.resourcesPath, 'core');
    return { command: path.join(dir, exe), args: dataArgs, cwd: dir };
  }
  return {
    command: 'uv',
    args: ['run', '--project', 'core', 'python', '-m', 'chef_core', ...dataArgs],
    cwd: o.repoRoot,
  };
}

export interface SidecarOptions {
  core: CoreCommand;
  log: RotatingLog;
  env?: NodeJS.ProcessEnv;
  /** Timeout of the startup ping (includes interpreter start / `uv` sync). */
  startupTimeoutMs?: number;
  /** Timeout applied to every `system.ping` after startup. */
  pingTimeoutMs?: number;
  /** How long requests wait for the core to become ready before failing. */
  readyWaitMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A core that stayed up this long resets the backoff. */
  stableMs?: number;
}

interface Waiter {
  resolve(): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface SidecarEvents {
  status: [CoreStatus];
  notification: [method: string, params: unknown];
}

export class SidecarManager extends EventEmitter<SidecarEvents> {
  private child: ChildProcess | null = null;
  private client: JsonRpcClient | null = null;
  private _status: CoreStatus = 'starting';
  private ready = false;
  private stopping = false;
  private attempts = 0;
  private readyAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private waiters: Waiter[] = [];
  private exitPromise: Promise<void> | null = null;
  private readonly o: Required<Omit<SidecarOptions, 'env'>> & { env?: NodeJS.ProcessEnv };

  constructor(options: SidecarOptions) {
    super();
    this.o = {
      startupTimeoutMs: 60_000,
      pingTimeoutMs: 10_000,
      readyWaitMs: 60_000,
      backoffInitialMs: 500,
      backoffMaxMs: 30_000,
      stableMs: 60_000,
      ...options,
    };
  }

  get status(): CoreStatus {
    return this._status;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    this.stopping = false;
    if (!this.child && !this.restartTimer) this.spawnCore();
  }

  /** Sends a request, waiting (bounded) for the core to be ready first. */
  async request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    await this.whenReady();
    const client = this.client;
    if (!client) throw internalError('Core is not running');
    const timeoutMs =
      method === 'system.ping' ? (options.timeoutMs ?? this.o.pingTimeoutMs) : options.timeoutMs;
    return client.request(method, params, { timeoutMs });
  }

  /** Graceful stop: `system.shutdown`, then EOF, then SIGTERM / SIGKILL. */
  async stop(timeoutMs = 3000): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectWaiters(internalError('Core is shutting down'));
    const child = this.child;
    if (!child) return;
    const exited = this.exitPromise ?? Promise.resolve();
    if (this.ready && this.client) {
      await Promise.race([
        this.client.request('system.shutdown', {}, { timeoutMs }).catch(() => undefined),
        exited,
      ]);
    }
    child.stdin?.end();
    if (await waitFor(exited, timeoutMs)) return;
    child.kill('SIGTERM');
    if (await waitFor(exited, 2000)) return;
    child.kill('SIGKILL');
    await waitFor(exited, 2000);
  }

  private setStatus(status: CoreStatus): void {
    this._status = status;
    this.emit('status', status);
  }

  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.stopping) return Promise.reject(internalError('Core is shutting down'));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(
            internalError(
              `Core not ready after ${this.o.readyWaitMs} ms (status: ${this._status})`,
            ),
          );
        }, this.o.readyWaitMs),
      };
      this.waiters.push(waiter);
    });
  }

  private resolveWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private rejectWaiters(err: Error): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private spawnCore(): void {
    const { core, log } = this.o;
    this.setStatus('starting');
    this.ready = false;
    log.line(
      `--- starting core: ${core.command} ${core.args.join(' ')} (cwd ${core.cwd ?? process.cwd()})`,
    );

    let child: ChildProcess;
    try {
      child = spawn(core.command, core.args, {
        cwd: core.cwd,
        env: {
          ...(this.o.env ?? process.env),
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      log.line(`core spawn failed: ${(err as Error).message}`);
      this.handleExit(null, null);
      return;
    }
    this.child = child;

    let resolveExit!: () => void;
    this.exitPromise = new Promise<void>((r) => (resolveExit = r));
    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exited) return;
      exited = true;
      resolveExit();
      if (this.child === child) this.handleExit(code, signal);
    };

    const decoder = new LineDecoder();
    const client = new JsonRpcClient(
      (line) => {
        if (!child.stdin || child.stdin.destroyed) throw new Error('core stdin closed');
        child.stdin.write(line + '\n');
      },
      (method, params) => this.emit('notification', method, params),
      (message) => log.line(`protocol: ${message}`),
    );
    this.client = client;

    child.stdout?.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        log.line(`protocol: ${(err as Error).message}`);
        return;
      }
      for (const line of lines) client.handleLine(line);
    });
    child.stdout?.on('end', () => {
      for (const line of decoder.end()) client.handleLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));
    child.stdin?.on('error', (err) => log.line(`core stdin error: ${err.message}`));
    child.on('error', (err) => {
      log.line(`core process error: ${err.message}`);
      onExit(null, null);
    });
    child.on('exit', onExit);

    client
      .request('system.ping', {}, { timeoutMs: this.o.startupTimeoutMs })
      .then((result) => {
        if (this.child !== child) return;
        this.ready = true;
        this.readyAt = Date.now();
        log.line(`core ready (pid ${child.pid}): ${JSON.stringify(result)}`);
        this.setStatus('ready');
        this.resolveWaiters();
      })
      .catch((err: Error) => {
        if (this.child !== child || exited) return;
        log.line(`core startup ping failed: ${err.message}; killing pid ${child.pid}`);
        child.kill('SIGKILL');
      });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasReadyFor = this.ready ? Date.now() - this.readyAt : 0;
    this.o.log.line(`core exited (code ${code}, signal ${signal})`);
    this.child = null;
    this.ready = false;
    const client = this.client;
    this.client = null;
    client?.failAll(internalError('Core process exited', { code, signal }));
    if (this.stopping) return;

    this.setStatus('crashed');
    if (wasReadyFor >= this.o.stableMs) this.attempts = 0;
    const delay = Math.min(this.o.backoffInitialMs * 2 ** this.attempts, this.o.backoffMaxMs);
    this.attempts++;
    this.o.log.line(`restarting core in ${delay} ms (attempt ${this.attempts})`);
    this.setStatus('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnCore();
    }, delay);
  }
}

function waitFor(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
