/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: pydantic params models of the core operations (core/chef_core/ops).
 * Regenerate: cd core && uv run python -m chef_core.codegen
 */

/** An anchor as returned by sign.findAnchors (only the parts that placement needs). */
export interface AnchorRef {
  pageIndex: number;
  rect: number[];
}

export interface BackgroundStyle {
  /** @default "#FFFFFF" */
  color?: string;
  /**
   * 0 = transparent.
   * @default 0.0
   */
  opacity?: number;
}

export interface BorderStyle {
  /** @default "#1F3A93" */
  color?: string;
  /**
   * Points.
   * @default 0.8
   */
  width?: number;
}

export interface ImageDataUrlSource {
  /** data: URL (e.g. pasted from clipboard). */
  dataUrl: string;
}

export interface ImagePathSource {
  /** Image file path. */
  path: string;
}

export interface ImageSlot {
  /** PNG or JPEG file (PNG alpha is kept). */
  path: string;
  /** @default "contain" */
  fit?: 'contain' | 'cover' | 'stretch';
  /** @default 1.0 */
  opacity?: number;
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

export interface SeparationLayer {
  /** E.g. "Con dấu", "Chữ ký". */
  name: string;
  /** Reference colour of the layer. */
  colorHex: string;
  /** @default 60 */
  tolerance?: number;
}

/** Look of a visible signature (I10-I18). Defaults give a plain text box. */
export interface SignatureTemplate {
  /** @default "Mặc định" */
  name?: string;
  /**
   * text-only; image-left / image-right: image column beside the text; image-background: image behind the text. The image is ignored by text-only.
   * @default "text-only"
   */
  layout?: 'text-only' | 'image-left' | 'image-right' | 'image-background';
  /** @default "Ký số bởi" */
  header?: string | null;
  lines?: TemplateLine[];
  /**
   * Tokens: yyyy yy MM M dd d HH H mm m ss s. Text in single quotes is literal.
   * @default "dd/MM/yyyy HH:mm:ss"
   */
  dateFormat?: string;
  /**
   * Append (UTC+07:00).
   * @default false
   */
  showTimezone?: boolean;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /**
   * Points.
   * @default 9
   */
  fontSize?: number;
  /**
   * Floor for auto-shrink.
   * @default 5
   */
  minFontSize?: number;
  /** @default true */
  autoShrink?: boolean;
  /** @default false */
  bold?: boolean;
  /** @default "#000000" */
  textColor?: string;
  /** @default "left" */
  align?: 'left' | 'center' | 'right';
  /** @default "middle" */
  valign?: 'top' | 'middle' | 'bottom';
  /**
   * Inner margin in points.
   * @default 4
   */
  padding?: number;
  border?: BorderStyle | null;
  background?: BackgroundStyle;
  /**
   * Vector check mark before the text.
   * @default false
   */
  checkmark?: boolean;
  /** @default "#1E8E3E" */
  checkColor?: string;
  image?: ImageSlot;
  /**
   * Image column share.
   * @default 0.35
   */
  imageRatio?: number;
  /** Logo in its own column at the right. */
  logo?: ImageSlot;
}

export interface StrokeParams {
  points: StrokePointParams[];
}

export interface StrokePointParams {
  x: number;
  y: number;
  /**
   * 0 = lightest, 1 = heaviest.
   * @default 1.0
   */
  pressure?: number;
  /** Time stamp; not used for the drawing. */
  t?: number;
}

/** One line of text in the box. Lines are drawn in list order; disabled lines are skipped. */
export interface TemplateLine {
  /** Which value fills the line. */
  source: 'signerName' | 'organization' | 'taxCode' | 'citizenId' | 'reason' | 'location' | 'contact' | 'date' | 'custom';
  /** E.g. "Ký bởi:". */
  label?: string;
  /** Custom text (source custom, required there). For other sources it replaces the value from the certificate or the signing parameters. */
  text?: string;
  /** Size of this line; default: the template size. */
  fontSize?: number;
  /** @default true */
  enabled?: boolean;
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

/** Clean up a signature or stamp image (I21). All steps are optional. */
export interface ImageCleanupParams {
  inputPath: string;
  outputPath: string;
  /**
   * Remove ink blobs smaller than this (0 = off).
   * @default 0
   */
  minBlobPx?: number;
  /**
   * Turn the ink's main axis horizontal.
   * @default false
   */
  straighten?: boolean;
  /**
   * Tilts beyond this are not corrected (degrees).
   * @default 15.0
   */
  maxTilt?: number;
  /**
   * Grow (+) or thin (-) the strokes by N pixels.
   * @default 0
   */
  thicken?: number;
  /** @default 1.0 */
  contrast?: number;
  /** @default 0 */
  brightness?: number;
  maxWidth?: number;
  maxHeight?: number;
  /**
   * Mirror horizontally.
   * @default false
   */
  flipH?: boolean;
}

/** Pointer strokes drawn as smooth variable-width ink (I19). */
export interface ImageFromStrokesParams {
  strokes: StrokeParams[];
  /** Canvas size the points refer to. */
  canvasWidth: number;
  canvasHeight: number;
  /** @default "#1F3A93" */
  colorHex?: string;
  /**
   * Width at pressure 0, px.
   * @default 1.5
   */
  minWidth?: number;
  /**
   * Width at pressure 1, px.
   * @default 6.0
   */
  maxWidth?: number;
  /** @default 8 */
  padding?: number;
  outputPath: string;
}

/** Keep the ink and make the paper transparent (I20). */
export interface ImageRemoveBackgroundParams {
  /** PNG or JPEG to process. */
  inputPath: string;
  /** PNG (RGBA) to write. */
  outputPath: string;
  /**
   * ink-color: keep pixels near the ink colour. paper-white: keep pixels darker than the local paper level. auto: paper-white, then ink-color when that finds little ink.
   * @default "auto"
   */
  mode?: 'ink-color' | 'paper-white' | 'auto';
  /**
   * Ink colour as #RRGGBB, or 'auto' for the dominant non-paper colour.
   * @default "auto"
   */
  inkColor?: string;
  /**
   * Colour distance for ink-color.
   * @default 60
   */
  tolerance?: number;
  /**
   * paper-white: higher keeps fainter ink.
   * @default 50
   */
  sensitivity?: number;
  /**
   * Soft edge width in pixels.
   * @default 1.0
   */
  feather?: number;
  /** Recolour all ink to this colour (default: keep the colour). */
  outputColor?: string;
  /**
   * Transparent margin in pixels.
   * @default 4
   */
  padding?: number;
}

/** Split an image into one transparent PNG per colour (I22). */
export interface ImageSeparateColorsParams {
  inputPath: string;
  /** Existing folder for the layer files. */
  outputDir: string;
  layers: SeparationLayer[];
}

/** Typed text rendered as a transparent signature image (I19). */
export interface ImageTextSignatureParams {
  text: string;
  /**
   * A bundled font. Ignored when fontPath is given.
   * @default "BeVietnamPro"
   */
  fontName?: 'BeVietnamPro' | null;
  /** A TrueType/OpenType file of your choice. */
  fontPath?: string;
  /** @default 96 */
  sizePx?: number;
  /** @default "#1F3A93" */
  colorHex?: string;
  /**
   * Positive leans right, like italics.
   * @default 0.0
   */
  slantDeg?: number;
  /** @default 6 */
  padding?: number;
  outputPath: string;
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

/** Add an empty signature field to a page. */
export interface SignAddFieldParams {
  /** 0-based page of the field. */
  page: number;
  /** [x1, y1, x2, y2] in PDF points. */
  rect: number[];
  /** Name of the field. Default: the first free Signature<N>. */
  fieldName?: string;
  /** Who must sign here, e.g. 'Giám đốc'. Stored as the field's tooltip (/TU). */
  signerLabel?: string;
}

/** Read the certificate in a .pfx / .p12 file without signing anything. */
export interface SignCertInfoParams {
  /** Path to the .pfx or .p12 file. */
  pfxPath: string;
  /** Password of the certificate file. Never stored, logged or echoed back. */
  password?: string;
}

/** Run the token checks step by step (driver, token, certificate, PIN state). */
export interface SignDiagnoseTokenParams {
  /** Driver to check. Default: the first driver the scan finds. */
  modulePath?: string;
  /** Slot of the token to check. */
  slotId?: number;
}

/** List the known driver files and whether each exists on this computer. */
export interface SignDriverScanParams {
  /**
   * Also load each driver that exists and list the token labels it sees. No PIN is used.
   * @default false
   */
  probe?: boolean;
}

/** Write the document as it was when one signature was applied. */
export interface SignExtractRevisionParams {
  /** Path of the PDF file. */
  path: string;
  /** Name of the signed signature field. */
  fieldName: string;
  /** Path of the PDF to write. It must not be the source file. */
  outputPath: string;
}

/** Search the document for a text (I26). */
export interface SignFindAnchorsParams {
  /** The text to find, e.g. 'GIÁM ĐỐC'. Spacing between words is normalised. */
  text: string;
  /** @default false */
  caseSensitive?: boolean;
  /**
   * 'giam doc' also finds 'GIÁM ĐỐC'. đ and Đ count as d and D.
   * @default true
   */
  ignoreDiacritics?: boolean;
  /**
   * Do not match inside longer words.
   * @default true
   */
  wholeWord?: boolean;
  /** 0-based pages to search; default all. */
  pages?: number[];
  /** @default 200 */
  maxResults?: number;
}

/** No parameters: lists the signature fields of the current revision. */
export interface SignListFieldsParams {
}

/** Tokens in one driver, with their certificates. No PIN is needed. */
export interface SignListTokensParams {
  /** Path of the PKCS#11 driver file (.dll, .dylib or .so). */
  modulePath: string;
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
  /** [x1, y1, x2, y2] in PDF points. Needs page. Also draws into an existing empty field of that name. */
  rect?: number[];
  /** Certify the document (DocMDP) with this signature. Only for the first signature of a document. no-changes: P=1; form-fill: P=2; annotate: P=3. */
  certify?: 'no-changes' | 'form-fill' | 'annotate';
  /** Look of a visible signature. Default: a plain text box. */
  template?: SignatureTemplate;
}

/** Sign the document with a key on a USB token (PAdES). Same options as sign.pades. */
export interface SignPadesTokenParams {
  /** Path of the PKCS#11 driver file (.dll, .dylib or .so). */
  modulePath: string;
  /** Slot of the token. */
  slotId?: number;
  /** Serial of the token, instead of slotId. */
  tokenSerial?: string;
  /** CKA_ID of the signing certificate, in hex (from sign.listTokens). */
  certId: string;
  /** Token PIN. Used for one login and then dropped. Never stored, logged or echoed back. */
  pin: string;
  /**
   * Must be true to use the PIN when the token reports only one try left.
   * @default false
   */
  confirmFinalTry?: boolean;
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

/** Signature boxes next to anchors (I26). Positions are in the displayed frame. */
export interface SignPlaceFromAnchorParams {
  anchors: AnchorRef[];
  /** Displayed width in points. */
  width: number;
  /** Displayed height in points. */
  height: number;
  /** @default "below" */
  position?: 'below' | 'above' | 'right' | 'left' | 'over';
  /**
   * Moves the box right.
   * @default 0.0
   */
  offsetX?: number;
  /**
   * Moves the box up.
   * @default 0.0
   */
  offsetY?: number;
  /**
   * For 'below' and 'above': how the box lines up with the text.
   * @default "center"
   */
  align?: 'left' | 'center' | 'right';
  /**
   * Distance from the text, points.
   * @default 4.0
   */
  gap?: number;
  /**
   * Move boxes inside the page. When false, boxes crossing the edge are skipped.
   * @default true
   */
  clampToPage?: boolean;
}

/** Verify the signatures of the document. */
export interface SignVerifyParams {
  /** Extra trust roots: certificate files (PEM or DER) or folders of them. The bundled trust folder is always used. */
  trustRootPaths?: string[];
  /**
   * none: no revocation check. soft: a failed check is a warning. hard: a failed check makes the signature unknown.
   * @default "soft"
   */
  checkRevocation?: 'none' | 'soft' | 'hard';
  /**
   * False: treat an unreachable revocation server like hard mode.
   * @default true
   */
  allowOffline?: boolean;
  /**
   * Timeout of each CRL or OCSP request.
   * @default 15
   */
  timeoutSeconds?: number;
}

/** Verify the signatures of a PDF file (no session needed). */
export interface SignVerifyFileParams {
  /** Extra trust roots: certificate files (PEM or DER) or folders of them. The bundled trust folder is always used. */
  trustRootPaths?: string[];
  /**
   * none: no revocation check. soft: a failed check is a warning. hard: a failed check makes the signature unknown.
   * @default "soft"
   */
  checkRevocation?: 'none' | 'soft' | 'hard';
  /**
   * False: treat an unreachable revocation server like hard mode.
   * @default true
   */
  allowOffline?: boolean;
  /**
   * Timeout of each CRL or OCSP request.
   * @default 15
   */
  timeoutSeconds?: number;
  /** Path of the PDF file. */
  path: string;
}

/** Params type of every operation, by op id. */
export interface OpParams {
  'file.merge': FileMergeParams;
  'file.split': FileSplitParams;
  'image.cleanup': ImageCleanupParams;
  'image.fromStrokes': ImageFromStrokesParams;
  'image.removeBackground': ImageRemoveBackgroundParams;
  'image.separateColors': ImageSeparateColorsParams;
  'image.textSignature': ImageTextSignatureParams;
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
  'sign.addField': SignAddFieldParams;
  'sign.certInfo': SignCertInfoParams;
  'sign.diagnoseToken': SignDiagnoseTokenParams;
  'sign.driverScan': SignDriverScanParams;
  'sign.extractRevision': SignExtractRevisionParams;
  'sign.findAnchors': SignFindAnchorsParams;
  'sign.listFields': SignListFieldsParams;
  'sign.listTokens': SignListTokensParams;
  'sign.pades': SignPadesParams;
  'sign.padesToken': SignPadesTokenParams;
  'sign.placeFromAnchor': SignPlaceFromAnchorParams;
  'sign.verify': SignVerifyParams;
  'sign.verifyFile': SignVerifyFileParams;
}

export type OpId = keyof OpParams;

export const OP_IDS = [
  'file.merge',
  'file.split',
  'image.cleanup',
  'image.fromStrokes',
  'image.removeBackground',
  'image.separateColors',
  'image.textSignature',
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
  'sign.addField',
  'sign.certInfo',
  'sign.diagnoseToken',
  'sign.driverScan',
  'sign.extractRevision',
  'sign.findAnchors',
  'sign.listFields',
  'sign.listTokens',
  'sign.pades',
  'sign.padesToken',
  'sign.placeFromAnchor',
  'sign.verify',
  'sign.verifyFile',
] as const;
