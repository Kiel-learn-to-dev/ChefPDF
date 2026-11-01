/**
 * Pure model of the password & permissions dialog (J1, J2; T5.01).
 * Passwords stay in memory: this module never stores, logs or serializes them.
 */
import type { PermissionFlags } from '@chef/contracts';

export const PERMISSION_KEYS = [
  'printLowRes',
  'printHighRes',
  'copyContent',
  'modify',
  'annotate',
  'fillForms',
  'assemble',
  'accessibility',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type Permissions = Required<PermissionFlags>;

export const ALL_PERMISSIONS: Permissions = {
  printLowRes: true,
  printHighRes: true,
  copyContent: true,
  modify: true,
  annotate: true,
  fillForms: true,
  assemble: true,
  accessibility: true,
};

/** Printing at high resolution needs low resolution printing (core rule). */
export function setPermission(p: Permissions, key: PermissionKey, value: boolean): Permissions {
  const next = { ...p, [key]: value };
  if (key === 'printLowRes' && !value) next.printHighRes = false;
  return next;
}

export type Strength = 'empty' | 'weak' | 'fair' | 'strong';

/** Simple length and character-class score. A hint only, not a security guarantee. */
export function passwordStrength(pw: string): Strength {
  if (!pw) return 'empty';
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 2) return 'weak';
  if (score <= 4) return 'fair';
  return 'strong';
}

export interface PasswordForm {
  userPassword: string;
  userConfirm: string;
  ownerPassword: string;
  ownerConfirm: string;
}

export const EMPTY_PASSWORD_FORM: PasswordForm = {
  userPassword: '',
  userConfirm: '',
  ownerPassword: '',
  ownerConfirm: '',
};

export type PasswordIssue = 'noPassword' | 'userMismatch' | 'ownerMismatch' | 'ownerNeedsRights';

/**
 * Validates the form. Returns the list of issues; an empty list means the protection can be applied.
 * `ownerNeedsRights`: an owner password alone (no user password) is allowed, but a user password
 * is needed when the permissions are restricted, otherwise nothing is enforced for readers.
 */
export function validatePasswords(f: PasswordForm, perms: Permissions): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  const user = f.userPassword;
  const owner = f.ownerPassword;
  if (!user && !owner) issues.push('noPassword');
  if (user && user !== f.userConfirm) issues.push('userMismatch');
  if (owner && owner !== f.ownerConfirm) issues.push('ownerMismatch');
  if (!user && owner && isAllowedAll(perms)) issues.push('ownerNeedsRights');
  return issues;
}

export function isAllowedAll(p: Permissions): boolean {
  return Object.values(p).every(Boolean);
}

export interface ProtectionParams {
  userPassword?: string;
  ownerPassword?: string;
  permissions: Permissions;
}

/** Params of security.encrypt. Empty passwords are left out (null in the contract). */
export function protectionParams(f: PasswordForm, perms: Permissions): ProtectionParams {
  const out: ProtectionParams = { permissions: { ...perms } };
  if (f.userPassword) out.userPassword = f.userPassword;
  if (f.ownerPassword) out.ownerPassword = f.ownerPassword;
  return out;
}

/** Message keys (under security.issue.*) for the issues. */
export function issueKey(issue: PasswordIssue): string {
  return `security.issue.${issue}`;
}
