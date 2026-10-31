import { describe, expect, it } from 'vitest';
import type { TrustEntry } from '@chef/contracts';
import { canRemove, expiresWithin, expiryText, groupLabelKey, sortTrust } from './trustModel';

const entry = (over: Partial<TrustEntry>): TrustEntry => ({
  subject: 'CN=X',
  issuer: 'CN=X',
  notAfter: '2040-01-01T00:00:00+00:00',
  fingerprintSha256: 'a'.repeat(64),
  group: 'vn-public-ca',
  source: 'bundled',
  ...over,
});

describe('trust list', () => {
  it('shows bundled roots first, by group, then the user entries', () => {
    const sorted = sortTrust([
      entry({ subject: 'CN=Mine', group: 'user', source: 'user' }),
      entry({ subject: 'CN=Gov', group: 'vn-gov-ca' }),
      entry({ subject: 'CN=Public B', group: 'vn-public-ca' }),
      entry({ subject: 'CN=Public A', group: 'vn-public-ca' }),
    ]);
    expect(sorted.map((e) => e.subject)).toEqual([
      'CN=Public A',
      'CN=Public B',
      'CN=Gov',
      'CN=Mine',
    ]);
  });

  it('allows removing only the user entries', () => {
    expect(canRemove(entry({ source: 'bundled' }))).toBe(false);
    expect(canRemove(entry({ source: 'user', group: 'user' }))).toBe(true);
  });

  it('has a label key for every group', () => {
    expect(groupLabelKey('vn-public-ca')).toBe('sig.trust.group.publicCa');
    expect(groupLabelKey('vn-gov-ca')).toBe('sig.trust.group.govCa');
    expect(groupLabelKey('user')).toBe('sig.trust.group.user');
  });

  it('formats expiry dates and flags roots that expire soon', () => {
    expect(expiryText('2040-01-02T12:00:00+00:00', 'Asia/Ho_Chi_Minh')).toBe('02/01/2040');
    expect(expiryText('not a date')).toBe('not a date');
    const now = new Date('2026-11-01T00:00:00Z');
    expect(expiresWithin('2026-12-01T00:00:00Z', 60, now)).toBe(true);
    expect(expiresWithin('2030-01-01T00:00:00Z', 60, now)).toBe(false);
    expect(expiresWithin('garbage', 60, now)).toBe(false);
  });
});
