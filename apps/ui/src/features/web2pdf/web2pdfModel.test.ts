import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB2PDF_FORM,
  defaultPdfName,
  isWebSourceName,
  web2pdfIssues,
  web2pdfRequest,
  type Web2PdfForm,
} from './web2pdfModel';

const OUT = 'D:/out/bai.pdf';
const url: Web2PdfForm = {
  ...DEFAULT_WEB2PDF_FORM,
  source: 'https://example.com/bai',
  confirmed: true,
};

describe('web2pdfIssues', () => {
  it('is empty for a confirmed web page with an output file', () => {
    expect(web2pdfIssues(url, OUT)).toEqual([]);
  });

  it('asks for a source, a valid http(s) address and the confirmation', () => {
    expect(web2pdfIssues({ ...url, source: '' }, OUT)).toEqual(['source']);
    expect(web2pdfIssues({ ...url, source: 'ftp://x.test/a' }, OUT)).toEqual(['source']);
    expect(web2pdfIssues({ ...url, source: 'javascript:alert(1)' }, OUT)).toEqual(['source']);
    expect(web2pdfIssues({ ...url, confirmed: false }, OUT)).toEqual(['confirm']);
  });

  it('needs an output .pdf path and a margin from 0 to 50 mm', () => {
    expect(web2pdfIssues(url, '')).toEqual(['output']);
    expect(web2pdfIssues(url, 'D:/out/bai.docx')).toEqual(['output']);
    expect(web2pdfIssues({ ...url, marginMm: 51 }, OUT)).toEqual(['margin']);
    expect(web2pdfIssues({ ...url, marginMm: 2.5 }, OUT)).toEqual(['margin']);
  });

  it('does not ask for the confirmation for a local file', () => {
    const local: Web2PdfForm = { ...DEFAULT_WEB2PDF_FORM, kind: 'file', source: 'D:/notes/a.md' };
    expect(web2pdfIssues(local, OUT)).toEqual([]);
  });
});

describe('web2pdfRequest', () => {
  it('maps a web page to a confirmed url request with the margins on all sides', () => {
    const req = web2pdfRequest({ ...url, marginMm: 20, landscape: true, headerFooter: true }, OUT);
    expect(req).toEqual({
      kind: 'url',
      source: 'https://example.com/bai',
      outputPath: OUT,
      confirmed: true,
      options: {
        pageSize: 'A4',
        landscape: true,
        marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
        printBackground: true,
        scale: 1,
        headerFooter: true,
      },
    });
  });

  it('never marks a local file as confirmed and trims the source', () => {
    const req = web2pdfRequest(
      {
        ...DEFAULT_WEB2PDF_FORM,
        kind: 'file',
        source: '  D:/notes/a.md ',
        confirmed: true,
        pageSize: 'Letter',
      },
      OUT,
    );
    expect(req.kind).toBe('file');
    expect(req.source).toBe('D:/notes/a.md');
    expect(req.confirmed).toBe(false);
    expect(req.options?.pageSize).toBe('Letter');
  });
});

describe('isWebSourceName and defaultPdfName', () => {
  it('accepts Markdown and HTML names only', () => {
    expect(isWebSourceName('ghi-chu.MD')).toBe(true);
    expect(isWebSourceName('trang.htm')).toBe(true);
    expect(isWebSourceName('a.exe')).toBe(false);
  });

  it('suggests a name from the file or the host', () => {
    expect(defaultPdfName(String.raw`D:\notes\bai hoc.md`)).toBe('bai hoc.pdf');
    expect(defaultPdfName('https://www.example.com/a/b')).toBe('example.com.pdf');
    expect(defaultPdfName('https://')).toBe('tai-lieu.pdf');
  });
});
