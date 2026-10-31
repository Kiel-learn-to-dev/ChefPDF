import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
// pdfjs-dist/web/pdf_viewer.mjs reads the library from globalThis.pdfjsLib, so this
// module must be imported before it (see viewerLib.ts).
(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

/** Directory URL of pdf.js runtime assets (served/copied by the Vite plugin in vite.config.ts). */
function assetDir(dir: string): string {
  return new URL(`pdfjs/${dir}/`, document.baseURI).href;
}

export interface LoadOptions {
  password?: string;
}

/**
 * Load a PDF for viewing. Scripting is never enabled (no PDFScriptingManager is
 * created). Note: pdfjs-dist 6 removed the `isEvalSupported` option because it
 * no longer evaluates code at all, so there is nothing to switch off.
 */
export function loadPdf(url: string, options: LoadOptions = {}): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    url,
    password: options.password,
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    wasmUrl: assetDir('wasm'),
    iccUrl: assetDir('iccs'),
    enableXfa: false,
  }).promise;
}

/** Same as loadPdf but from bytes (used by the mock bridge to verify passwords). */
export function loadPdfData(
  data: Uint8Array,
  options: LoadOptions = {},
): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data, password: options.password, enableXfa: false }).promise;
}

/** pdfjs-dist 6 moved destroy() from the document proxy to its loading task. */
export function destroyPdf(pdf: PDFDocumentProxy): Promise<void> {
  return pdf.loadingTask.destroy();
}

export function isPasswordException(e: unknown): e is { name: 'PasswordException'; code: number } {
  return (
    typeof e === 'object' && e !== null && (e as { name?: string }).name === 'PasswordException'
  );
}

export const PasswordResponses = pdfjsLib.PasswordResponses;
export { pdfjsLib };
export type { PDFDocumentProxy };
