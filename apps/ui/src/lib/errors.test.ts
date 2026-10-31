import { describe, expect, it } from 'vitest';
import { ChefError, toChefError } from './errors';

describe('toChefError', () => {
  it('reads the plain RpcError object rejected by chef.rpc', () => {
    const e = toChefError({
      name: 'RpcError',
      code: -32000,
      message: 'Password required',
      data: { kind: 'PASSWORD_REQUIRED' },
    });
    expect(e).toBeInstanceOf(ChefError);
    expect(e.kind).toBe('PASSWORD_REQUIRED');
    expect(e.code).toBe(-32000);
  });

  it('parses JSON or a kind inside an Error message', () => {
    expect(
      toChefError(
        new Error(
          'Error invoking remote method: {"code":-32602,"message":"bad","data":{"kind":"INVALID_PARAMS"}}',
        ),
      ).kind,
    ).toBe('INVALID_PARAMS');
    expect(toChefError(new Error('BLOCKED_BY_SIGNATURE: document is signed')).kind).toBe(
      'BLOCKED_BY_SIGNATURE',
    );
  });

  it('falls back to UNKNOWN', () => {
    expect(toChefError('boom').kind).toBe('UNKNOWN');
    expect(toChefError({ data: { kind: 'WHATEVER' }, message: 'x' }).kind).toBe('UNKNOWN');
  });
});
