import { describe, expect, it } from 'vitest';
import {
  EMPTY_METADATA,
  attachmentNames,
  extractImagesParams,
  formFromMetadata,
  imageTemplateProblem,
  metadataParams,
  metadataProblem,
  pagesFromField,
  parseRepairData,
  repairOutputPath,
  savedPercent,
  sortAttachments,
  webSourcePath,
} from './docToolsModel';

describe('metadata form', () => {
  it('maps the Info values and keeps unknown keys as custom entries', () => {
    const f = formFromMetadata({ Title: 'Hợp đồng', Author: 'An', Dept: 'Kế toán' });
    expect(f.Title).toBe('Hợp đồng');
    expect(f.Author).toBe('An');
    expect(f.Subject).toBe('');
    expect(f.custom).toEqual([{ key: 'Dept', value: 'Kế toán' }]);
  });

  it('accepts an empty form and ISO dates', () => {
    expect(metadataProblem(EMPTY_METADATA)).toBeNull();
    expect(
      metadataProblem({ ...EMPTY_METADATA, CreationDate: '2024-03-01T09:30:00+07:00' }),
    ).toBeNull();
  });

  it('rejects a bad date, bad or duplicate custom keys and long values', () => {
    expect(metadataProblem({ ...EMPTY_METADATA, ModDate: '01/03/2024' })).toBe('date');
    expect(metadataProblem({ ...EMPTY_METADATA, custom: [{ key: 'Dept Name', value: 'x' }] })).toBe(
      'customKey',
    );
    expect(metadataProblem({ ...EMPTY_METADATA, custom: [{ key: 'Title', value: 'x' }] })).toBe(
      'customKey',
    );
    expect(
      metadataProblem({
        ...EMPTY_METADATA,
        custom: [
          { key: 'Dept', value: 'a' },
          { key: 'Dept', value: 'b' },
        ],
      }),
    ).toBe('duplicateKey');
    expect(metadataProblem({ ...EMPTY_METADATA, Title: 'x'.repeat(2001) })).toBe('length');
  });

  it('builds setMetadata params: empty values mean removal, custom trimmed', () => {
    const p = metadataParams({
      ...EMPTY_METADATA,
      Title: ' Báo cáo ',
      CreationDate: '',
      custom: [{ key: ' Dept ', value: ' Kế toán ' }],
    });
    expect(p).toMatchObject({
      title: 'Báo cáo',
      author: '',
      creationDate: '',
      custom: { Dept: 'Kế toán' },
    });
  });

  it('clear sends only the clear flag', () => {
    expect(metadataParams(EMPTY_METADATA, true)).toEqual({ clear: true });
  });
});

describe('attachments', () => {
  const rows = [
    { name: 'b.txt', size: 1, description: '' },
    { name: 'A.pdf', size: 2, description: '' },
  ];

  it('sorts by name', () => {
    expect(sortAttachments(rows).map((r) => r.name)).toEqual(['A.pdf', 'b.txt']);
  });

  it('acts on the selection, or on all when nothing is selected', () => {
    expect(attachmentNames(rows, new Set())).toEqual(['b.txt', 'A.pdf']);
    expect(attachmentNames(rows, new Set(['A.pdf']))).toEqual(['A.pdf']);
  });
});

describe('extract images and text', () => {
  it('reads a page field as 0-based pages, empty means all', () => {
    expect(pagesFromField('', 10)).toEqual({ ok: true, pages: undefined });
    expect(pagesFromField('1,3-4', 10)).toEqual({ ok: true, pages: [0, 2, 3] });
    expect(pagesFromField('12', 10)).toEqual({ ok: false });
  });

  it('checks the image name template', () => {
    expect(imageTemplateProblem('{page}_{index}')).toBeNull();
    expect(imageTemplateProblem('  ')).toBe('empty');
    expect(imageTemplateProblem('a/b')).toBe('separator');
    expect(imageTemplateProblem('a:b')).toBe('invalidChars');
    expect(imageTemplateProblem('x'.repeat(81))).toBe('long');
  });

  it('builds the image params without pages when all pages are wanted', () => {
    expect(extractImagesParams('/out', undefined, ' {page} ')).toEqual({
      outputDir: '/out',
      nameTemplate: '{page}',
    });
    expect(extractImagesParams('/out', [0], '{page}')).toMatchObject({ pages: [0] });
  });
});

describe('optimise for web and repair', () => {
  it('needs a saved, clean source file', () => {
    expect(webSourcePath({ sourcePath: null, dirty: false, signed: false })).toBeNull();
    expect(webSourcePath({ sourcePath: '/d/a.pdf', dirty: true, signed: false })).toBeNull();
    expect(webSourcePath({ sourcePath: '/d/a.pdf', dirty: false, signed: true })).toBeNull();
    expect(webSourcePath({ sourcePath: '/d/a.pdf', dirty: false, signed: false })).toBe('/d/a.pdf');
  });

  it('reports the saved percentage only when the file shrank', () => {
    expect(savedPercent(1000, 400)).toBe(60);
    expect(savedPercent(1000, 1200)).toBe(0);
    expect(savedPercent(0, 10)).toBe(0);
  });

  it('names the repaired copy next to the damaged file', () => {
    expect(repairOutputPath('/d/hong.pdf')).toBe('/d/hong_sua.pdf');
    expect(repairOutputPath('C:\\d\\HONG.PDF')).toBe('C:\\d\\HONG_sua.pdf');
  });

  it('parses the repair data', () => {
    expect(parseRepairData({ recovered: true, pageCount: 3, warnings: ['x', 2] })).toEqual({
      recovered: true,
      pageCount: 3,
      warnings: ['x'],
    });
    expect(parseRepairData(null)).toEqual({ recovered: false, pageCount: 0, warnings: [] });
  });
});
