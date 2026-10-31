import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_FOLDER_PDFS, pdfFilesOf } from '../src/main/pdfFiles';

describe('pdfFilesOf', () => {
  const dir = path.join(path.sep, 'hop', 'dong');

  it('keeps PDF names only (any case), sorted, joined to the folder', () => {
    expect(pdfFilesOf(['b.pdf', 'a.PDF', 'notes.txt', 'c.pdf.bak', '.hidden.pdf'], dir)).toEqual([
      path.join(dir, 'a.PDF'),
      path.join(dir, 'b.pdf'),
    ]);
  });

  it('returns nothing for a folder without PDFs', () => {
    expect(pdfFilesOf(['x.docx'], dir)).toEqual([]);
  });

  it('caps the number of files', () => {
    const names = Array.from({ length: MAX_FOLDER_PDFS + 10 }, (_, i) => `f${i}.pdf`);
    expect(pdfFilesOf(names, dir)).toHaveLength(MAX_FOLDER_PDFS);
  });
});
