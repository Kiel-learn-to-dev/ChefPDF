import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFY_FORM,
  countsByStatus,
  defaultReportPath,
  parseVerifyResult,
  verifyBatchParams,
  verifyProblem,
  withFormat,
  type VerifyForm,
} from './verifyBatchModel';

const filled = (over: Partial<VerifyForm> = {}): VerifyForm => ({
  ...DEFAULT_VERIFY_FORM,
  files: ['/d/a.pdf', '/d/b.pdf'],
  reportPath: '/d/bao-cao.csv',
  ...over,
});

describe('verifyProblem', () => {
  it('needs an input', () => {
    expect(verifyProblem({ ...filled(), files: [] })).toBe('noInput');
    expect(verifyProblem({ ...filled(), scope: 'folder', files: ['/x.pdf'] })).toBe('noInput');
  });

  it('needs a report path with the chosen extension', () => {
    expect(verifyProblem({ ...filled(), reportPath: null })).toBe('noReport');
    expect(verifyProblem({ ...filled(), reportPath: '   ' })).toBe('noReport');
    expect(verifyProblem({ ...filled(), reportPath: '/d/bao-cao.csv', format: 'xlsx' })).toBe(
      'extension',
    );
  });

  it('is null for a complete form, with a folder too', () => {
    expect(verifyProblem(filled())).toBeNull();
    expect(
      verifyProblem({
        ...filled(),
        scope: 'folder',
        folder: '/d',
        files: [],
        reportPath: '/r.xlsx',
        format: 'xlsx',
      }),
    ).toBeNull();
  });
});

describe('verifyBatchParams', () => {
  it('sends the file list with the revocation mode and format', () => {
    expect(verifyBatchParams(filled({ revocation: 'hard' }))).toEqual({
      files: [{ path: '/d/a.pdf' }, { path: '/d/b.pdf' }],
      checkRevocation: 'hard',
      reportPath: '/d/bao-cao.csv',
      format: 'csv',
    });
  });

  it('sends a folder with its recursive flag and no file list', () => {
    const p = verifyBatchParams(filled({ scope: 'folder', folder: '/d', recursive: true }));
    expect(p).toEqual({
      folder: '/d',
      recursive: true,
      checkRevocation: 'soft',
      reportPath: '/d/bao-cao.csv',
      format: 'csv',
    });
    expect(p).not.toHaveProperty('files');
  });

  it('adds the extra trust roots only when there are some', () => {
    expect(verifyBatchParams(filled())).not.toHaveProperty('trustRootPaths');
    expect(verifyBatchParams(filled({ trustRoots: ['/ca/root.pem'] }))).toMatchObject({
      trustRootPaths: ['/ca/root.pem'],
    });
  });
});

describe('report path helpers', () => {
  it('swaps the extension when the format changes', () => {
    expect(withFormat('/d/bao-cao.csv', 'xlsx')).toBe('/d/bao-cao.xlsx');
    expect(withFormat('C:\\Users\\a.b\\bao', 'csv')).toBe('C:\\Users\\a.b\\bao.csv');
    expect(withFormat(null, 'csv')).toBeNull();
  });

  it('builds a default report path in the folder', () => {
    expect(defaultReportPath('/d/out', 'csv')).toBe('/d/out/kiem-tra-chu-ky.csv');
    expect(defaultReportPath('C:\\out\\', 'xlsx')).toBe('C:\\out\\kiem-tra-chu-ky.xlsx');
  });
});

describe('summary', () => {
  it('lists statuses in order and leaves out zero counts', () => {
    expect(countsByStatus({ unsigned: 1, valid: 3, invalid: 0, odd: 2 })).toEqual([
      { status: 'valid', count: 3 },
      { status: 'unsigned', count: 1 },
      { status: 'odd', count: 2 },
    ]);
  });

  it('parses the core data and rejects other shapes', () => {
    const r = parseVerifyResult({
      files: 2,
      signatures: 1,
      byStatus: { valid: 1, unsigned: 1, bad: 'x' },
      reportPath: '/d/bao-cao.csv',
    });
    expect(r).toEqual({
      files: 2,
      signatures: 1,
      byStatus: { valid: 1, unsigned: 1 },
      reportPath: '/d/bao-cao.csv',
    });
    expect(parseVerifyResult({ files: 'two' })).toBeNull();
    expect(parseVerifyResult(null)).toBeNull();
  });
});
