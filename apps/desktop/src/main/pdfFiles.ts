/**
 * PDF files in a folder listing (batch signing picks a folder). Pure: the caller reads the
 * directory and passes the entry names here.
 */
import path from 'node:path';

export const MAX_FOLDER_PDFS = 1000;

/** Absolute paths of the PDF names in `names`, sorted by name, at most MAX_FOLDER_PDFS. */
export function pdfFilesOf(names: readonly string[], dir: string): string[] {
  return names
    .filter((n) => n.toLowerCase().endsWith('.pdf') && !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'vi'))
    .slice(0, MAX_FOLDER_PDFS)
    .map((n) => path.join(dir, n));
}
