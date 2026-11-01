/**
 * Pure model of "Trang web / Markdown → PDF" (T5.06): the form, its checks and the request sent
 * to `chef.convert.toPdf`. No React, no bridge calls. The main process re-validates everything.
 */
import type { Web2PdfOptions, Web2PdfRequest } from '@chef/contracts';

/** `url` loads a remote page; `file` is a Markdown or HTML file on this computer. */
export type Web2PdfSourceKind = 'url' | 'file';

export interface Web2PdfForm {
  kind: Web2PdfSourceKind;
  /** The address (url) or the path of the file the user picked. */
  source: string;
  confirmed: boolean;
  pageSize: Web2PdfOptions['pageSize'];
  landscape: boolean;
  /** One margin value, applied to all four sides (mm). */
  marginMm: number;
  printBackground: boolean;
  headerFooter: boolean;
}

export const DEFAULT_WEB2PDF_FORM: Web2PdfForm = {
  kind: 'url',
  source: '',
  confirmed: false,
  pageSize: 'A4',
  landscape: false,
  marginMm: 15,
  printBackground: true,
  headerFooter: false,
};

export const MARGIN_RANGE = { min: 0, max: 50 } as const;

export type Web2PdfIssue = 'source' | 'confirm' | 'output' | 'margin';

const URL_RE = /^https?:\/\/\S+$/i;

/** Problems that keep the Run button disabled (empty list: ready to run). */
export function web2pdfIssues(form: Web2PdfForm, outputPath: string): Web2PdfIssue[] {
  const out: Web2PdfIssue[] = [];
  const source = form.source.trim();
  if (source.length === 0) out.push('source');
  else if (form.kind === 'url' && (!URL_RE.test(source) || source.length > 2048))
    out.push('source');
  if (form.kind === 'url' && source.length > 0 && !form.confirmed) out.push('confirm');
  if (!outputPath || !/\.pdf$/i.test(outputPath)) out.push('output');
  if (
    !Number.isInteger(form.marginMm) ||
    form.marginMm < MARGIN_RANGE.min ||
    form.marginMm > MARGIN_RANGE.max
  ) {
    out.push('margin');
  }
  return out;
}

/** The request for `chef.convert.toPdf`. Only call it when `web2pdfIssues` is empty. */
export function web2pdfRequest(form: Web2PdfForm, outputPath: string): Web2PdfRequest {
  const m = form.marginMm;
  const source = form.source.trim();
  return {
    kind: form.kind === 'url' ? 'url' : 'file',
    source,
    outputPath,
    confirmed: form.kind === 'url' ? form.confirmed : false,
    options: {
      pageSize: form.pageSize,
      landscape: form.landscape,
      marginsMm: { top: m, right: m, bottom: m, left: m },
      printBackground: form.printBackground,
      scale: 1,
      headerFooter: form.headerFooter,
    },
  };
}

/** Markdown and HTML file names are accepted; anything else is refused before the call. */
export function isWebSourceName(name: string): boolean {
  return /\.(md|markdown|html|htm)$/i.test(name);
}

/** Suggested PDF name for a source: the file name without extension, or the host of a URL. */
export function defaultPdfName(source: string): string {
  const s = source.trim();
  if (URL_RE.test(s)) {
    try {
      return `${new URL(s).hostname.replace(/^www\./, '') || 'trang-web'}.pdf`;
    } catch {
      return 'trang-web.pdf';
    }
  }
  const base = s.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '');
  return `${stem || 'tai-lieu'}.pdf`;
}
