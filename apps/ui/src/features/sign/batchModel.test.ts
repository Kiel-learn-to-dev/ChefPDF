import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_FILES,
  addBatchPaths,
  batchErrorKey,
  retryPaths,
  suffixOutputName,
  suffixProblem,
  summarize,
  verificationTone,
  type BatchItem,
} from './batchModel';

const item = (
  path: string,
  status: BatchItem['status'],
  over: Partial<BatchItem> = {},
): BatchItem => ({
  path,
  outputPath: status === 'signed' ? `${path}.out` : null,
  status,
  errorKind: status === 'failed' ? 'SIGN_FAILED' : null,
  message: null,
  fieldName: null,
  page: null,
  verification: null,
  warnings: [],
  ...over,
});

describe('addBatchPaths', () => {
  it('adds new files and skips duplicates, ignoring case', () => {
    const first = addBatchPaths([], ['C:/a/x.pdf', 'C:/a/y.pdf']);
    expect(first.added).toBe(2);
    const second = addBatchPaths(first.rows, ['c:/A/X.PDF', 'C:/a/z.pdf']);
    expect(second.duplicates).toBe(1);
    expect(second.rows.map((r) => r.name)).toEqual(['x.pdf', 'y.pdf', 'z.pdf']);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: MAX_BATCH_FILES + 5 }, (_, i) => `C:/f/${i}.pdf`);
    const r = addBatchPaths([], many);
    expect(r.rows).toHaveLength(MAX_BATCH_FILES);
    expect(r.overLimit).toBe(true);
  });
});

describe('suffix rule', () => {
  it('names the output next to the input', () => {
    expect(suffixOutputName('C:\\hd\\hopdong.pdf', '_da-ky')).toBe('hopdong_da-ky.pdf');
    expect(suffixOutputName('/home/a/Bao cao.PDF', '_signed')).toBe('Bao cao_signed.pdf');
    expect(suffixOutputName('/a/noext', '_x')).toBe('noext_x.pdf');
  });

  it('refuses empty suffixes and path characters', () => {
    expect(suffixProblem('   ')).toBe('empty');
    expect(suffixProblem('_a/b')).toBe('separator');
    expect(suffixProblem('_a:b')).toBe('invalidChars');
    expect(suffixProblem('_da-ky')).toBeNull();
    expect(suffixProblem('x'.repeat(41))).toBe('long');
  });
});

describe('results', () => {
  const items = [
    item('a.pdf', 'signed', { verification: { status: 'unknown', reasons: [] } }),
    item('b.pdf', 'failed'),
    item('c.pdf', 'skipped'),
  ];

  it('summarises by status', () => {
    expect(summarize(items)).toEqual({ total: 3, signed: 1, failed: 1, skipped: 1 });
  });

  it('retries everything that did not sign', () => {
    expect(retryPaths(items)).toEqual(['b.pdf', 'c.pdf']);
  });

  it('maps errors to i18n keys, unknown kinds to a generic message', () => {
    expect(batchErrorKey('TOKEN_PIN_INVALID')).toBe('errors.TOKEN_PIN_INVALID');
    expect(batchErrorKey(null)).toBe('signBatch.errUnknown');
  });

  it('tones the verification badge', () => {
    expect(verificationTone({ status: 'valid', reasons: [] })).toBe('ok');
    expect(verificationTone({ status: 'unknown', reasons: [] })).toBe('warn');
    expect(verificationTone({ status: 'invalid', reasons: [] })).toBe('bad');
    expect(verificationTone(null)).toBe('none');
  });
});
