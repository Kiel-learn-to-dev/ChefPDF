import type { ExportDocumentParams } from '@chef/contracts';

export type ExportFormat = ExportDocumentParams['format'] | 'pdf';
export const FORMATS: ExportFormat[] = [
  'docx',
  'md',
  'html',
  'txt',
  'json',
  'epub',
  'odt',
  'xlsx',
  'pdf',
];

export function outputName(name: string, format: ExportFormat): string {
  const stem = name.replace(/\.pdf$/i, '') || 'document';
  return `${stem}${format === 'pdf' ? '_lam-moi' : ''}.${format}`;
}

export function exportParams(
  format: ExportDocumentParams['format'],
  outputPath: string,
  pages: number[],
  mode: 'editable' | 'layout',
  includeImages: boolean,
): ExportDocumentParams {
  // The operating system's save dialog already asked before replacing an existing file.
  return { format, outputPath, replaceExisting: true, pages, options: { mode, includeImages } };
}
