import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGES_TO_PDF,
  DEFAULT_PDF_TO_IMAGES,
  addImages,
  defaultPdfName,
  imagesToPdfIssues,
  imagesToPdfParams,
  moveItem,
  pdfToImagesIssues,
  pdfToImagesParams,
} from './convertModel';

describe('pdfToImagesParams', () => {
  const form = { ...DEFAULT_PDF_TO_IMAGES, outputDir: 'D:/out' };

  it('sends the contract fields and the 0-based pages', () => {
    const p = pdfToImagesParams(form, { path: 'D:/a.pdf', pages: [0, 2] });
    expect(p).toEqual({
      path: 'D:/a.pdf',
      format: 'png',
      dpi: 150,
      color: 'color',
      multiPageTiff: false,
      outputDir: 'D:/out',
      nameTemplate: '{name}_{page}',
      pages: [0, 2],
    });
  });

  it('jpegQuality only for JPEG and WebP; multi-page TIFF only for TIFF', () => {
    const jpeg = pdfToImagesParams(
      { ...form, format: 'jpeg', multiPageTiff: true },
      { path: 'x.pdf' },
    );
    expect(jpeg.jpegQuality).toBe(90);
    expect(jpeg.multiPageTiff).toBe(false);
    const tiff = pdfToImagesParams(
      { ...form, format: 'tiff', multiPageTiff: true },
      { path: 'x.pdf' },
    );
    expect(tiff.multiPageTiff).toBe(true);
    expect('jpegQuality' in tiff).toBe(false);
  });

  it('names the files after the document, not after the working copy it is read from', () => {
    // The dialog reads rev-0000.pdf (the current revision); {name} must still be the document name.
    const p = pdfToImagesParams(form, {
      path: 'C:/sessions/s1/rev-0000.pdf',
      docName: 'Hợp đồng {1}.pdf',
    });
    expect(p.nameTemplate).toBe('Hợp đồng _1__{page}');
  });

  it('keeps {name} for the core when no document name is given', () => {
    expect(pdfToImagesParams(form, { path: 'x.pdf' }).nameTemplate).toBe('{name}_{page}');
  });

  it('passes the password only when given and leaves the pages out when empty', () => {
    const p = pdfToImagesParams(form, { path: 'x.pdf', password: 'pw', pages: [] });
    expect(p.password).toBe('pw');
    expect('pages' in p).toBe(false);
  });
});

describe('pdfToImagesIssues', () => {
  it('needs an output folder, a dpi in range and a usable name template', () => {
    expect(pdfToImagesIssues(DEFAULT_PDF_TO_IMAGES)).toEqual(['outputDir']);
    const bad = {
      ...DEFAULT_PDF_TO_IMAGES,
      outputDir: 'x',
      dpi: 1000,
      jpegQuality: 0,
      nameTemplate: 'a/b',
    };
    expect(pdfToImagesIssues(bad)).toEqual(['dpi', 'quality', 'nameTemplate']);
    expect(pdfToImagesIssues({ ...DEFAULT_PDF_TO_IMAGES, outputDir: 'x' })).toEqual([]);
  });
});

describe('imagesToPdf', () => {
  it('flags missing images, missing output and a bad custom size', () => {
    expect(imagesToPdfIssues(DEFAULT_IMAGES_TO_PDF, [], '')).toEqual(['images', 'output']);
    const custom = { ...DEFAULT_IMAGES_TO_PDF, pageSize: 'custom' as const, customWidthMm: 0 };
    expect(imagesToPdfIssues(custom, ['a.png'], 'o.pdf')).toEqual(['custom']);
    expect(
      imagesToPdfIssues({ ...DEFAULT_IMAGES_TO_PDF, marginMm: 500 }, ['a.png'], 'o.pdf'),
    ).toEqual(['margin']);
  });

  it('keeps the image order and adds the custom size only for custom pages', () => {
    const p = imagesToPdfParams(DEFAULT_IMAGES_TO_PDF, ['b.png', 'a.jpg'], 'o.pdf');
    expect(p.images).toEqual(['b.png', 'a.jpg']);
    expect('customWidthMm' in p).toBe(false);
    const c = imagesToPdfParams(
      { ...DEFAULT_IMAGES_TO_PDF, pageSize: 'custom' },
      ['a.png'],
      'o.pdf',
    );
    expect(c).toMatchObject({ customWidthMm: 210, customHeightMm: 297 });
  });
});

describe('list helpers', () => {
  it('moveItem moves and clamps', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a'], 3, 0)).toEqual(['a']);
  });

  it('addImages keeps order, skips duplicates and non-images', () => {
    expect(addImages(['a.png'], ['b.JPG', 'a.png', 'notes.txt', 'c.jpeg'])).toEqual([
      'a.png',
      'b.JPG',
      'c.jpeg',
    ]);
  });

  it('defaultPdfName uses the first image name', () => {
    expect(defaultPdfName(['D:\\scan\\trang-1.png'])).toBe('trang-1.pdf');
    expect(defaultPdfName([])).toBe('images.pdf');
  });
});
