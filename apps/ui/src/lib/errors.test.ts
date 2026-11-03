import { describe, expect, it } from 'vitest';
import { ChefError, objectErrorCode, redactionLeaks, textErrorCode, toChefError } from './errors';

describe('textErrorCode', () => {
  it('maps the core message of a text error to its code', () => {
    const e = toChefError({
      name: 'RpcError',
      code: -32602,
      message: 'TEXT_GLYPH_MISSING',
      data: { kind: 'INVALID_PARAMS', detail: { missing: ['ệ'] } },
    });
    expect(textErrorCode(e)).toBe('TEXT_GLYPH_MISSING');
    expect(textErrorCode(new Error('PARAGRAPH_SHARES_RUN'))).toBe('PARAGRAPH_SHARES_RUN');
    expect(textErrorCode(new Error('DISK_FULL'))).toBeNull();
  });
});

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

describe('objectErrorCode', () => {
  it('maps the core message of an INVALID_PARAMS error to its object code', () => {
    const e = toChefError({
      name: 'RpcError',
      code: -32602,
      message: 'OVERLAPPING_OBJECTS',
      data: { kind: 'INVALID_PARAMS', detail: { ids: [] } },
    });
    expect(objectErrorCode(e)).toBe('OVERLAPPING_OBJECTS');
    expect(objectErrorCode(new Error('STALE_OBJECT_IDS'))).toBe('STALE_OBJECT_IDS');
  });

  it('returns null for other errors', () => {
    expect(objectErrorCode(new Error('Something else'))).toBeNull();
    expect(objectErrorCode({ message: 'NOT_A_CODE', data: { kind: 'INVALID_PARAMS' } })).toBeNull();
  });
});

describe('redactionLeaks', () => {
  it('lists the leaks of a failed redaction check', () => {
    const e = toChefError({
      code: -32000,
      message: 'Redacted text is still present',
      data: {
        kind: 'REDACTION_VERIFY_FAILED',
        detail: { leaks: [{ where: 'page 2 text', pattern: 'cccd' }] },
      },
    });
    expect(redactionLeaks(e)).toEqual([{ where: 'page 2 text', pattern: 'cccd' }]);
  });

  it('returns null for other errors and an empty list without details', () => {
    expect(redactionLeaks(new Error('PASSWORD_REQUIRED'))).toBeNull();
    expect(redactionLeaks(toChefError(new Error('REDACTION_VERIFY_FAILED')))).toEqual([]);
  });
});
