import { describe, expect, it, vi } from 'vitest';
import { JsonRpcClient, LineDecoder, RpcCallError, toRpcError } from '../src/main/rpc';

describe('LineDecoder', () => {
  it('splits lines across chunks and drops empty lines', () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(d.push('')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('x\r\ny\r\n'))).toEqual(['x', 'y']);
  });

  it('reassembles multi-byte UTF-8 characters split between chunks', () => {
    const d = new LineDecoder();
    const bytes = Buffer.from('"Nghị định"\n', 'utf8');
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...d.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual(['"Nghị định"']);
  });

  it('flushes a trailing line without newline on end()', () => {
    const d = new LineDecoder();
    expect(d.push('{"x":1}')).toEqual([]);
    expect(d.end()).toEqual(['{"x":1}']);
    expect(d.end()).toEqual([]);
  });

  it('throws when a line exceeds the limit', () => {
    const d = new LineDecoder(10);
    expect(() => d.push('0123456789abc')).toThrow(/exceeds/);
    expect(d.push('ok\n')).toEqual(['ok']);
  });
});

function makeClient() {
  const sent: Record<string, unknown>[] = [];
  const notifications: [string, unknown][] = [];
  const errors: string[] = [];
  const client = new JsonRpcClient(
    (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
    (method, params) => notifications.push([method, params]),
    (msg) => errors.push(msg),
  );
  return { client, sent, notifications, errors };
}

describe('JsonRpcClient', () => {
  it('sends one JSON-RPC 2.0 request per line with incrementing integer ids', async () => {
    const { client, sent } = makeClient();
    const p1 = client.request('system.ping', {});
    const p2 = client.request('session.state', { sessionId: 's' });
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'system.ping', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'session.state', params: { sessionId: 's' } },
    ]);
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: 2 } }));
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { version: '1' } }));
    await expect(p1).resolves.toEqual({ version: '1' });
    await expect(p2).resolves.toEqual({ ok: 2 });
    expect(client.pendingCount).toBe(0);
  });

  it('rejects with RpcCallError carrying code and data.kind', async () => {
    const { client } = makeClient();
    const p = client.request('session.open', { path: '/x.pdf' });
    client.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Password required', data: { kind: 'PASSWORD_REQUIRED' } },
      }),
    );
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcCallError);
    expect(toRpcError(err)).toEqual({
      code: -32000,
      message: 'Password required',
      data: { kind: 'PASSWORD_REQUIRED' },
    });
  });

  it('forwards notifications (no id)', () => {
    const { client, notifications } = makeClient();
    client.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'job.progress',
        params: { jobId: 'j', done: 1, total: 2 },
      }),
    );
    expect(notifications).toEqual([['job.progress', { jobId: 'j', done: 1, total: 2 }]]);
  });

  it('answers unexpected requests from the core with method-not-found', () => {
    const { client, sent } = makeClient();
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'main.do', params: {} }));
    expect(sent[0]).toMatchObject({ id: 'x', error: { code: -32601 } });
  });

  it('reports invalid JSON and unknown ids as protocol errors', () => {
    const { client, errors } = makeClient();
    client.handleLine('not json');
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 99, result: null }));
    client.handleLine('[1,2]');
    expect(errors).toHaveLength(3);
  });

  it('times out requests with a timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const p = client.request('system.ping', {}, { timeoutMs: 1000 });
      const assertion = expect(p).rejects.toMatchObject({ data: { kind: 'INTERNAL' } });
      vi.advanceTimersByTime(1001);
      await assertion;
      expect(client.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('failAll rejects every pending request', async () => {
    const { client } = makeClient();
    const ps = [client.request('a.b', {}), client.request('c.d', {})];
    client.failAll(new Error('gone'));
    for (const p of ps) await expect(p).rejects.toThrow('gone');
  });

  it('rejects when the transport write throws', async () => {
    const client = new JsonRpcClient(
      () => {
        throw new Error('EPIPE');
      },
      () => {},
    );
    await expect(client.request('a.b', {})).rejects.toThrow(/EPIPE/);
    expect(client.pendingCount).toBe(0);
  });
});
