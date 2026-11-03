import { describe, expect, it } from 'vitest';
import { exportParams, outputName } from './exportModel';

describe('document export', () => {
  it('suggests a distinct name and the chosen extension', () => {
    expect(outputName('Hợp đồng.pdf', 'docx')).toBe('Hợp đồng.docx');
    expect(outputName('Hợp đồng.pdf', 'pdf')).toBe('Hợp đồng_lam-moi.pdf');
  });

  it('passes the selected pages and document options', () => {
    expect(exportParams('docx', 'D:/output.docx', [0, 2], 'layout', true)).toEqual({
      format: 'docx',
      outputPath: 'D:/output.docx',
      replaceExisting: true,
      pages: [0, 2],
      options: { mode: 'layout', includeImages: true },
    });
  });
});
