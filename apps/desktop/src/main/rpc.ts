/**
 * Newline-delimited JSON-RPC 2.0 client (docs/CONTRACTS.md section 3).
 * Pure Node: no Electron imports, so it is unit-testable.
 */
import { StringDecoder } from 'node:string_decoder';
import type { RpcError } from '@chef/contracts';

/** Splits a byte stream into UTF-8 lines; tolerates chunks split mid-line or mid-character. */
export class LineDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';

  constructor(private readonly maxLineLength = 64 * 1024 * 1024) {}

  /** Returns the complete lines contained in `chunk` (without `\n` / `\r\n`). */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    let nl = this.buffer.indexOf('\n', start);
    while (nl !== -1) {
      let line = this.buffer.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
      start = nl + 1;
      nl = this.buffer.indexOf('\n', start);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxLineLength) {
      this.buffer = '';
      throw new Error(`JSON-RPC line exceeds ${this.maxLineLength} characters`);
    }
    return lines;
  }

  /** Flushes a trailing line without newline (stream ended). */
  end(): string[] {
    const rest = (this.buffer + this.decoder.end()).trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/** Error thrown for a JSON-RPC error response; carries the structured `RpcError`. */
export class RpcCallError extends Error {
  readonly code: number;
  readonly data?: RpcError['data'];

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'RpcCallError';
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }

  toJSON(): RpcError {
    const out: RpcError = { code: this.code, message: this.message };
    if (this.data !== undefined) out.data = this.data;
    return out;
  }
}

/** Builds an application error (`-32000`) with a stable kind. */
export function internalError(message: string, detail?: unknown): RpcCallError {
  return new RpcCallError({
    code: -32000,
    message,
    data: detail === undefined ? { kind: 'INTERNAL' } : { kind: 'INTERNAL', detail },
  });
}

/** Normalises anything thrown into a plain `RpcError` (safe to send over IPC). */
export function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcCallError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { code: -32000, message, data: { kind: 'INTERNAL' } };
}

export interface RequestOptions {
  /** Reject with an INTERNAL error after this many ms. 0 / undefined = no timeout. */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout | undefined;
}

export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Transport-agnostic JSON-RPC client. Feed incoming lines to `handleLine`; outgoing lines
 * are passed to `write` (without the trailing newline).
 */
export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly onNotification: NotificationHandler,
    private readonly onProtocolError: (message: string) => void = () => {},
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(
                  internalError(`Core did not answer ${method} within ${options.timeoutMs} ms`),
                );
              }
            }, options.timeoutMs)
          : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      } catch (err) {
        this.settle(id);
        reject(internalError(`Could not send ${method} to core: ${(err as Error).message}`));
      }
    });
  }

  handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onProtocolError(`Invalid JSON from core: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.onProtocolError('Core sent a non-object JSON-RPC message');
      return;
    }
    const m = msg as Record<string, unknown>;
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      if (!hasId) {
        this.onNotification(m.method, m.params);
      } else {
        // The core never calls main; answer politely so it does not hang.
        this.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            error: { code: -32601, message: `Method not found: ${m.method}` },
          }),
        );
      }
      return;
    }
    if (typeof m.id !== 'number') {
      this.onProtocolError(`Core response with unknown id: ${String(m.id)}`);
      return;
    }
    const pending = this.settle(m.id);
    if (!pending) {
      this.onProtocolError(`Core response for unknown/expired request id ${m.id}`);
      return;
    }
    if (m.error !== undefined) {
      pending.reject(new RpcCallError(normaliseError(m.error)));
    } else {
      pending.resolve(m.result ?? null);
    }
  }

  /** Rejects every in-flight request (e.g. when the core exits). */
  failAll(err: Error): void {
    const all = [...this.pending.values()];
    for (const p of all) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    return p;
  }
}

function normaliseError(raw: unknown): RpcError {
  if (typeof raw === 'object' && raw !== null) {
    const e = raw as Record<string, unknown>;
    const out: RpcError = {
      code: typeof e.code === 'number' ? e.code : -32000,
      message: typeof e.message === 'string' ? e.message : 'Unknown core error',
    };
    if (typeof e.data === 'object' && e.data !== null) {
      const d = e.data as Record<string, unknown>;
      out.data = { kind: typeof d.kind === 'string' ? d.kind : 'INTERNAL' };
      if (d.detail !== undefined) out.data.detail = d.detail;
    }
    return out;
  }
  return { code: -32000, message: String(raw), data: { kind: 'INTERNAL' } };
}
