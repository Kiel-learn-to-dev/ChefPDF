import { describe, expect, it } from 'vitest';
import type { CertIdentity, CertInfoData } from '@chef/contracts';
import {
  certCardView,
  expiryLevel,
  fingerprintShort,
  formatDateTime,
  identityLines,
} from './certModel';

const NO_IDENTITY: CertIdentity = {
  taxCode: null,
  citizenId: null,
  budgetCode: null,
  organization: null,
  personName: null,
};

function info(over: Partial<CertInfoData> = {}): CertInfoData {
  return {
    subjectCommonName: 'Nguyễn Văn An',
    issuerCommonName: 'Test CA',
    subject: 'CN=Nguyễn Văn An',
    issuer: 'CN=Test CA',
    serial: '01AB',
    notBefore: '2026-01-01T00:00:00+00:00',
    notAfter: '2028-01-01T00:00:00+00:00',
    daysUntilExpiry: 700,
    expired: false,
    expiringSoon: false,
    keyUsage: ['digitalSignature', 'nonRepudiation'],
    keyAlgorithm: 'RSA',
    keySize: 2048,
    fingerprintSha256: 'ab cd:ef01234567890123456789',
    identity: NO_IDENTITY,
    ...over,
  };
}

describe('expiryLevel', () => {
  it('is none, soon, or expired; expired wins over expiring soon', () => {
    expect(expiryLevel({ expired: false, expiringSoon: false })).toBe('none');
    expect(expiryLevel({ expired: false, expiringSoon: true })).toBe('soon');
    expect(expiryLevel({ expired: true, expiringSoon: true })).toBe('expired');
    expect(expiryLevel({ expired: true, expiringSoon: false })).toBe('expired');
  });
});

describe('identityLines', () => {
  it('lists only the values that exist, in a fixed order', () => {
    expect(
      identityLines({
        taxCode: '0101234567',
        citizenId: null,
        budgetCode: null,
        organization: 'Công ty ABC',
        personName: 'Nguyễn Văn An',
      }),
    ).toEqual([
      { key: 'personName', value: 'Nguyễn Văn An' },
      { key: 'organization', value: 'Công ty ABC' },
      { key: 'taxCode', value: '0101234567' },
    ]);
  });

  it('is empty when the certificate carries no identifiers', () => {
    expect(identityLines(NO_IDENTITY)).toEqual([]);
  });
});

describe('formatDateTime', () => {
  it('formats dd/MM/yyyy HH:mm in local time', () => {
    const iso = new Date(2027, 0, 5, 9, 7).toISOString();
    expect(formatDateTime(iso)).toBe('05/01/2027 09:07');
  });

  it('returns invalid input unchanged', () => {
    expect(formatDateTime('không phải ngày')).toBe('không phải ngày');
  });
});

describe('fingerprintShort', () => {
  it('keeps the first 16 hex digits in pairs, upper-cased', () => {
    expect(fingerprintShort('ab cd:ef01234567890123456789')).toBe('AB:CD:EF:01:23:45:67:89');
    expect(fingerprintShort('')).toBe('');
  });
});

describe('certCardView', () => {
  it('uses the common name as title and the identifiers as lines', () => {
    const view = certCardView(
      info({ identity: { ...NO_IDENTITY, taxCode: '0101234567', personName: 'Nguyễn Văn An' } }),
    );
    expect(view.title).toBe('Nguyễn Văn An');
    expect(view.issuer).toBe('Test CA');
    expect(view.expiry).toBe('none');
    expect(view.identity.map((l) => l.key)).toEqual(['personName', 'taxCode']);
    expect(view.validTo).toBe(formatDateTime('2028-01-01T00:00:00+00:00'));
  });

  it('falls back to the full subject when there is no common name', () => {
    expect(certCardView(info({ subjectCommonName: null })).title).toBe('CN=Nguyễn Văn An');
  });

  it('marks an expiring or expired certificate', () => {
    expect(certCardView(info({ expiringSoon: true, daysUntilExpiry: 10 })).expiry).toBe('soon');
    const expired = certCardView(info({ expired: true, daysUntilExpiry: -3 }));
    expect(expired.expiry).toBe('expired');
    expect(expired.daysLeft).toBe(-3);
  });
});
