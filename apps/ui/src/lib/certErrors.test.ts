import { describe, expect, it } from 'vitest';
import vi from '../i18n/vi.json';
import en from '../i18n/en.json';
import {
  CERT_ERROR_KINDS,
  ChefError,
  isPasswordProblem,
  isTokenPinProblem,
  toChefError,
} from './errors';

const errors = (vi as { errors: Record<string, string> }).errors;
const errorsEn = (en as { errors: Record<string, string> }).errors;

describe('certificate and token error mapping', () => {
  it('every token / signature error kind has a Vietnamese and an English message', () => {
    for (const kind of CERT_ERROR_KINDS) {
      expect(errors[kind], kind).toBeTypeOf('string');
      expect(errors[kind]!.length, kind).toBeGreaterThan(5);
      expect(errorsEn[kind], kind).toBeTypeOf('string');
    }
  });

  it('reads the kind of an RPC error from the token ops', () => {
    const e = toChefError({
      name: 'RpcError',
      code: -32000,
      message: 'PIN invalid',
      data: { kind: 'TOKEN_PIN_INVALID' },
    });
    expect(e).toBeInstanceOf(ChefError);
    expect(e.kind).toBe('TOKEN_PIN_INVALID');
    expect(isTokenPinProblem(e.kind)).toBe(true);
  });

  it('classifies password and PIN problems', () => {
    expect(isPasswordProblem('SIGN_BAD_PASSWORD')).toBe(true);
    expect(isPasswordProblem('PASSWORD_REQUIRED')).toBe(true);
    expect(isPasswordProblem('TOKEN_PIN_LOCKED')).toBe(false);
    expect(isTokenPinProblem('TOKEN_PIN_LOCKED')).toBe(true);
    expect(isTokenPinProblem('TOKEN_NOT_FOUND')).toBe(false);
  });

  it('keeps unknown kinds as UNKNOWN', () => {
    expect(toChefError({ message: 'x', data: { kind: 'TOKEN_MAGIC' } }).kind).toBe('UNKNOWN');
  });
});
