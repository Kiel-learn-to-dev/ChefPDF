/**
 * Pure model of the conversions (M2, M3, M4; T5.05): PDF to images, images to PDF, and the list
 * of images (order, clipboard image). No React, no RPC.
 */
import type { ConvertImagesToPdfParams, ConvertPdfToImagesParams } from '@chef/contracts';

export type ImageFormat = 'png' | 'jpeg' | 'tiff' | 'webp';
export type ColorMode = 'color' | 'gray' | 'bw';

export interface PdfToImagesForm {
  format: ImageFormat;
  dpi: number;
  color: ColorMode;
  jpegQuality: number;
  multiPageTiff: boolean;
  outputDir: string;
  nameTemplate: string;
}

export const DEFAULT_PDF_TO_IMAGES: PdfToImagesForm = {
  format: 'png',
  dpi: 150,
  color: 'color',
  jpegQuality: 90,
  multiPageTiff: false,
  outputDir: '',
  nameTemplate: '{name}_{page}',
};

export const DPI_RANGE = { min: 36, max: 600 } as const;
export const QUALITY_RANGE = { min: 1, max: 100 } as const;
export const MAX_NAME_TEMPLATE = 120;

export type PdfToImagesIssue = 'outputDir' | 'dpi' | 'quality' | 'nameTemplate';

export function pdfToImagesIssues(form: PdfToImagesForm): PdfToImagesIssue[] {
  const out: PdfToImagesIssue[] = [];
  if (!form.outputDir) out.push('outputDir');
  if (!isIntIn(form.dpi, DPI_RANGE.min, DPI_RANGE.max)) out.push('dpi');
  if (!isIntIn(form.jpegQuality, QUALITY_RANGE.min, QUALITY_RANGE.max)) out.push('quality');
  const tpl = form.nameTemplate.trim();
  if (!tpl || tpl.length > MAX_NAME_TEMPLATE || /[\\/:*?"<>|]/.test(tpl)) out.push('nameTemplate');
  return out;
}

function isIntIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Params of convert.pdfToImages. `pages` are 0-based indices (left out = all pages). The
 * jpegQuality is sent for JPEG and WebP only, so it never changes the other formats.
 */
/**
 * The dialog reads the current revision (rev-0000.pdf), so the core would take {name} from that
 * file. With docName, {name} is filled in here with the document's own name. Braces in the name
 * are replaced so the core does not read them as variables.
 */
function withDocName(template: string, docName: string | undefined): string {
  if (!docName) return template;
  const stem = docName.replace(/\.pdf$/i, '').replace(/[{}]/g, '_');
  return template.split('{name}').join(stem);
}

export function pdfToImagesParams(
  form: PdfToImagesForm,
  src: { path: string; password?: string; pages?: number[]; docName?: string },
): ConvertPdfToImagesParams {
  const out: ConvertPdfToImagesParams = {
    path: src.path,
    format: form.format,
    dpi: form.dpi,
    color: form.color,
    multiPageTiff: form.format === 'tiff' && form.multiPageTiff,
    outputDir: form.outputDir,
    nameTemplate: withDocName(form.nameTemplate.trim(), src.docName),
  };
  if (form.format === 'jpeg' || form.format === 'webp') out.jpegQuality = form.jpegQuality;
  if (src.password) out.password = src.password;
  if (src.pages && src.pages.length > 0) out.pages = src.pages;
  return out;
}

export type PageSizeMode = 'fit-image' | 'a4' | 'letter' | 'custom';

export interface ImagesToPdfForm {
  pageSize: PageSizeMode;
  customWidthMm: number;
  customHeightMm: number;
  marginMm: number;
  orientation: 'auto' | 'portrait' | 'landscape';
  fit: 'fit' | 'fill' | 'center';
}

export const DEFAULT_IMAGES_TO_PDF: ImagesToPdfForm = {
  pageSize: 'a4',
  customWidthMm: 210,
  customHeightMm: 297,
  marginMm: 10,
  orientation: 'auto',
  fit: 'fit',
};

export type ImagesToPdfIssue = 'images' | 'output' | 'custom' | 'margin';

export function imagesToPdfIssues(
  form: ImagesToPdfForm,
  images: readonly string[],
  outputPath: string,
): ImagesToPdfIssue[] {
  const out: ImagesToPdfIssue[] = [];
  if (images.length === 0) out.push('images');
  if (!outputPath) out.push('output');
  if (form.pageSize === 'custom') {
    const ok = (n: number) => Number.isFinite(n) && n > 0 && n <= 2000;
    if (!ok(form.customWidthMm) || !ok(form.customHeightMm)) out.push('custom');
  }
  if (!Number.isFinite(form.marginMm) || form.marginMm < 0 || form.marginMm > 100) {
    out.push('margin');
  }
  return out;
}

/** Params of convert.imagesToPdf (images in the given order). */
export function imagesToPdfParams(
  form: ImagesToPdfForm,
  images: readonly string[],
  outputPath: string,
): ConvertImagesToPdfParams {
  const out: ConvertImagesToPdfParams = {
    images: [...images],
    outputPath,
    pageSize: form.pageSize,
    marginMm: form.marginMm,
    orientation: form.orientation,
    fit: form.fit,
  };
  if (form.pageSize === 'custom') {
    out.customWidthMm = form.customWidthMm;
    out.customHeightMm = form.customHeightMm;
  }
  return out;
}

/** Moves the item at `from` to `to` (clamped). Returns a new list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Image files the converter accepts (PNG and JPEG, as the file picker offers). */
export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g)$/i.test(p);
}

/** Adds paths not in the list yet, keeping the order, accepting images only. */
export function addImages(list: readonly string[], paths: readonly string[]): string[] {
  const out = [...list];
  for (const p of paths) {
    if (isImagePath(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Name of the output PDF: the file name of the first image without its extension. */
export function defaultPdfName(images: readonly string[]): string {
  const first = images[0];
  if (!first) return 'images.pdf';
  const base = first.split(/[\\/]/).pop() ?? 'images';
  return `${base.replace(/\.[^.]+$/, '') || 'images'}.pdf`;
}
