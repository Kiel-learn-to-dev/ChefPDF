/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: pydantic params models of the core operations (core/chef_core/ops).
 * Regenerate: cd core && uv run python -m chef_core.codegen
 */

export interface AnchorPlacement {
  kind: 'anchor';
  /** Text to find on each file. */
  text: string;
  /** @default "below" */
  position?: 'below' | 'above' | 'right' | 'left' | 'over';
  /** Displayed width in points. */
  width: number;
  /** Displayed height in points. */
  height: number;
  /** @default 0.0 */
  offsetX?: number;
  /** @default 0.0 */
  offsetY?: number;
  /** @default "center" */
  align?: 'left' | 'center' | 'right';
  /** @default true */
  ignoreDiacritics?: boolean;
  /**
   * all: one signature per match, each in its own box, in one output file.
   * @default "first"
   */
  whichMatch?: 'first' | 'last' | 'all';
  /**
   * skip: the file is skipped. fail: the file fails. fallback-fixed: a fixed box at fallbackCorner / fallbackPage.
   * @default "skip"
   */
  onMissing?: 'skip' | 'fail' | 'fallback-fixed';
  /** @default "bottom-right" */
  fallbackCorner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** @default "last" */
  fallbackPage?: 'first' | 'last' | number;
  /** @default 36.0 */
  fallbackMargin?: number;
}

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

export interface BatchFile {
  /** Path of the PDF to sign. */
  path: string;
  /** Password of this PDF, when it is encrypted. Never stored or echoed back. */
  password?: string;
}

export interface BatchOutput {
  /**
   * suffix: next to each input, name + suffix. folder: all into one folder. overwrite: replace each input (atomic).
   * @default "suffix"
   */
  mode?: 'suffix' | 'folder' | 'overwrite';
  /**
   * Used in suffix mode.
   * @default "_signed"
   */
  suffix?: string;
  /** For folder mode. */
  folder?: string;
}

export interface BatesFile {
  /** Path of the PDF to number. */
  path: string;
  /** Password of this PDF, when it is encrypted. Never stored or echoed back. */
  password?: string;
}

export interface BatesOutput {
  /**
   * suffix: next to each input, name + suffix. folder: all into one folder. overwrite: replace each input (atomic).
   * @default "suffix"
   */
  mode?: 'suffix' | 'folder' | 'overwrite';
  /**
   * Used in suffix mode.
   * @default "_bates"
   */
  suffix?: string;
  /** For folder mode. */
  folder?: string;
}

export interface BookmarkNode {
  title: string;
  /** 0-based page; null for none. */
  page?: number;
  view?: BookmarkView;
  /**
   * Shown expanded (only with children).
   * @default true
   */
  open?: boolean;
  color?: string;
  /** @default false */
  bold?: boolean;
  /** @default false */
  italic?: boolean;
  children?: BookmarkNode[];
}

/**
 * Where the bookmark opens the page. `fit` shows the whole page; `xyz` uses the position
 * and zoom (null keeps the viewer's current value).
 */
export interface BookmarkView {
  /** @default "fit" */
  type?: 'fit' | 'xyz';
  left?: number;
  top?: number;
  zoom?: number;
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

export interface FixedPlacement {
  kind: 'fixed';
  /** @default "bottom-right" */
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Points. */
  width: number;
  /** Points. */
  height: number;
  /**
   * Points from both edges.
   * @default 36.0
   */
  margin?: number;
  /** @default "last" */
  page?: 'first' | 'last' | number;
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

export interface InvisiblePlacement {
  kind: 'invisible';
}

/** Distances from the page edges, in millimetres, on the displayed page. */
export interface Margins {
  /** @default 10.0 */
  top?: number;
  /** @default 10.0 */
  bottom?: number;
  /** @default 20.0 */
  left?: number;
  /** @default 20.0 */
  right?: number;
}

export interface MergeInput {
  /** PDF file to merge. */
  path: string;
  /** Password of that file. */
  password?: string;
  /** 0-based pages to take; default all. */
  pages?: number[];
}

export interface PfxSigner {
  kind: 'pfx';
  /** Path to the .pfx or .p12 file. */
  pfxPath: string;
  /** Password of the certificate file. */
  password?: string;
}

/** Values shown in the box. Missing values are left out, as in a real signature. */
export interface PreviewValues {
  /** @default "" */
  signerName?: string;
  organization?: string;
  taxCode?: string;
  citizenId?: string;
  reason?: string;
  location?: string;
  contact?: string;
  /** ISO 8601 date and time. Default: now (local time). */
  date?: string;
}

export interface RectPlacement {
  kind: 'rect';
  /** 0-based page. */
  page: number;
  /** [x1, y1, x2, y2] in PDF points, the same on every file. */
  rect: number[];
}

/** A file to check. Encrypted PDFs are reported as errors (no password is used here). */
export interface ReportFile {
  path: string;
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

export interface Section {
  /** 0-based page where the section starts. */
  page: number;
  title: string;
}

export interface SeparationLayer {
  /** E.g. "Con dấu", "Chữ ký". */
  name: string;
  /** Reference colour of the layer. */
  colorHex: string;
  /** @default 60 */
  tolerance?: number;
}

/** Options of one signature, without any placement. */
export interface SignOptions {
  /**
   * B-B: signature only. B-T: + timestamp. B-LT: + revocation data. B-LTA: + document timestamp for long-term validity.
   * @default "B-B"
   */
  level?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  /** @default "sha256" */
  digest?: 'sha256' | 'sha384' | 'sha512';
  /** Timestamp servers, tried in order. Required for B-T and above. */
  tsaUrls?: string[];
  /** Extra trust roots (PEM or DER files, or folders of them) for B-LT and B-LTA. The bundled and user trust stores are always used. */
  trustRootPaths?: string[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Look of a visible signature. Default: a plain text box. */
  template?: SignatureTemplate;
  /** Certify the document (DocMDP) with this signature. Only for the first signature of a document. no-changes: P=1; form-fill: P=2; annotate: P=3. */
  certify?: 'no-changes' | 'form-fill' | 'annotate';
}

/** Sign the document with a certificate file (PAdES). Same options as sign.padesToken. */
export interface SignPadesParams {
  /**
   * B-B: signature only. B-T: + timestamp. B-LT: + revocation data. B-LTA: + document timestamp for long-term validity.
   * @default "B-B"
   */
  level?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  /** @default "sha256" */
  digest?: 'sha256' | 'sha384' | 'sha512';
  /** Timestamp servers, tried in order. Required for B-T and above. */
  tsaUrls?: string[];
  /** Extra trust roots (PEM or DER files, or folders of them) for B-LT and B-LTA. The bundled and user trust stores are always used. */
  trustRootPaths?: string[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Look of a visible signature. Default: a plain text box. */
  template?: SignatureTemplate;
  /** Certify the document (DocMDP) with this signature. Only for the first signature of a document. no-changes: P=1; form-fill: P=2; annotate: P=3. */
  certify?: 'no-changes' | 'form-fill' | 'annotate';
  /** Signature field name. Default: the first free Signature<N>. */
  fieldName?: string;
  /** 0-based page for a visible signature. Needs rect. */
  page?: number;
  /** [x1, y1, x2, y2] in PDF points. Needs page. Also draws into an existing empty field of that name. */
  rect?: number[];
  /** Path to the .pfx or .p12 file. */
  pfxPath: string;
  /** Password of the certificate file. Never stored, logged or echoed back. */
  password?: string;
}

/** Sign the document with a key on a USB token (PAdES). Same options as sign.pades. */
export interface SignPadesTokenParams {
  /**
   * B-B: signature only. B-T: + timestamp. B-LT: + revocation data. B-LTA: + document timestamp for long-term validity.
   * @default "B-B"
   */
  level?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  /** @default "sha256" */
  digest?: 'sha256' | 'sha384' | 'sha512';
  /** Timestamp servers, tried in order. Required for B-T and above. */
  tsaUrls?: string[];
  /** Extra trust roots (PEM or DER files, or folders of them) for B-LT and B-LTA. The bundled and user trust stores are always used. */
  trustRootPaths?: string[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Look of a visible signature. Default: a plain text box. */
  template?: SignatureTemplate;
  /** Certify the document (DocMDP) with this signature. Only for the first signature of a document. no-changes: P=1; form-fill: P=2; annotate: P=3. */
  certify?: 'no-changes' | 'form-fill' | 'annotate';
  /** Signature field name. Default: the first free Signature<N>. */
  fieldName?: string;
  /** 0-based page for a visible signature. Needs rect. */
  page?: number;
  /** [x1, y1, x2, y2] in PDF points. Needs page. Also draws into an existing empty field of that name. */
  rect?: number[];
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

/** One stamp operation with its own parameters, exactly as that operation takes them. */
export interface StampStep {
  /** Stamp operation id. */
  op: 'stamp.text' | 'stamp.image' | 'stamp.seam' | 'stamp.initials' | 'overlay.watermark' | 'overlay.addText' | 'overlay.addImage';
  /** Params of that operation. */
  params?: Record<string, unknown>;
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

/** Up to three zones of one band (header or footer). Each zone is a template. */
export interface TextZones {
  /** @default "" */
  left?: string;
  /** @default "" */
  center?: string;
  /** @default "" */
  right?: string;
}

export interface TokenSigner {
  kind: 'token';
  /** Path of the PKCS#11 driver file. */
  modulePath: string;
  /** Slot of the token. */
  slotId?: number;
  /** Serial of the token, instead of slotId. */
  tokenSerial?: string;
  /** CKA_ID of the signing certificate, in hex (from sign.listTokens). */
  certId: string;
  /** Token PIN: one login for the whole batch. */
  pin: string;
  /**
   * Must be true to use the PIN when the token reports only one try left.
   * @default false
   */
  confirmFinalTry?: boolean;
}

/** No parameters: removes every bookmark. */
export interface BookmarksClearParams {
}

/**
 * One bookmark per selected page. `template` takes the page variables (default
 * "Trang {page}"). `mode` replace drops the existing outline, append adds at the end.
 */
export interface BookmarksFromPagesParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** @default "Trang {page}" */
  template?: string;
  /** @default 1 */
  startNumber?: number;
  /** @default "replace" */
  mode?: 'replace' | 'append';
  /** @default "dd/MM/yyyy" */
  dateFormat?: string;
}

/** No parameters: reads the outline of the current revision. */
export interface BookmarksGetParams {
}

/** Replace the whole outline with `bookmarks` (an empty list clears it). */
export interface BookmarksSetParams {
  bookmarks?: BookmarkNode[];
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

/**
 * Split an image into one transparent PNG per colour (I22).
 *
 * mode "layers": the colours are given in `layers`. mode "auto-two": the two dominant ink
 * colours are found by themselves (a red seal and a blue signature come out as two layers,
 * named "Con dấu" and "Chữ ký" when the colours say so).
 */
export interface ImageSeparateColorsParams {
  inputPath: string;
  /** Existing folder for the layer files. */
  outputDir: string;
  /** @default "layers" */
  mode?: 'layers' | 'auto-two';
  /** Needed in mode layers. */
  layers?: SeparationLayer[];
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

/**
 * Add a PNG or JPEG. Give `width` or `height` (the other follows the aspect ratio, both
 * fit inside), or `scale` (1.0 = natural size at 96 dpi). Default width is 150 pt.
 */
export interface OverlayAddImageParams {
  /** Anchor point, from the left edge of the displayed page. */
  x: number;
  /** Anchor point, from the top edge of the displayed page. */
  y: number;
  /** @default "pt" */
  unit?: 'pt' | 'mm';
  /**
   * Which point of the object is at x, y.
   * @default "top-left"
   */
  anchor?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /**
   * Degrees, counter-clockwise.
   * @default 0.0
   */
  rotation?: number;
  /** @default 1.0 */
  opacity?: number;
  /**
   * True puts it beneath the page content.
   * @default false
   */
  under?: boolean;
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** Absolute path of the image file. */
  path: string;
  width?: number;
  height?: number;
  scale?: number;
}

/** Add a text box. Line breaks in `text` are kept; `width` wraps lines to a box width. */
export interface OverlayAddTextParams {
  /** Anchor point, from the left edge of the displayed page. */
  x: number;
  /** Anchor point, from the top edge of the displayed page. */
  y: number;
  /** @default "pt" */
  unit?: 'pt' | 'mm';
  /**
   * Which point of the object is at x, y.
   * @default "top-left"
   */
  anchor?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /**
   * Degrees, counter-clockwise.
   * @default 0.0
   */
  rotation?: number;
  /** @default 1.0 */
  opacity?: number;
  /**
   * True puts it beneath the page content.
   * @default false
   */
  under?: boolean;
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  text: string;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 12.0 */
  fontSize?: number;
  /** @default false */
  bold?: boolean;
  /** @default "#000000" */
  color?: string;
  /** @default "left" */
  align?: 'left' | 'center' | 'right';
  /** @default 1.2 */
  lineHeight?: number;
  /** Box width in unit; wraps lines. */
  width?: number;
}

/**
 * A linear barcode: Code 128 (any ASCII), EAN-13 (12 or 13 digits) or Code 39 (no check
 * digit added). `moduleWidth` is the width of the narrowest bar; `height` the bar height.
 */
export interface OverlayBarcodeParams {
  /** Anchor point, from the left edge of the displayed page. */
  x: number;
  /** Anchor point, from the top edge of the displayed page. */
  y: number;
  /** @default "mm" */
  unit?: 'pt' | 'mm';
  /**
   * Which point of the object is at x, y.
   * @default "top-left"
   */
  anchor?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /**
   * Degrees, counter-clockwise.
   * @default 0.0
   */
  rotation?: number;
  /** @default 1.0 */
  opacity?: number;
  /**
   * True puts it beneath the page content.
   * @default false
   */
  under?: boolean;
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** @default "code128" */
  kind?: 'code128' | 'ean13' | 'code39';
  content: string;
  /** @default 0.33 */
  moduleWidth?: number;
  /** @default 15.0 */
  height?: number;
  /**
   * Modules of white border.
   * @default 10
   */
  quietZone?: number;
  /** @default "#000000" */
  color?: string;
  /** None: transparent. */
  background?: string;
  /** Text below. */
  label?: string;
  /** @default 8.0 */
  labelFontSize?: number;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 1 */
  startNumber?: number;
  /** @default "dd/MM/yyyy" */
  dateFormat?: string;
}

/** Bates numbers on every page of many PDFs, one running sequence in list order. */
export interface OverlayBatesParams {
  files: BatesFile[];
  /**
   * Text before the number.
   * @default ""
   */
  prefix?: string;
  /**
   * Text after the number.
   * @default ""
   */
  suffix?: string;
  /** @default 1 */
  startNumber?: number;
  /**
   * Zero padding of the number.
   * @default 6
   */
  digits?: number;
  /** @default "bottom-right" */
  position?: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'outside-alternating';
  margins?: Margins;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 9.0 */
  fontSize?: number;
  /** @default false */
  bold?: boolean;
  /** @default "#000000" */
  color?: string;
  /** @default 1.0 */
  opacity?: number;
  output?: BatesOutput;
  /**
   * Stop after the first failed file; the rest are skipped.
   * @default false
   */
  stopOnError?: boolean;
}

/**
 * Header and footer text on the selected pages. Each band has left, centre and right zones.
 * Variables: {page} {pages} {page_roman} {page_alpha} {date} {time} {filename} {title}
 * {author} {bates} {section}; `{{` writes a brace. `mirrorOddEven` swaps the left and right
 * zones (and their margins) on even pages, for two-sided printing.
 */
export interface OverlayHeaderFooterParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  header?: TextZones;
  footer?: TextZones;
  margins?: Margins;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 10.0 */
  fontSize?: number;
  /** @default false */
  bold?: boolean;
  /** @default "#000000" */
  color?: string;
  /** @default 1.0 */
  opacity?: number;
  /** @default "dd/MM/yyyy" */
  dateFormat?: string;
  /**
   * Leave the first page alone.
   * @default false
   */
  skipFirst?: boolean;
  /** @default 1 */
  startNumber?: number;
  /** @default false */
  mirrorOddEven?: boolean;
  sections?: Section[];
  /** @default "" */
  batesPrefix?: string;
  /** @default "" */
  batesSuffix?: string;
  /** @default 6 */
  batesDigits?: number;
}

/**
 * Place a page of another PDF (the letterhead) on the selected pages. `sourcePage` (0-based)
 * is used for every page. `first`, `odd`, `even` and `rest` (0-based source pages)
 * choose by target page: the first page, odd-numbered pages (1, 3, 5...), even-numbered pages,
 * and any other page. Mapping fields take priority over `sourcePage`.
 */
export interface OverlayLetterheadParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** PDF that holds the letterhead. */
  sourcePath: string;
  sourcePage?: number;
  first?: number;
  odd?: number;
  even?: number;
  rest?: number;
  /** @default "fit" */
  scaling?: 'none' | 'fit';
  /** @default true */
  under?: boolean;
}

/** No parameters: lists the overlays of the current revision. */
export interface OverlayListOverlaysParams {
}

/**
 * Page numbers. `template` may hold other variables; {page} and {pages} use
 * `numberFormat`. `preset: nd30` applies the Nghị định 30/2020/NĐ-CP rule (see module).
 */
export interface OverlayPageNumbersParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  preset?: 'nd30';
  /** @default "arabic" */
  numberFormat?: 'arabic' | 'roman' | 'ROMAN' | 'alpha' | 'ALPHA';
  /** @default "{page}" */
  template?: string;
  /** @default "bottom-center" */
  position?: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'outside-alternating';
  margins?: Margins;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 12.0 */
  fontSize?: number;
  /** @default false */
  bold?: boolean;
  /** @default "#000000" */
  color?: string;
  /** @default 1.0 */
  opacity?: number;
  /** @default 1 */
  startNumber?: number;
  /** @default false */
  skipFirst?: boolean;
  skipPages?: number[];
  /**
   * Also set /PageLabels on the document.
   * @default false
   */
  writeLabels?: boolean;
  /** @default "dd/MM/yyyy" */
  dateFormat?: string;
}

/**
 * A QR code. `size` is the side of the whole box, quiet zone included. The default unit is
 * millimetres. `content` may use page variables such as {page} or {filename}.
 */
export interface OverlayQrCodeParams {
  /** Anchor point, from the left edge of the displayed page. */
  x: number;
  /** Anchor point, from the top edge of the displayed page. */
  y: number;
  /** @default "mm" */
  unit?: 'pt' | 'mm';
  /**
   * Which point of the object is at x, y.
   * @default "top-left"
   */
  anchor?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /**
   * Degrees, counter-clockwise.
   * @default 0.0
   */
  rotation?: number;
  /** @default 1.0 */
  opacity?: number;
  /**
   * True puts it beneath the page content.
   * @default false
   */
  under?: boolean;
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  content: string;
  /**
   * L, M, Q or H.
   * @default "M"
   */
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  /**
   * Modules of white border.
   * @default 4
   */
  quietZone?: number;
  /** @default 25.0 */
  size?: number;
  /** @default "#000000" */
  color?: string;
  /** None: transparent. */
  background?: string;
  /** Text below. */
  label?: string;
  /** @default 8.0 */
  labelFontSize?: number;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 1 */
  startNumber?: number;
  /** @default "dd/MM/yyyy" */
  dateFormat?: string;
}

/**
 * Remove overlays added by Chef PDF. Give at least one selector; all given selectors must
 * match.
 */
export interface OverlayRemoveParams {
  ids?: string[];
  group?: string;
  kind?: 'text' | 'image' | 'watermark' | 'stamp' | 'header' | 'footer' | 'number' | 'qr' | 'letterhead';
}

/**
 * A text or image watermark, rotated and faint by default. `mode` `center` puts one copy
 * in the middle of each page; `tiled` repeats it over the page with `spacing` points
 * between copies. Sizes and spacing are in points.
 */
export interface OverlayWatermarkParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  text?: string;
  path?: string;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 60.0 */
  fontSize?: number;
  /** @default false */
  bold?: boolean;
  /** @default "#808080" */
  color?: string;
  /** @default 0.25 */
  opacity?: number;
  /** @default 45.0 */
  rotation?: number;
  /** @default "center" */
  mode?: 'center' | 'tiled';
  /** @default 60.0 */
  spacing?: number;
  /** Image width in points. */
  width?: number;
  /** Image height in points. */
  height?: number;
  /** @default false */
  under?: boolean;
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

/** Sign many PDFs with one certificate (PFX or token). One set of options for all files. */
export interface SignBatchParams {
  files: BatchFile[];
  signer: PfxSigner | TokenSigner;
  common?: SignOptions;
  /** Where the visible box goes on each file. Default: no box. */
  placement?: RectPlacement | FixedPlacement | AnchorPlacement | InvisiblePlacement;
  output?: BatchOutput;
  /**
   * Stop after the first failed file; the rest are skipped.
   * @default false
   */
  stopOnError?: boolean;
  /**
   * Check each output with the verifier (verification field).
   * @default false
   */
  verifyAfter?: boolean;
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

/** Sign the document with a certificate file (PAdES). Same options as sign.padesToken. */
export interface SignPadesParams {
  /**
   * B-B: signature only. B-T: + timestamp. B-LT: + revocation data. B-LTA: + document timestamp for long-term validity.
   * @default "B-B"
   */
  level?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  /** @default "sha256" */
  digest?: 'sha256' | 'sha384' | 'sha512';
  /** Timestamp servers, tried in order. Required for B-T and above. */
  tsaUrls?: string[];
  /** Extra trust roots (PEM or DER files, or folders of them) for B-LT and B-LTA. The bundled and user trust stores are always used. */
  trustRootPaths?: string[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Look of a visible signature. Default: a plain text box. */
  template?: SignatureTemplate;
  /** Certify the document (DocMDP) with this signature. Only for the first signature of a document. no-changes: P=1; form-fill: P=2; annotate: P=3. */
  certify?: 'no-changes' | 'form-fill' | 'annotate';
  /** Signature field name. Default: the first free Signature<N>. */
  fieldName?: string;
  /** 0-based page for a visible signature. Needs rect. */
  page?: number;
  /** [x1, y1, x2, y2] in PDF points. Needs page. Also draws into an existing empty field of that name. */
  rect?: number[];
  /** Path to the .pfx or .p12 file. */
  pfxPath: string;
  /** Password of the certificate file. Never stored, logged or echoed back. */
  password?: string;
}

/** Sign the document with a key on a USB token (PAdES). Same options as sign.pades. */
export interface SignPadesTokenParams {
  /**
   * B-B: signature only. B-T: + timestamp. B-LT: + revocation data. B-LTA: + document timestamp for long-term validity.
   * @default "B-B"
   */
  level?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  /** @default "sha256" */
  digest?: 'sha256' | 'sha384' | 'sha512';
  /** Timestamp servers, tried in order. Required for B-T and above. */
  tsaUrls?: string[];
  /** Extra trust roots (PEM or DER files, or folders of them) for B-LT and B-LTA. The bundled and user trust stores are always used. */
  trustRootPaths?: string[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Look of a visible signature. Default: a plain text box. */
  template?: SignatureTemplate;
  /** Certify the document (DocMDP) with this signature. Only for the first signature of a document. no-changes: P=1; form-fill: P=2; annotate: P=3. */
  certify?: 'no-changes' | 'form-fill' | 'annotate';
  /** Signature field name. Default: the first free Signature<N>. */
  fieldName?: string;
  /** 0-based page for a visible signature. Needs rect. */
  page?: number;
  /** [x1, y1, x2, y2] in PDF points. Needs page. Also draws into an existing empty field of that name. */
  rect?: number[];
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

/** Stamps first, then one PAdES signature with a certificate file (PFX / P12). */
export interface SignStampAndSignParams {
  stamps: StampStep[];
  sign: SignPadesParams;
}

/** Stamps first, then one PAdES signature with a key on a USB token. */
export interface SignStampAndSignTokenParams {
  stamps: StampStep[];
  sign: SignPadesTokenParams;
}

/** Render a signature template with sample values to a PNG file. */
export interface SignTemplatePreviewParams {
  template?: SignatureTemplate;
  values?: PreviewValues;
  /** Box width in points. */
  width: number;
  /** Box height in points. */
  height: number;
  /** PNG file to write. */
  outputPath: string;
  /** @default 144 */
  dpi?: number;
}

/** Trust the certificates of a file (a root or an intermediate CA). */
export interface SignTrustAddParams {
  /** Certificate file: PEM (one or more) or DER. */
  path: string;
  /**
   * vn-public-ca: a public CA of Vietnam. vn-gov-ca: the government CA. user: anything else. Shown in the trust list.
   * @default "user"
   */
  group?: 'vn-public-ca' | 'vn-gov-ca' | 'user';
}

/** No parameters: the bundled and the user certificates. */
export interface SignTrustListParams {
}

/** Stop trusting a certificate that was added by the user. */
export interface SignTrustRemoveParams {
  /** SHA-256 fingerprint as listed by sign.trustList (colons optional). */
  fingerprintSha256: string;
}

/** Verify the signatures of the document. */
export interface SignVerifyParams {
  /** Extra trust roots: certificate files (PEM or DER) or folders of them. The bundled and user trust stores are always used. */
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

/** Check many PDFs and write the report. Give `files` or `folder`, not both. */
export interface SignVerifyBatchParams {
  /** Extra trust roots: certificate files (PEM or DER) or folders of them. The bundled and user trust stores are always used. */
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
  files?: ReportFile[];
  folder?: string;
  /**
   * Folder mode: include subfolders.
   * @default false
   */
  recursive?: boolean;
  /** Report file to write (replaced atomically). */
  reportPath: string;
  /** @default "csv" */
  format?: 'csv' | 'xlsx';
}

/** Verify the signatures of a PDF file (no session needed). */
export interface SignVerifyFileParams {
  /** Extra trust roots: certificate files (PEM or DER) or folders of them. The bundled and user trust stores are always used. */
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

/**
 * A PNG (with alpha) or JPEG stamp. Give width or height; the other follows the aspect
 * ratio. Default width is 150 pt. `blendMultiply` makes white transparent and lets the ink
 * darken what is below, like a real seal.
 */
export interface StampImageParams {
  /** Anchor point, from the left edge of the displayed page. */
  x: number;
  /** Anchor point, from the top edge of the displayed page. */
  y: number;
  /** @default "pt" */
  unit?: 'pt' | 'mm';
  /**
   * Which point of the object is at x, y.
   * @default "top-left"
   */
  anchor?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /**
   * Degrees, counter-clockwise.
   * @default 0.0
   */
  rotation?: number;
  /** @default 1.0 */
  opacity?: number;
  /**
   * True puts it beneath the page content.
   * @default false
   */
  under?: boolean;
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** Absolute path of the image file. */
  path: string;
  width?: number;
  height?: number;
  /** @default false */
  blendMultiply?: boolean;
}

/**
 * Initials (text or a small image) at the same corner or edge of every selected page.
 * For alternate pages use `pageRange` "odd" or "even".
 */
export interface StampInitialsParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  text?: string;
  /** PNG or JPEG of the initials. */
  path?: string;
  /**
   * Corner or edge of the page.
   * @default "bottom-right"
   */
  position?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /** @default 10.0 */
  marginMm?: number;
  /**
   * Image width (image only).
   * @default 25.0
   */
  widthMm?: number;
  /**
   * Text size (text only).
   * @default 14.0
   */
  fontSize?: number;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default false */
  bold?: boolean;
  /** @default "#1F4E9A" */
  color?: string;
  /** @default 1.0 */
  opacity?: number;
  /** @default false */
  blendMultiply?: boolean;
}

/** No parameters: the built-in text stamp presets. */
export interface StampPresetsParams {
}

/**
 * Dấu giáp lai: one seal image cut into N vertical strips, one strip flush against the
 * right (or left) edge of each selected page. Fanned out, the pages show the whole seal.
 *
 * N is the number of selected pages, or `groupSize` pages per set (a 30-page document with
 * groupSize 10 gives three sets of ten strips). `cutFirstPage` false leaves the first page of
 * each set without a strip, so the strips go to the remaining pages.
 * `overlapMm` widens every strip into its neighbour by that amount (a shared band).
 * `scaleWidthMm` is the width of the whole seal across all strips (default: natural size at
 * 96 dpi). `vertical` is "center", "top", "bottom", or a number of mm from the top edge.
 */
export interface StampSeamParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** Absolute path of the seal image (PNG or JPEG). */
  path: string;
  /** @default "right" */
  side?: 'right' | 'left';
  /**
   * Equal strips: the seal width is split into N equal parts.
   * @default "even"
   */
  sliceMode?: 'even';
  groupSize?: number;
  /** @default true */
  cutFirstPage?: boolean;
  /** @default "center" */
  vertical?: 'center' | 'top' | 'bottom' | number;
  /** @default 0.0 */
  overlapMm?: number;
  scaleWidthMm?: number;
  /** @default 1.0 */
  opacity?: number;
  /** @default false */
  blendMultiply?: boolean;
}

/**
 * A bordered text stamp such as "ĐÃ DUYỆT". Lines are separated by line breaks. The
 * placeholders {date}, {time}, {datetime} and {user} are filled when the stamp is made.
 */
export interface StampTextParams {
  /** Anchor point, from the left edge of the displayed page. */
  x: number;
  /** Anchor point, from the top edge of the displayed page. */
  y: number;
  /** @default "pt" */
  unit?: 'pt' | 'mm';
  /**
   * Which point of the object is at x, y.
   * @default "top-left"
   */
  anchor?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /**
   * Degrees, counter-clockwise.
   * @default 0.0
   */
  rotation?: number;
  /** @default 1.0 */
  opacity?: number;
  /**
   * True puts it beneath the page content.
   * @default false
   */
  under?: boolean;
  /** 0-based pages; default all. */
  pages?: number[];
  /** 1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all". */
  pageRange?: string;
  /** Lines separated by \n. Placeholders: {date} {time} {datetime} {user}. */
  text: string;
  /** @default "BeVietnamPro" */
  fontName?: 'BeVietnamPro';
  /** @default 24.0 */
  fontSize?: number;
  /** @default true */
  bold?: boolean;
  /**
   * Text and border colour.
   * @default "#C00000"
   */
  color?: string;
  /** Box fill; none = transparent. */
  fill?: string;
  /** Default: the text colour. */
  borderColor?: string;
  /**
   * Points; 0 = no border.
   * @default 2.0
   */
  borderWidth?: number;
  /**
   * Points inside the border.
   * @default 6.0
   */
  padding?: number;
  /** @default 1.2 */
  lineHeight?: number;
  /** Value of {user}. */
  user?: string;
  /**
   * Multiply: the ink darkens the text.
   * @default false
   */
  blendMultiply?: boolean;
}

/** Params type of every operation, by op id. */
export interface OpParams {
  'bookmarks.clear': BookmarksClearParams;
  'bookmarks.fromPages': BookmarksFromPagesParams;
  'bookmarks.get': BookmarksGetParams;
  'bookmarks.set': BookmarksSetParams;
  'file.merge': FileMergeParams;
  'file.split': FileSplitParams;
  'image.cleanup': ImageCleanupParams;
  'image.fromStrokes': ImageFromStrokesParams;
  'image.removeBackground': ImageRemoveBackgroundParams;
  'image.separateColors': ImageSeparateColorsParams;
  'image.textSignature': ImageTextSignatureParams;
  'overlay.addImage': OverlayAddImageParams;
  'overlay.addText': OverlayAddTextParams;
  'overlay.barcode': OverlayBarcodeParams;
  'overlay.bates': OverlayBatesParams;
  'overlay.headerFooter': OverlayHeaderFooterParams;
  'overlay.letterhead': OverlayLetterheadParams;
  'overlay.listOverlays': OverlayListOverlaysParams;
  'overlay.pageNumbers': OverlayPageNumbersParams;
  'overlay.qrCode': OverlayQrCodeParams;
  'overlay.remove': OverlayRemoveParams;
  'overlay.watermark': OverlayWatermarkParams;
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
  'sign.batch': SignBatchParams;
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
  'sign.stampAndSign': SignStampAndSignParams;
  'sign.stampAndSignToken': SignStampAndSignTokenParams;
  'sign.templatePreview': SignTemplatePreviewParams;
  'sign.trustAdd': SignTrustAddParams;
  'sign.trustList': SignTrustListParams;
  'sign.trustRemove': SignTrustRemoveParams;
  'sign.verify': SignVerifyParams;
  'sign.verifyBatch': SignVerifyBatchParams;
  'sign.verifyFile': SignVerifyFileParams;
  'stamp.image': StampImageParams;
  'stamp.initials': StampInitialsParams;
  'stamp.presets': StampPresetsParams;
  'stamp.seam': StampSeamParams;
  'stamp.text': StampTextParams;
}

export type OpId = keyof OpParams;

export const OP_IDS = [
  'bookmarks.clear',
  'bookmarks.fromPages',
  'bookmarks.get',
  'bookmarks.set',
  'file.merge',
  'file.split',
  'image.cleanup',
  'image.fromStrokes',
  'image.removeBackground',
  'image.separateColors',
  'image.textSignature',
  'overlay.addImage',
  'overlay.addText',
  'overlay.barcode',
  'overlay.bates',
  'overlay.headerFooter',
  'overlay.letterhead',
  'overlay.listOverlays',
  'overlay.pageNumbers',
  'overlay.qrCode',
  'overlay.remove',
  'overlay.watermark',
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
  'sign.batch',
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
  'sign.stampAndSign',
  'sign.stampAndSignToken',
  'sign.templatePreview',
  'sign.trustAdd',
  'sign.trustList',
  'sign.trustRemove',
  'sign.verify',
  'sign.verifyBatch',
  'sign.verifyFile',
  'stamp.image',
  'stamp.initials',
  'stamp.presets',
  'stamp.seam',
  'stamp.text',
] as const;
