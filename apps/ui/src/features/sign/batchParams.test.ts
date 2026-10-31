import { describe, expect, it } from 'vitest';
import { DEFAULT_ANCHOR_FORM, DEFAULT_FIXED_FORM } from './anchorModel';
import { addBatchPaths } from './batchModel';
import { batchProblem, buildBatchParams, type BatchForm } from './batchParams';

const BASE: BatchForm = {
  signer: { kind: 'pfx', pfxPath: 'C:/ky.pfx', password: 'pw-secret' },
  level: 'B-B',
  digest: 'sha256',
  tsaUrls: [],
  reason: ' Duyệt ',
  location: '',
  contact: '',
  certify: 'none',
  placement: { mode: 'invisible' },
  outputMode: 'suffix',
  suffix: '_da-ky',
  folder: null,
  stopOnError: false,
  verifyAfter: true,
  overwriteConfirmed: false,
};

const FILES = addBatchPaths([], ['C:/hd/a.pdf', 'C:/hd/khoa.pdf']).rows;

describe('batchProblem', () => {
  it('accepts the base form', () => {
    expect(batchProblem(FILES, BASE)).toBeNull();
  });

  it('asks for files, a timestamp server, a suffix, a folder and the overwrite confirmation', () => {
    expect(batchProblem([], BASE)).toBe('noFiles');
    expect(batchProblem(FILES, { ...BASE, level: 'B-LT' })).toBe('noTsa');
    expect(batchProblem(FILES, { ...BASE, suffix: '   ' })).toBe('badSuffix');
    expect(batchProblem(FILES, { ...BASE, outputMode: 'folder' })).toBe('noFolder');
    expect(batchProblem(FILES, { ...BASE, outputMode: 'overwrite' })).toBe('noOverwriteConfirm');
    expect(
      batchProblem(FILES, { ...BASE, outputMode: 'overwrite', overwriteConfirmed: true }),
    ).toBeNull();
  });

  it('checks the rectangle and the anchor text', () => {
    expect(
      batchProblem(FILES, { ...BASE, placement: { mode: 'rect', page: 0, rect: [10, 10, 5, 50] } }),
    ).toBe('badRect');
    expect(
      batchProblem(FILES, {
        ...BASE,
        placement: { mode: 'anchor', form: { ...DEFAULT_ANCHOR_FORM, text: '  ' } },
      }),
    ).toBe('noAnchorText');
  });
});

describe('buildBatchParams', () => {
  it('builds the pfx batch with per-file passwords, suffix output and the options', () => {
    const files = addBatchPaths([], ['C:/hd/a.pdf']).rows.map((r) => ({
      ...r,
      password: 'file-pw',
    }));
    const p = buildBatchParams(files, BASE);
    expect(p).toEqual({
      files: [{ path: 'C:/hd/a.pdf', password: 'file-pw' }],
      signer: { kind: 'pfx', pfxPath: 'C:/ky.pfx', password: 'pw-secret' },
      common: { level: 'B-B', digest: 'sha256', reason: 'Duyệt' },
      output: { mode: 'suffix', suffix: '_da-ky' },
      stopOnError: false,
      verifyAfter: true,
    });
  });

  it('builds the token batch once for all files, with the PIN and the final-try flag', () => {
    const p = buildBatchParams(FILES, {
      ...BASE,
      signer: { kind: 'token', modulePath: 'C:/d.dll', slotId: 2, certId: 'ab', pin: '135790' },
      confirmFinalTry: true,
      tsaUrls: ['https://tsa.example.vn/'],
      level: 'B-T',
      outputMode: 'folder',
      folder: 'D:/out',
      placement: { mode: 'fixed', form: DEFAULT_FIXED_FORM },
    });
    expect(p.signer).toEqual({
      kind: 'token',
      modulePath: 'C:/d.dll',
      certId: 'ab',
      pin: '135790',
      slotId: 2,
      confirmFinalTry: true,
    });
    expect(p.common).toMatchObject({ level: 'B-T', tsaUrls: ['https://tsa.example.vn/'] });
    expect(p.output).toEqual({ mode: 'folder', folder: 'D:/out' });
    expect(p.placement).toMatchObject({ kind: 'fixed', corner: 'bottom-right', page: 'last' });
    expect(p.files).toHaveLength(2);
  });

  it('builds an anchor and a rect placement, and overwrite output', () => {
    const anchor = buildBatchParams(FILES, {
      ...BASE,
      placement: { mode: 'anchor', form: { ...DEFAULT_ANCHOR_FORM, text: 'GIÁM ĐỐC' } },
    });
    expect(anchor.placement).toMatchObject({
      kind: 'anchor',
      text: 'GIÁM ĐỐC',
      whichMatch: 'first',
    });
    const rect = buildBatchParams(FILES, {
      ...BASE,
      outputMode: 'overwrite',
      overwriteConfirmed: true,
      placement: { mode: 'rect', page: 0, rect: [50, 50, 250, 100] },
    });
    expect(rect.placement).toEqual({ kind: 'rect', page: 0, rect: [50, 50, 250, 100] });
    expect(rect.output).toEqual({ mode: 'overwrite' });
  });

  it('never puts the PIN into the file list', () => {
    const p = buildBatchParams(FILES, {
      ...BASE,
      signer: { kind: 'token', modulePath: 'x', slotId: 1, certId: 'a', pin: '999111' },
    });
    expect(JSON.stringify(p.files)).not.toContain('999111');
  });
});
