import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  EMPTY_PASSWORD_FORM,
  isAllowedAll,
  passwordStrength,
  protectionParams,
  setPermission,
  validatePasswords,
  type PasswordForm,
} from './securityModel';

const form = (patch: Partial<PasswordForm>): PasswordForm => ({
  ...EMPTY_PASSWORD_FORM,
  ...patch,
});

describe('setPermission', () => {
  it('turning off low-resolution printing also turns off high-resolution printing', () => {
    const next = setPermission(ALL_PERMISSIONS, 'printLowRes', false);
    expect(next.printLowRes).toBe(false);
    expect(next.printHighRes).toBe(false);
  });

  it('high-resolution printing can be enabled only together with low-resolution', () => {
    const off = setPermission(ALL_PERMISSIONS, 'printLowRes', false);
    const still = setPermission(off, 'printHighRes', true);
    expect(still.printHighRes).toBe(true);
    expect(still.printLowRes).toBe(false);
  });

  it('changes other flags only', () => {
    const next = setPermission(ALL_PERMISSIONS, 'copyContent', false);
    expect(next.copyContent).toBe(false);
    expect(next.printLowRes).toBe(true);
  });
});

describe('passwordStrength', () => {
  it('reports empty, weak, fair and strong', () => {
    expect(passwordStrength('')).toBe('empty');
    expect(passwordStrength('abc')).toBe('weak');
    expect(passwordStrength('abcdefgh')).toBe('weak');
    expect(passwordStrength('Abcdefgh1')).toBe('fair');
    expect(passwordStrength('Correct-Horse-9')).toBe('strong');
  });
});

describe('validatePasswords', () => {
  it('needs at least one password', () => {
    expect(validatePasswords(EMPTY_PASSWORD_FORM, ALL_PERMISSIONS)).toEqual(['noPassword']);
  });

  it('checks that the confirmation matches', () => {
    const issues = validatePasswords(
      form({ userPassword: 'secret1', userConfirm: 'secret2' }),
      ALL_PERMISSIONS,
    );
    expect(issues).toEqual(['userMismatch']);
  });

  it('checks the owner confirmation separately', () => {
    const issues = validatePasswords(
      form({ userPassword: 'a', userConfirm: 'a', ownerPassword: 'b', ownerConfirm: '' }),
      ALL_PERMISSIONS,
    );
    expect(issues).toEqual(['ownerMismatch']);
  });

  it('accepts a user password with matching confirmation', () => {
    expect(
      validatePasswords(form({ userPassword: 'x1y2z3', userConfirm: 'x1y2z3' }), ALL_PERMISSIONS),
    ).toEqual([]);
  });

  it('an owner password alone needs some restricted permission', () => {
    const owner = form({ ownerPassword: 'own3r', ownerConfirm: 'own3r' });
    expect(validatePasswords(owner, ALL_PERMISSIONS)).toEqual(['ownerNeedsRights']);
    const restricted = setPermission(ALL_PERMISSIONS, 'printLowRes', false);
    expect(validatePasswords(owner, restricted)).toEqual([]);
  });
});

describe('protectionParams', () => {
  it('leaves out empty passwords', () => {
    const p = protectionParams(
      form({ userPassword: 'open-me', userConfirm: 'open-me' }),
      ALL_PERMISSIONS,
    );
    expect(p).toEqual({ userPassword: 'open-me', permissions: ALL_PERMISSIONS });
    expect('ownerPassword' in p).toBe(false);
  });

  it('copies the permissions instead of sharing the object', () => {
    const p = protectionParams(form({ userPassword: 'a' }), ALL_PERMISSIONS);
    expect(p.permissions).not.toBe(ALL_PERMISSIONS);
  });
});

describe('isAllowedAll', () => {
  it('is false once any flag is off', () => {
    expect(isAllowedAll(ALL_PERMISSIONS)).toBe(true);
    expect(isAllowedAll({ ...ALL_PERMISSIONS, modify: false })).toBe(false);
  });
});
