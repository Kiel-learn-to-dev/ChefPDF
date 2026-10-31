import { describe, expect, it } from 'vitest';
import type { SignatureReason, SignatureVerifyItem } from '@chef/contracts';
import {
  REASON_TEXT,
  STATUS_ORDER,
  chainView,
  chipSummary,
  commonNameOf,
  formatDateTime,
  reasonText,
  signerOf,
  sortBySeverity,
  summaryOf,
} from './verifyModel';

/** The eleven reason codes the core can send (spec of T3.08). */
const ALL_REASONS: SignatureReason[] = [
  'INTEGRITY_FAILED',
  'MODIFIED_AFTER_SIGNING',
  'CERT_UNTRUSTED',
  'CERT_EXPIRED_AT_SIGNING',
  'CERT_EXPIRED_NOW',
  'CERT_REVOKED',
  'REVOCATION_UNKNOWN',
  'DOCMDP_VIOLATION',
  'TIMESTAMP_INVALID',
  'SIGNATURE_UNREADABLE',
  'UNSIGNED_FIELD',
];

function item(over: Partial<SignatureVerifyItem> = {}): SignatureVerifyItem {
  return {
    fieldName: 'Signature1',
    status: 'valid',
    reasons: [],
    summaryVi: 'Chữ ký hợp lệ.',
    summaryEn: 'The signature is valid.',
    revisionIndex: 1,
    subFilter: 'adbe.pkcs7.detached',
    level: 'B-B',
    digestAlgorithm: 'sha256',
    signerName: 'Nguyễn Văn An',
    signerCert: null,
    signingTime: '2026-10-31T01:02:03+00:00',
    timestampTime: null,
    timestampOk: null,
    coversWholeDocument: true,
    modificationLevel: 'none',
    docMdp: null,
    chain: [],
    revocation: [],
    ...over,
  };
}

describe('status ordering', () => {
  it('puts the most severe status first and keeps the order inside one status', () => {
    const items = [
      item({ fieldName: 'a', status: 'valid' }),
      item({ fieldName: 'b', status: 'unsigned' }),
      item({ fieldName: 'c', status: 'invalid' }),
      item({ fieldName: 'd', status: 'valid' }),
      item({ fieldName: 'e', status: 'unknown' }),
      item({ fieldName: 'f', status: 'valid-with-warnings' }),
    ];
    expect(sortBySeverity(items).map((i) => i.fieldName)).toEqual(['c', 'e', 'f', 'a', 'd', 'b']);
    expect(STATUS_ORDER).toEqual([
      'invalid',
      'unknown',
      'valid-with-warnings',
      'valid',
      'unsigned',
    ]);
  });
});

describe('reason mapping', () => {
  it('maps every reason code to both languages', () => {
    for (const code of ALL_REASONS) {
      expect(REASON_TEXT[code].vi.length, code).toBeGreaterThan(0);
      expect(REASON_TEXT[code].en.length, code).toBeGreaterThan(0);
    }
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...ALL_REASONS].sort());
  });

  it('falls back to the code for an unknown reason', () => {
    expect(reasonText('SOMETHING_NEW', 'vi')).toBe('SOMETHING_NEW');
    expect(reasonText('CERT_REVOKED', 'en')).toBe('the certificate has been revoked');
  });

  it('prefers the core summary and falls back to the translated reasons', () => {
    expect(summaryOf(item(), 'vi')).toBe('Chữ ký hợp lệ.');
    const broken = item({
      status: 'invalid',
      reasons: ['INTEGRITY_FAILED', 'MODIFIED_AFTER_SIGNING'],
      summaryVi: '',
      summaryEn: '',
    });
    expect(summaryOf(broken, 'en')).toBe(
      'the signed content was changed; the document changed after signing',
    );
    expect(summaryOf(item({ summaryVi: 'Tóm tắt của lõi.' }), 'vi')).toBe('Tóm tắt của lõi.');
  });
});

describe('chip summary', () => {
  it('reports the most severe state', () => {
    expect(chipSummary([item()])).toEqual({ tone: 'ok', key: 'sig.chip.valid', count: 1 });
    expect(chipSummary([item(), item({ status: 'valid' })])?.count).toBe(2);
    expect(chipSummary([item(), item({ status: 'invalid' })])).toEqual({
      tone: 'bad',
      key: 'sig.chip.invalid',
      count: 1,
    });
    expect(chipSummary([item({ status: 'unknown' }), item()])?.key).toBe('sig.chip.unknown');
    expect(chipSummary([item({ status: 'valid-with-warnings' })])?.tone).toBe('warn');
  });

  it('has no chip when nothing is signed', () => {
    expect(chipSummary([])).toBeNull();
    expect(chipSummary([item({ status: 'unsigned' })])).toBeNull();
  });
});

describe('date formatting', () => {
  it('formats in Ho Chi Minh time for Vietnamese and English', () => {
    const iso = '2026-10-31T01:02:03+00:00'; // 08:02:03 in UTC+7
    expect(formatDateTime(iso, 'vi', 'Asia/Ho_Chi_Minh')).toBe('31/10/2026 08:02:03');
    expect(formatDateTime(iso, 'en', 'Asia/Ho_Chi_Minh')).toBe('31/10/2026 08:02:03');
  });

  it('returns null for missing or invalid values', () => {
    expect(formatDateTime(null, 'vi')).toBeNull();
    expect(formatDateTime('', 'vi')).toBeNull();
    expect(formatDateTime('not a date', 'en')).toBeNull();
  });
});

describe('labels and chain', () => {
  it('names the signer from the certificate, then the field', () => {
    expect(signerOf(item())).toBe('Nguyễn Văn An');
    expect(signerOf(item({ signerName: null, signerCert: null, fieldName: 'Signature3' }))).toBe(
      'Signature3',
    );
  });

  it('keeps the chain order and the trusted flags', () => {
    const rows = chainView(
      item({
        chain: [
          { subject: 'CN=Leaf', issuer: 'CN=Root', notBefore: '', notAfter: '', trusted: false },
          { subject: 'CN=Root', issuer: 'CN=Root', notBefore: '', notAfter: '', trusted: true },
        ],
      }),
    );
    expect(rows).toEqual([
      { subject: 'CN=Leaf', issuer: 'CN=Root', trusted: false },
      { subject: 'CN=Root', issuer: 'CN=Root', trusted: true },
    ]);
  });

  it('extracts the common name from an RFC 4514 string', () => {
    expect(commonNameOf('O=Công ty,CN=Nguyễn Văn An,C=VN')).toBe('Nguyễn Văn An');
    expect(commonNameOf('O=Only org')).toBe('O=Only org');
  });
});
