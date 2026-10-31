/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: pydantic params models of the core operations (core/chef_core/ops).
 * Regenerate: cd core && uv run python -m chef_core.codegen
 */

export interface ImageDataUrlSource {
  /** data: URL (e.g. pasted from clipboard). */
  dataUrl: string;
}

export interface ImagePathSource {
  /** Image file path. */
  path: string;
}

export interface MergeInput {
  /** PDF file to merge. */
  path: string;
  /** Password of that file. */
  password?: string;
  /** 0-based pages to take; default all. */
  pages?: number[];
}

/** Parameters for one scanner look. The defaults are neutral (no effect). */
export interface ScanEffects {
  /** @default 0.0 */
  rotationDegrees?: number;
  /** @default 0.0 */
  noise?: number;
  /** @default 0.0 */
  paperTint?: number;
  /** @default "#f4efe1" */
  tintColor?: string;
  /** @default 0.0 */
  edgeShadow?: number;
  /** @default 0.0 */
  blur?: number;
  /** @default 1.0 */
  contrast?: number;
  /** @default 1.0 */
  brightness?: number;
  /** @default false */
  jitter?: boolean;
  seed?: number;
}

/** Merge several PDFs (in order) into a new file. */
export interface FileMergeParams {
  inputs: MergeInput[];
  /** Absolute path of the PDF to write. */
  outputPath: string;
  /** Add one top-level bookmark per input named after its file; the input's own bookmarks are nested under it. */
  bookmarksFromFilenames: boolean;
}

/** Split the document into several files written to `outputDir`. */
export interface FileSplitParams {
  mode: 'ranges' | 'everyN' | 'bookmarks' | 'maxSize' | 'oddEven';
  /** mode "ranges": 1-based groups, e.g. "1-3,5,7-9" (one file per group). */
  ranges?: string;
  /** mode "everyN": pages per file. */
  n?: number;
  /** mode "maxSize": maximum size of each file in bytes. */
  maxBytes?: number;
  /** Directory for the output files. */
  outputDir: string;
  /**
   * File name template: {name}, {index}, {start}, {end}; .pdf is appended.
   * @default "{name}_{index}"
   */
  nameTemplate?: string;
}

/** Delete pages. Deleting every page is not allowed. */
export interface PageDeleteParams {
  /** 0-based page indices. */
  pages: number[];
}

/** Duplicate pages; each copy is inserted right after its source page. */
export interface PageDuplicateParams {
  /** 0-based page indices. */
  pages: number[];
}

/** Write the given pages (in the given order) to a new PDF. The document is unchanged. */
export interface PageExtractParams {
  /** 0-based page indices, in output order. */
  pages: number[];
  /** Absolute path of the PDF to write. */
  outputPath: string;
}

/** Insert blank pages before index `at` (`at` = page count appends). */
export interface PageInsertBlankParams {
  /** Insert position (0-based, 0..pageCount). */
  at: number;
  /** Number of blank pages. */
  count: number;
  /** Width in pt; defaults to the page before `at`, or A4. */
  width?: number;
  /** Height in pt; defaults to the page before `at`, or A4. */
  height?: number;
}

/** Insert pages of another PDF before index `at`. */
export interface PageInsertFromFileParams {
  /** Insert position (0-based, 0..pageCount). */
  at: number;
  /** PDF file to insert from. */
  path: string;
  /** Password of that file. */
  password?: string;
  /** 0-based pages of that file; default all. */
  pages?: number[];
}

/** Insert one page per image (multi-frame TIFF: one per frame) before index `at`. */
export interface PageInsertImagesParams {
  /** Insert position (0-based, 0..pageCount). */
  at: number;
  images: (ImagePathSource | ImageDataUrlSource)[];
  /** 'image' = page fits the image (+margin); 'a4' / 'letter' = image fitted into the page, landscape for landscape images. */
  pageSize: 'image' | 'a4' | 'letter';
  /** Margin in pt. */
  margin: number;
}

/** Reorder pages: new page i = old page `order[i]` (a full permutation). */
export interface PageReorderParams {
  /** Full permutation of current 0-based indices. */
  order: number[];
}

/** Rotate pages clockwise, relative to their current rotation. */
export interface PageRotateParams {
  /** 0-based page indices. */
  pages: number[];
  /** Clockwise rotation in degrees. */
  angle: 90 | 180 | 270;
}

/** Rasterize parameters are the starting point; the search only lowers dpi and quality. */
export interface ScanFitSizeParams {
  /**
   * Render resolution in dpi.
   * @default 200
   */
  dpi?: number;
  /**
   * 'color' (JPEG RGB), 'gray' (JPEG gray) or 'bw' (1-bit G4).
   * @default "gray"
   */
  color?: 'color' | 'gray' | 'bw';
  /**
   * bw only: gray level from which a pixel is white.
   * @default 128
   */
  threshold?: number;
  /**
   * bw only: Floyd-Steinberg dithering.
   * @default false
   */
  dithering?: boolean;
  /**
   * JPEG quality (color, gray).
   * @default 75
   */
  jpegQuality?: number;
  /** 0-based pages to convert; default all. */
  pages?: number[];
  /**
   * Remove the document information dictionary and XMP.
   * @default true
   */
  stripMetadata?: boolean;
  /** Scanner look applied to each page before encoding. */
  effects?: ScanEffects;
  /** Name of a built-in effects preset; ignored if effects is set. */
  effectsPreset?: 'none' | 'light' | 'photocopy' | 'old-paper';
  /**
   * Seed for the effects' randomness: same seed, same output.
   * @default 0
   */
  seed?: number;
  /** Largest acceptable size of the result in bytes. */
  targetBytes: number;
  /**
   * Lowest dpi to try.
   * @default 100
   */
  minDpi?: number;
  /**
   * Lowest JPEG quality.
   * @default 30
   */
  minJpegQuality?: number;
}

/** Rasterize parameters plus the pages to preview. */
export interface ScanPreviewParams {
  /**
   * Render resolution in dpi.
   * @default 200
   */
  dpi?: number;
  /**
   * 'color' (JPEG RGB), 'gray' (JPEG gray) or 'bw' (1-bit G4).
   * @default "gray"
   */
  color?: 'color' | 'gray' | 'bw';
  /**
   * bw only: gray level from which a pixel is white.
   * @default 128
   */
  threshold?: number;
  /**
   * bw only: Floyd-Steinberg dithering.
   * @default false
   */
  dithering?: boolean;
  /**
   * JPEG quality (color, gray).
   * @default 75
   */
  jpegQuality?: number;
  /** 0-based pages to convert; default all. */
  pages?: number[];
  /**
   * Remove the document information dictionary and XMP.
   * @default true
   */
  stripMetadata?: boolean;
  /** Scanner look applied to each page before encoding. */
  effects?: ScanEffects;
  /** Name of a built-in effects preset; ignored if effects is set. */
  effectsPreset?: 'none' | 'light' | 'photocopy' | 'old-paper';
  /**
   * Seed for the effects' randomness: same seed, same output.
   * @default 0
   */
  seed?: number;
  /** 0-based pages to preview (at most 3); default: first and middle selected. */
  samplePages?: number[];
}

/** Convert pages to images. Selected pages lose their text, links and form fields. */
export interface ScanRasterizeParams {
  /**
   * Render resolution in dpi.
   * @default 200
   */
  dpi?: number;
  /**
   * 'color' (JPEG RGB), 'gray' (JPEG gray) or 'bw' (1-bit G4).
   * @default "gray"
   */
  color?: 'color' | 'gray' | 'bw';
  /**
   * bw only: gray level from which a pixel is white.
   * @default 128
   */
  threshold?: number;
  /**
   * bw only: Floyd-Steinberg dithering.
   * @default false
   */
  dithering?: boolean;
  /**
   * JPEG quality (color, gray).
   * @default 75
   */
  jpegQuality?: number;
  /** 0-based pages to convert; default all. */
  pages?: number[];
  /**
   * Remove the document information dictionary and XMP.
   * @default true
   */
  stripMetadata?: boolean;
  /** Scanner look applied to each page before encoding. */
  effects?: ScanEffects;
  /** Name of a built-in effects preset; ignored if effects is set. */
  effectsPreset?: 'none' | 'light' | 'photocopy' | 'old-paper';
  /**
   * Seed for the effects' randomness: same seed, same output.
   * @default 0
   */
  seed?: number;
}

/** Read the certificate in a .pfx / .p12 file without signing anything. */
export interface SignCertInfoParams {
  /** Path to the .pfx or .p12 file. */
  pfxPath: string;
  /** Password of the certificate file. Never stored, logged or echoed back. */
  password?: string;
}

/** Sign the document with a certificate file (PAdES). */
export interface SignPadesParams {
  /** Path to the .pfx or .p12 file. */
  pfxPath: string;
  /** Password of the certificate file. Never stored, logged or echoed back. */
  password?: string;
  /**
   * B-B: signature only. B-T: + timestamp. B-LT: + revocation data. B-LTA: + document timestamp for long-term validity.
   * @default "B-B"
   */
  level?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  /** @default "sha256" */
  digest?: 'sha256' | 'sha384' | 'sha512';
  /** Timestamp servers, tried in order. Required for B-T and above. */
  tsaUrls?: string[];
  /** Extra trust roots (PEM or DER) for B-LT and B-LTA. */
  trustRootPaths?: string[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Signature field name. Default: the first free Signature<N>. */
  fieldName?: string;
  /** 0-based page for a visible signature. Needs rect. */
  page?: number;
  /** [x1, y1, x2, y2] in PDF points. Needs page. */
  rect?: number[];
}

/** Params type of every operation, by op id. */
export interface OpParams {
  'file.merge': FileMergeParams;
  'file.split': FileSplitParams;
  'page.delete': PageDeleteParams;
  'page.duplicate': PageDuplicateParams;
  'page.extract': PageExtractParams;
  'page.insertBlank': PageInsertBlankParams;
  'page.insertFromFile': PageInsertFromFileParams;
  'page.insertImages': PageInsertImagesParams;
  'page.reorder': PageReorderParams;
  'page.rotate': PageRotateParams;
  'scan.fitSize': ScanFitSizeParams;
  'scan.preview': ScanPreviewParams;
  'scan.rasterize': ScanRasterizeParams;
  'sign.certInfo': SignCertInfoParams;
  'sign.pades': SignPadesParams;
}

export type OpId = keyof OpParams;

export const OP_IDS = [
  'file.merge',
  'file.split',
  'page.delete',
  'page.duplicate',
  'page.extract',
  'page.insertBlank',
  'page.insertFromFile',
  'page.insertImages',
  'page.reorder',
  'page.rotate',
  'scan.fitSize',
  'scan.preview',
  'scan.rasterize',
  'sign.certInfo',
  'sign.pades',
] as const;
