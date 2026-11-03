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

export interface BatchExportFile {
  /** PDF to export. */
  path: string;
  /** Password of this PDF, when it is encrypted. Never stored or echoed back. */
  password?: string;
}

export interface BatchExportOutput {
  /**
   * suffix: next to each input, name + suffix. folder: all into one folder.
   * @default "suffix"
   */
  mode?: 'suffix' | 'folder';
  /** @default "_export" */
  suffix?: string;
  folder?: string;
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

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Corners TL, TR, BR, BL as fractions (0..1) of the page image. */
export interface CropPage {
  pageIndex: number;
  corners: CropPoint[];
  /**
   * Fine rotation in degrees counter-clockwise after cropping.
   * @default 0
   */
  angle?: number;
  /** Output pixels [w, h]; default from the corners. */
  outSize?: number[];
}

export interface CropPoint {
  x: number;
  y: number;
}

/** Options shared by the exporters. Defaults give a plain, complete export of the body. */
export interface ExportOptions {
  /**
   * Repeated headers, footers and page numbers. Off: they are left out.
   * @default false
   */
  includeHeadersFooters?: boolean;
  /**
   * Images and vector figures.
   * @default true
   */
  includeImages?: boolean;
  /**
   * HTML only: images inside the file.
   * @default false
   */
  embedImages?: boolean;
  /**
   * TXT only: a line per source page.
   * @default false
   */
  pageMarkers?: boolean;
  /**
   * XLSX only: numbers (1.234,56) and dates (dd/mm/yyyy) as typed.
   * @default true
   */
  parseNumbers?: boolean;
  /**
   * EPUB only: a chapter per level-1 heading, or per N pages.
   * @default "heading1"
   */
  chapterMode?: 'heading1' | 'pages';
  /**
   * EPUB, chapterMode=pages.
   * @default 10
   */
  pagesPerChapter?: number;
  /**
   * DOCX only: 'editable' flowing text, 'layout' positioned frames per page.
   * @default "editable"
   */
  mode?: 'editable' | 'layout';
  /**
   * DOCX editable: a page break at each source page.
   * @default false
   */
  pageBreaks?: boolean;
  /** Overrides the title. */
  title?: string;
  /** Overrides the author. */
  author?: string;
  /**
   * BCP 47 tag.
   * @default "vi"
   */
  language?: string;
  /**
   * REFRESH only: paper size; 'source' uses the first page's size.
   * @default "A4"
   */
  pageSize?: 'A4' | 'Letter' | 'source';
  /**
   * REFRESH only.
   * @default 1.0
   */
  fontScale?: number;
  /**
   * REFRESH only, in points.
   * @default 56.0
   */
  margins?: number;
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

export interface Levels {
  /** @default 0 */
  black?: number;
  /** @default 255 */
  white?: number;
  /** @default 1.0 */
  gamma?: number;
}

/** An area to redact by hand (displayed frame, points, origin top-left). */
export interface ManualRect {
  pageIndex: number;
  rect: number[];
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

export interface PageMargins {
  /**
   * mm
   * @default 0
   */
  top?: number;
  /**
   * mm
   * @default 0
   */
  bottom?: number;
  /**
   * mm
   * @default 0
   */
  left?: number;
  /**
   * mm
   * @default 0
   */
  right?: number;
}

/** What a reader may do when the file is opened with the user password. */
export interface PermissionFlags {
  /**
   * Print at low resolution.
   * @default true
   */
  printLowRes?: boolean;
  /**
   * Print at high resolution. Needs printLowRes.
   * @default true
   */
  printHighRes?: boolean;
  /**
   * Copy text and images.
   * @default true
   */
  copyContent?: boolean;
  /**
   * Make other changes to the document.
   * @default true
   */
  modify?: boolean;
  /**
   * Add or change comments.
   * @default true
   */
  annotate?: boolean;
  /**
   * Fill in form fields.
   * @default true
   */
  fillForms?: boolean;
  /**
   * Insert, delete, rotate pages.
   * @default true
   */
  assemble?: boolean;
  /**
   * Accessibility tools may read it.
   * @default true
   */
  accessibility?: boolean;
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

/** A rectangle as fractions (0..1) of the page image. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RectPlacement {
  kind: 'rect';
  /** 0-based page. */
  page: number;
  /** [x1, y1, x2, y2] in PDF points, the same on every file. */
  rect: number[];
}

/** One search pattern. `value` is required for literal and regex. */
export interface RedactPattern {
  kind: 'literal' | 'regex' | 'cccd' | 'phone' | 'email' | 'bankAccount' | 'taxCode' | 'date';
  value?: string;
  /** @default true */
  ignoreDiacritics?: boolean;
}

export interface RenameMapping {
  source: string;
  target: string;
}

/** A file to check. Encrypted PDFs are reported as errors (no password is used here). */
export interface ReportFile {
  path: string;
}

export interface ReviewChange {
  pageIndex: number;
  blockIndex: number;
  kind: 'heading' | 'paragraph' | 'header' | 'footer' | 'pageNumber' | 'footnote' | 'unknown';
  /** @default 1 */
  level?: number;
  text?: string;
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

/** Properties to change. Only the keys present in the request are changed. */
export interface UpdateProps {
  label?: string;
  required?: boolean;
  readOnly?: boolean;
  maxLen?: number;
  fontSize?: number;
  textColour?: string;
  borderColour?: string;
  borderWidth?: number;
  background?: string;
  alignment?: 0 | 1 | 2;
  options?: string[];
  rect?: number[];
  value?: boolean | string | string[];
}

export interface WorkflowFile {
  /** PDF file to process. */
  path: string;
  /** Password of this PDF, when it is encrypted. Never stored or echoed back. */
  password?: string;
}

export interface WorkflowOutput {
  /**
   * suffix: next to the input. folder: into a folder.
   * @default "suffix"
   */
  mode?: 'suffix' | 'folder' | 'overwrite';
  /** @default "_da-xu-ly" */
  suffix?: string;
  folder?: string;
  /** Name template, e.g. {name}_{date}_da-ky. */
  nameTemplate?: string;
  /**
   * Lưu thêm PDF đã xử lý khi quy trình có bước xuất tài liệu.
   * @default false
   */
  alsoSavePdf?: boolean;
  /** Giới hạn dung lượng PDF cuối cùng; file vượt giới hạn sẽ được báo lỗi. */
  maxBytes?: number;
}

/** A text box with a Unicode font. rect is displayed (left, top, right, bottom). */
export interface AnnotsAddFreeTextParams {
  pageIndex: number;
  rect: number[];
  text: string;
  /** @default 12.0 */
  fontSize?: number;
  /** @default "#000000" */
  color?: string;
  background?: string;
  /** @default "#000000" */
  borderColor?: string;
  /** @default 0.0 */
  borderWidth?: number;
  /** @default "" */
  author?: string;
}

/** Freehand strokes; each point is a displayed [x, y] pair. */
export interface AnnotsAddInkParams {
  pageIndex: number;
  strokes: number[][][];
  color?: string;
  /** @default 2.0 */
  width?: number;
  /** @default 1.0 */
  opacity?: number;
  /** @default "" */
  author?: string;
}

/** A sticky note at a displayed point (its icon is 20 x 20 points). */
export interface AnnotsAddNoteParams {
  pageIndex: number;
  left: number;
  top: number;
  contents: string;
  /** @default "" */
  author?: string;
  /** @default "Note" */
  icon?: 'Note' | 'Comment' | 'Key' | 'Help' | 'NewParagraph' | 'Paragraph' | 'Insert';
  color?: string;
  /** @default 1.0 */
  opacity?: number;
}

/** A line, an arrow, a rectangle or an ellipse. Give points (line, arrow) or rect. */
export interface AnnotsAddShapeParams {
  pageIndex: number;
  kind: 'line' | 'arrow' | 'rect' | 'ellipse';
  rect?: number[];
  points?: number[];
  color?: string;
  fill?: string;
  /** @default 1.5 */
  width?: number;
  /** @default "" */
  author?: string;
}

/** Highlight, underline, strike-out or squiggly under rects or under found text. */
export interface AnnotsAddTextMarkupParams {
  pageIndex: number;
  kind: 'highlight' | 'underline' | 'strike' | 'squiggly';
  /** Displayed boxes [left, top, right, bottom], one per line. */
  rects?: number[][];
  /** Text to mark (text model). */
  find?: string;
  /** @default false */
  allMatches?: boolean;
  color?: string;
  /** @default 1.0 */
  opacity?: number;
  /** @default "" */
  contents?: string;
  /** @default "" */
  author?: string;
}

/** Write a summary of the annotations to a file. The document is not changed. */
export interface AnnotsExportParams {
  /** File to write. */
  outputPath: string;
  /** @default "txt" */
  format?: 'txt' | 'md' | 'html' | 'csv' | 'xlsx' | 'json';
  /** 0-based pages; default all. */
  pages?: number[];
  /** Subtypes; default all. */
  kinds?: string[];
}

/** Burn annotations into the page content and remove them. */
export interface AnnotsFlattenParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /** Subtypes; default all. */
  kinds?: string[];
  /** @default true */
  keepLinks?: boolean;
  /** @default true */
  keepFormFields?: boolean;
}

/** Annotations (not links) of one page, or of every page. */
export interface AnnotsListParams {
  pageIndex?: number;
  /** Subtypes, e.g. Highlight, Text. */
  kinds?: string[];
  /** Case-insensitive part of the name. */
  author?: string;
  status?: 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'none';
}

/** Remove annotations by id. */
export interface AnnotsRemoveParams {
  ids: string[];
}

/** Remove every annotation of the given subtypes (default: all but links and form fields). */
export interface AnnotsRemoveAllParams {
  kinds?: string[];
  pageIndex?: number;
}

/** Answer an annotation with a text reply (threaded through /IRT). */
export interface AnnotsReplyParams {
  id: string;
  text: string;
  /** @default "" */
  author?: string;
  color?: string;
}

/** Review status of an annotation (/State with /StateModel /Review). */
export interface AnnotsSetStatusParams {
  id: string;
  status: 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'none';
}

/** Change the text, author, colour, opacity or (for notes, free text, ink, shapes) the rect. */
export interface AnnotsUpdateParams {
  id: string;
  contents?: string;
  author?: string;
  color?: string;
  opacity?: number;
  rect?: number[];
}

/** Full-page backgrounds (filled rectangles or images under all text). */
export interface BackgroundDetectParams {
  pages?: number[];
}

/** Remove or recolour the page backgrounds. */
export interface BackgroundRemoveParams {
  /** @default "remove" */
  mode?: 'remove' | 'replaceColor';
  /** #rrggbb for replaceColor. */
  color?: string;
  pages?: number[];
}

export interface BatchRunParams {
  /** Batchable operation id. */
  opId: string;
  /** Params of that operation. */
  params?: Record<string, unknown>;
  files: WorkflowFile[];
  /** Values of {{secret:name}} placeholders. Never stored, logged or echoed back. */
  secrets?: Record<string, string>;
  output?: WorkflowOutput;
  /**
   * Files at the same time.
   * @default 1
   */
  parallel?: number;
  /** @default false */
  stopOnError?: boolean;
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

/** Change colours on the selected pages. */
export interface ColorConvertParams {
  mode: 'gray' | 'blackwhite' | 'ink-saver' | 'replace-color';
  /** 0-based; default all. */
  pages?: number[];
  /**
   * blackwhite: the cut-off.
   * @default 128
   */
  threshold?: number;
  /**
   * blackwhite: dither the images.
   * @default false
   */
  dithering?: boolean;
  /**
   * ink-saver: how far to lighten.
   * @default 0.5
   */
  amount?: number;
  /** replace-color: '#rrggbb'. */
  sourceColor?: string;
  /** replace-color: '#rrggbb'. */
  targetColor?: string;
  /**
   * replace-color: per channel.
   * @default 24
   */
  tolerance?: number;
}

/** Compression settings. Fields left null take the value of the preset. */
export interface CompressEstimateParams {
  /**
   * screen 96 dpi / q55; ebook 150 dpi / q70; print 300 dpi / q85; archive-light: lossless only (no image resampling); custom: only the fields given.
   * @default "ebook"
   */
  preset?: 'screen' | 'ebook' | 'print' | 'archive-light' | 'custom';
  /** Largest effective image resolution in dpi. */
  maxImageDpi?: number;
  jpegQuality?: number;
  /**
   * Convert images to grayscale.
   * @default false
   */
  grayscale?: boolean;
  /** Drop XObject resources (images, forms) the pages do not use. */
  removeUnused?: boolean;
  /**
   * Remove the document information and XMP metadata.
   * @default false
   */
  removeMetadata?: boolean;
  /** Remove page thumbnails. */
  removeThumbnails?: boolean;
  /**
   * Remove embedded files.
   * @default false
   */
  removeAttachments?: boolean;
  /**
   * Remove annotations (form fields are kept).
   * @default false
   */
  removeAnnotations?: boolean;
  /**
   * Composite images with soft masks onto white.
   * @default false
   */
  flattenTransparency?: boolean;
  /**
   * Drop font resources the pages do not use. Producers already subset the embedded fonts, so this only removes unused font entries.
   * @default true
   */
  subsetFonts?: boolean;
  /** Re-encode plain Flate streams at level 9. */
  recompressStreams?: boolean;
  /** Store objects in compressed object streams. */
  useObjectStreams?: boolean;
}

export interface CompressFileParams {
  /**
   * screen 96 dpi / q55; ebook 150 dpi / q70; print 300 dpi / q85; archive-light: lossless only (no image resampling); custom: only the fields given.
   * @default "ebook"
   */
  preset?: 'screen' | 'ebook' | 'print' | 'archive-light' | 'custom';
  /** Largest effective image resolution in dpi. */
  maxImageDpi?: number;
  jpegQuality?: number;
  /**
   * Convert images to grayscale.
   * @default false
   */
  grayscale?: boolean;
  /** Drop XObject resources (images, forms) the pages do not use. */
  removeUnused?: boolean;
  /**
   * Remove the document information and XMP metadata.
   * @default false
   */
  removeMetadata?: boolean;
  /** Remove page thumbnails. */
  removeThumbnails?: boolean;
  /**
   * Remove embedded files.
   * @default false
   */
  removeAttachments?: boolean;
  /**
   * Remove annotations (form fields are kept).
   * @default false
   */
  removeAnnotations?: boolean;
  /**
   * Composite images with soft masks onto white.
   * @default false
   */
  flattenTransparency?: boolean;
  /**
   * Drop font resources the pages do not use. Producers already subset the embedded fonts, so this only removes unused font entries.
   * @default true
   */
  subsetFonts?: boolean;
  /** Re-encode plain Flate streams at level 9. */
  recompressStreams?: boolean;
  /** Store objects in compressed object streams. */
  useObjectStreams?: boolean;
  /** PDF to compress. */
  inputPath: string;
  /** PDF to write (may equal the input). */
  outputPath: string;
  /** Password of the input file. */
  password?: string;
}

export interface CompressFitSizeParams {
  /**
   * screen 96 dpi / q55; ebook 150 dpi / q70; print 300 dpi / q85; archive-light: lossless only (no image resampling); custom: only the fields given.
   * @default "ebook"
   */
  preset?: 'screen' | 'ebook' | 'print' | 'archive-light' | 'custom';
  /** Largest effective image resolution in dpi. */
  maxImageDpi?: number;
  jpegQuality?: number;
  /**
   * Convert images to grayscale.
   * @default false
   */
  grayscale?: boolean;
  /** Drop XObject resources (images, forms) the pages do not use. */
  removeUnused?: boolean;
  /**
   * Remove the document information and XMP metadata.
   * @default false
   */
  removeMetadata?: boolean;
  /** Remove page thumbnails. */
  removeThumbnails?: boolean;
  /**
   * Remove embedded files.
   * @default false
   */
  removeAttachments?: boolean;
  /**
   * Remove annotations (form fields are kept).
   * @default false
   */
  removeAnnotations?: boolean;
  /**
   * Composite images with soft masks onto white.
   * @default false
   */
  flattenTransparency?: boolean;
  /**
   * Drop font resources the pages do not use. Producers already subset the embedded fonts, so this only removes unused font entries.
   * @default true
   */
  subsetFonts?: boolean;
  /** Re-encode plain Flate streams at level 9. */
  recompressStreams?: boolean;
  /** Store objects in compressed object streams. */
  useObjectStreams?: boolean;
  /** Largest acceptable size of the result in bytes. */
  targetBytes: number;
  /**
   * Lowest image dpi to try.
   * @default 72
   */
  minDpi?: number;
  /**
   * Lowest JPEG quality.
   * @default 30
   */
  minJpegQuality?: number;
}

/** Compression settings. Fields left null take the value of the preset. */
export interface CompressPdfParams {
  /**
   * screen 96 dpi / q55; ebook 150 dpi / q70; print 300 dpi / q85; archive-light: lossless only (no image resampling); custom: only the fields given.
   * @default "ebook"
   */
  preset?: 'screen' | 'ebook' | 'print' | 'archive-light' | 'custom';
  /** Largest effective image resolution in dpi. */
  maxImageDpi?: number;
  jpegQuality?: number;
  /**
   * Convert images to grayscale.
   * @default false
   */
  grayscale?: boolean;
  /** Drop XObject resources (images, forms) the pages do not use. */
  removeUnused?: boolean;
  /**
   * Remove the document information and XMP metadata.
   * @default false
   */
  removeMetadata?: boolean;
  /** Remove page thumbnails. */
  removeThumbnails?: boolean;
  /**
   * Remove embedded files.
   * @default false
   */
  removeAttachments?: boolean;
  /**
   * Remove annotations (form fields are kept).
   * @default false
   */
  removeAnnotations?: boolean;
  /**
   * Composite images with soft masks onto white.
   * @default false
   */
  flattenTransparency?: boolean;
  /**
   * Drop font resources the pages do not use. Producers already subset the embedded fonts, so this only removes unused font entries.
   * @default true
   */
  subsetFonts?: boolean;
  /** Re-encode plain Flate streams at level 9. */
  recompressStreams?: boolean;
  /** Store objects in compressed object streams. */
  useObjectStreams?: boolean;
}

export interface CompressToSizeParams {
  /**
   * screen 96 dpi / q55; ebook 150 dpi / q70; print 300 dpi / q85; archive-light: lossless only (no image resampling); custom: only the fields given.
   * @default "ebook"
   */
  preset?: 'screen' | 'ebook' | 'print' | 'archive-light' | 'custom';
  /** Largest effective image resolution in dpi. */
  maxImageDpi?: number;
  jpegQuality?: number;
  /**
   * Convert images to grayscale.
   * @default false
   */
  grayscale?: boolean;
  /** Drop XObject resources (images, forms) the pages do not use. */
  removeUnused?: boolean;
  /**
   * Remove the document information and XMP metadata.
   * @default false
   */
  removeMetadata?: boolean;
  /** Remove page thumbnails. */
  removeThumbnails?: boolean;
  /**
   * Remove embedded files.
   * @default false
   */
  removeAttachments?: boolean;
  /**
   * Remove annotations (form fields are kept).
   * @default false
   */
  removeAnnotations?: boolean;
  /**
   * Composite images with soft masks onto white.
   * @default false
   */
  flattenTransparency?: boolean;
  /**
   * Drop font resources the pages do not use. Producers already subset the embedded fonts, so this only removes unused font entries.
   * @default true
   */
  subsetFonts?: boolean;
  /** Re-encode plain Flate streams at level 9. */
  recompressStreams?: boolean;
  /** Store objects in compressed object streams. */
  useObjectStreams?: boolean;
  /** Largest acceptable size of the result in bytes. */
  targetBytes: number;
  /**
   * Lowest image dpi to try.
   * @default 72
   */
  minDpi?: number;
  /**
   * Lowest JPEG quality.
   * @default 30
   */
  minJpegQuality?: number;
}

/** Edit the pixels of one image placement; the result is a new image XObject. */
export interface ContentAdjustImageParams {
  pageIndex: number;
  objectId: string;
  /** Crop rectangle in pixels. */
  crop?: CropBox;
  /**
   * Clockwise degrees: 0, 90, 180 or 270.
   * @default 0
   */
  rotate?: number;
  /** @default "none" */
  flip?: 'none' | 'h' | 'v';
  /** @default false */
  grayscale?: boolean;
  /** @default false */
  invert?: boolean;
  /** @default 0 */
  brightness?: number;
  /** @default 0 */
  contrast?: number;
  /** @default 0 */
  saturation?: number;
  /** @default 1.0 */
  gamma?: number;
}

/** Delete objects. Text keeps the position of the text after it. */
export interface ContentDeleteParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
}

/** Copy objects, displaced by dx, dy (displayed frame, points, y downwards). */
export interface ContentDuplicateParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
  /** @default 0.0 */
  dx?: number;
  /** @default 0.0 */
  dy?: number;
}

/** Erase a rectangle (displayed frame, points, origin top-left) on one or more pages. */
export interface ContentEraseRegionParams {
  /** One 0-based page. */
  pageIndex?: number;
  /** Several 0-based pages. */
  pages?: number[];
  /** x0, y0, x1, y1 in points. */
  rect: number[];
  /** @default "cut" */
  mode?: 'cut' | 'cover';
  /**
   * 'cover' only: 'auto' or '#rrggbb'.
   * @default "auto"
   */
  color?: string;
  /** @default true */
  includeText?: boolean;
  /** @default true */
  includeImages?: boolean;
  /** @default true */
  includeVectors?: boolean;
  /**
   * False: only objects lying completely inside the rectangle are removed.
   * @default true
   */
  partial?: boolean;
  /**
   * What the cut image pixels become. 'auto' means transparent.
   * @default "transparent"
   */
  imageFill?: 'transparent' | 'white' | 'auto';
}

/** Write the original image of a placement to a file. */
export interface ContentExtractImageParams {
  pageIndex: number;
  objectId: string;
  outputPath: string;
}

/** Objects under a point of a page. */
export interface ContentHitTestParams {
  pageIndex: number;
  x: number;
  /** Points from the top (unit 'pt') or user space y (unit 'user'). */
  y: number;
  /**
   * Coordinates to use.
   * @default "pt"
   */
  unit?: 'pt' | 'user';
  /**
   * Test the objects of forms.
   * @default true
   */
  includeForms?: boolean;
}

/** List the paint objects of one page. */
export interface ContentListObjectsParams {
  /** 0-based page. */
  pageIndex: number;
  /**
   * Also list objects drawn by forms.
   * @default false
   */
  includeForms?: boolean;
  /** Only these kinds. */
  kinds?: ('text' | 'image' | 'path' | 'shading' | 'form')[];
}

/** Move objects by a displacement in the displayed frame (points, y downwards). */
export interface ContentMoveParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
  /** @default 0.0 */
  dx?: number;
  /** @default 0.0 */
  dy?: number;
}

/** Find or remove the objects that look like one object of a page. */
export interface ContentRemoveSimilarParams {
  pageIndex: number;
  objectId: string;
  /** @default "all" */
  scope?: 'all' | 'others';
  /** @default 2.0 */
  toleranceMm?: number;
  /**
   * True lists the matches and changes nothing.
   * @default true
   */
  dryRun?: boolean;
}

/** Change the stacking order: front, back, one step forward or one step backward. */
export interface ContentReorderParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
  mode: 'front' | 'back' | 'forward' | 'backward';
}

/** Replace an image placement by another image file. */
export interface ContentReplaceImageParams {
  pageIndex: number;
  objectId: string;
  /** PNG or JPEG file. */
  path: string;
  /** @default "contain" */
  fit?: 'stretch' | 'contain' | 'cover';
  /**
   * False forces stretch: the image fills the old box.
   * @default true
   */
  keepAspectBox?: boolean;
}

/** Set the fill and/or stroke colour of text and paths ('#rrggbb'). */
export interface ContentSetColorParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
  fill?: string;
  stroke?: string;
}

/** Set the opacity of objects (0 transparent .. 1 opaque). */
export interface ContentSetOpacityParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
  opacity: number;
}

/** Transform objects by a matrix in page user space (PDF order a b c d e f). */
export interface ContentTransformParams {
  /** Object ids of the current revision. */
  ids: string[];
  /**
   * Allow editing objects drawn by forms (the page's forms are inlined).
   * @default false
   */
  flattenForms?: boolean;
  matrix: number[];
}

/** Objects of one page grouped by kind, with render hints for a kind filter. */
export interface ContentViewByTypeParams {
  /** 0-based page. */
  pageIndex: number;
  /** Kinds to show (None: all). */
  kinds?: ('text' | 'image' | 'path' | 'shading' | 'form')[];
  /**
   * Show only the kinds in kinds.
   * @default false
   */
  solo?: boolean;
}

/** Make a PDF with one page per image, in the order given. */
export interface ConvertImagesToPdfParams {
  /** Image files, in page order. */
  images: string[];
  /** PDF to write. */
  outputPath: string;
  /**
   * 'fit-image': page = image plus margin; 'a4' / 'letter' / 'custom': image placed on that page.
   * @default "a4"
   */
  pageSize?: 'fit-image' | 'a4' | 'letter' | 'custom';
  customWidthMm?: number;
  customHeightMm?: number;
  /** @default 10 */
  marginMm?: number;
  /**
   * auto: landscape page for landscape images.
   * @default "auto"
   */
  orientation?: 'auto' | 'portrait' | 'landscape';
  /**
   * fit: whole image inside the page; fill: cover the page (overflow clipped); center: natural size, centred and clipped to the page.
   * @default "fit"
   */
  fit?: 'fit' | 'fill' | 'center';
  /** Natural size in dpi; default: image metadata. */
  dpi?: number;
}

/** Render pages of a PDF to image files in `outputDir`. */
export interface ConvertPdfToImagesParams {
  /** PDF to render. */
  path: string;
  /** Password of the PDF. */
  password?: string;
  /** 0-based pages; default all. */
  pages?: number[];
  /** @default "png" */
  format?: 'png' | 'jpeg' | 'tiff' | 'webp';
  /**
   * Render resolution.
   * @default 150
   */
  dpi?: number;
  /**
   * 'color' RGB, 'gray', or 'bw' (1-bit, threshold 128).
   * @default "color"
   */
  color?: 'color' | 'gray' | 'bw';
  /**
   * JPEG and WebP quality.
   * @default 90
   */
  jpegQuality?: number;
  /**
   * TIFF only: one file with all pages instead of one per page.
   * @default false
   */
  multiPageTiff?: boolean;
  /** Directory for the image files. */
  outputDir: string;
  /**
   * File name: {name} (PDF name) and {page} (1-based, zero-padded).
   * @default "{name}_{page}"
   */
  nameTemplate?: string;
}

/** Attach files to the session document. */
export interface DocAttachmentsAddParams {
  /** Files to attach (absolute paths). */
  paths: string[];
  /**
   * Replace an attachment with the same name.
   * @default false
   */
  replace?: boolean;
}

/** Save attachments to a folder (all of them, or the named ones). */
export interface DocAttachmentsExtractParams {
  /** Folder for the attached files. */
  outputDir: string;
  /** Default: all. */
  names?: string[];
}

/** No parameters. */
export interface DocAttachmentsListParams {
}

/** Remove attachments by name. */
export interface DocAttachmentsRemoveParams {
  names: string[];
}

/** Extract the images of the selected pages into a folder (session document). */
export interface DocExtractImagesParams {
  /** Folder for the image files. */
  outputDir: string;
  /** 0-based pages; default all. */
  pages?: number[];
  /**
   * File name without extension: {name}, {page} (1-based), {index} (1-based on the page). The extension is .jpg, .jp2 or .png.
   * @default "{page}_{index}"
   */
  nameTemplate?: string;
}

/** Write the text of the session document to a UTF-8 file. */
export interface DocExtractTextParams {
  /** Text file to write. */
  outputPath: string;
  /**
   * Put "--- Trang N ---" before each page.
   * @default false
   */
  pageMarkers?: boolean;
}

/** Write a linearized copy of a PDF file. */
export interface DocOptimizeWebParams {
  /** PDF file to read. */
  inputPath: string;
  /** Password of the input file. */
  inputPassword?: string;
  /** Copy to write. May equal the input. */
  outputPath: string;
}

/** Repair a damaged PDF file and write a clean copy. */
export interface DocRepairParams {
  /** Damaged PDF file. */
  inputPath: string;
  /** Repaired copy to write. */
  outputPath: string;
}

/** Set document properties. Null: unchanged. Empty string: removed. */
export interface DocSetMetadataParams {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO 8601 date, e.g. 2024-03-01T09:30:00+07:00. Empty: removed. */
  creationDate?: string;
  /** ISO 8601 date. Empty: removed. */
  modDate?: string;
  /** Extra Info entries. Empty value removes the key. */
  custom?: Record<string, string>;
  /**
   * Remove all properties before applying.
   * @default false
   */
  clear?: boolean;
}

export interface ExportBatchParams {
  files: BatchExportFile[];
  /** An export format, or 'pdf' for the refreshed PDF. */
  format: 'md' | 'html' | 'txt' | 'json' | 'epub' | 'odt' | 'xlsx' | 'docx' | 'pdf';
  options?: ExportOptions;
  output?: BatchExportOutput;
  /** @default false */
  stopOnError?: boolean;
}

export interface ExportDocumentParams {
  format: 'md' | 'html' | 'txt' | 'json' | 'epub' | 'odt' | 'xlsx' | 'docx';
  /** File to write. */
  outputPath: string;
  /** 0-based pages; null for all. */
  pages?: number[];
  options?: ExportOptions;
  /** Reviewed model (layout.analyze modelPath). Null: analyse the document now. */
  modelPath?: string;
}

export interface ExportRefreshParams {
  /** PDF to write. */
  outputPath: string;
  pages?: number[];
  options?: ExportOptions;
  modelPath?: string;
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

/** Split one document into files at smart boundaries. */
export interface FileSplitSmartParams {
  /** PDF to split. */
  path: string;
  password?: string;
  mode: 'blank' | 'bookmarkLevel' | 'pattern';
  /**
   * bookmarkLevel: 1 = top level.
   * @default 1
   */
  level?: number;
  /** pattern: regular expression. */
  pattern?: string;
  /** @default true */
  ignoreCase?: boolean;
  /**
   * blank: leave the blank separator pages out of the files.
   * @default false
   */
  dropSeparatorPages?: boolean;
  /** @default 0.5 */
  blankSensitivity?: number;
  outputDir: string;
  /** @default "{name}_{index}" */
  nameTemplate?: string;
}

export interface FilesRenameBatchParams {
  files?: string[];
  template?: string;
  /** Exact renames (undo). */
  mapping?: RenameMapping[];
  /** @default "suffix" */
  conflict?: 'suffix' | 'skip' | 'overwrite';
  /**
   * True: only show old and new names.
   * @default true
   */
  dryRun?: boolean;
}

/** Create a field. `kind: signature` creates an empty signature field (sign.addField). */
export interface FormsAddFieldParams {
  kind: 'text' | 'multiline' | 'comb' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'button' | 'signature';
  pageIndex: number;
  /** [x0, top, x1, bottom] in displayed points. */
  rect: number[];
  /** Dotted name allowed, e.g. nguoithue.hoten. */
  name: string;
  /** Tooltip (TU). */
  label?: string;
  value?: boolean | string | string[];
  /** Choices (dropdown/listbox). */
  options?: string[];
  /** @default false */
  required?: boolean;
  /** @default false */
  readOnly?: boolean;
  maxLen?: number;
  /**
   * 0 = auto.
   * @default 0.0
   */
  fontSize?: number;
  /** @default "#000000" */
  textColour?: string;
  /** @default "#000000" */
  borderColour?: string | null;
  /** @default 1.0 */
  borderWidth?: number;
  background?: string;
  /**
   * 0 left, 1 centre, 2 right.
   * @default 0
   */
  alignment?: 0 | 1 | 2;
  /** check box/radio. */
  exportValue?: string;
  /** @default false */
  multiSelect?: boolean;
}

/** EXPERIMENTAL: proposals for text fields over blank lines of text. Changes nothing. */
export interface FormsDetectFieldsParams {
  pages?: number[];
}

/** Export the values of every field. Without `path` the text comes back in the result. */
export interface FormsExportDataParams {
  /** @default "json" */
  format?: 'json' | 'fdf' | 'xfdf' | 'csv';
  /** File to write. */
  path?: string;
}

/** Set field values. `values` maps the full field name to its value. */
export interface FormsFillParams {
  /** Full field name to value: text, bool for check boxes, option text or list. */
  values: Record<string, boolean | string | string[]>;
  /**
   * Flatten every field after filling (H3).
   * @default false
   */
  flatten?: boolean;
  /**
   * Allow writing to read-only fields.
   * @default false
   */
  force?: boolean;
  /**
   * Tint empty required fields so they are easy to find.
   * @default false
   */
  highlightRequired?: boolean;
}

export interface FormsFlattenParams {
  /** Default: every field. */
  names?: string[];
  pages?: number[];
  /** @default true */
  keepSignatures?: boolean;
  /** @default true */
  removeJavascript?: boolean;
}

/** No parameters. */
export interface FormsGetValuesParams {
}

/** Fill from a data file (JSON, FDF or XFDF). `format` defaults to the file extension. */
export interface FormsImportDataParams {
  path: string;
  format?: 'json' | 'fdf' | 'xfdf';
  /** @default false */
  force?: boolean;
}

/** No parameters. */
export interface FormsListParams {
}

export interface FormsRemoveParams {
  names: string[];
}

export interface FormsRenameParams {
  name: string;
  /** New partial name (no dots). */
  newName: string;
}

export interface FormsResetParams {
  /** Default: every field. */
  names?: string[];
  pages?: number[];
}

export interface FormsSetTabOrderParams {
  /** Full names, in tab order. */
  order: string[];
}

export interface FormsUpdateParams {
  name: string;
  properties: UpdateProps;
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

/** Report the hidden data of the session document. */
export interface InspectHiddenDataParams {
}

/** Remove the selected categories of hidden data (writes a new revision). */
export interface InspectRemoveHiddenParams {
  categories: ('metadata' | 'embeddedFiles' | 'javascript' | 'launchActions' | 'hiddenLayers' | 'comments' | 'formValues' | 'bookmarks' | 'thumbnails' | 'externalLinks' | 'xfa' | 'revisionHistory' | 'unusedObjects')[];
}

/** Make all content visible and remove the layer structure. */
export interface LayersFlattenParams {
}

/** List the optional-content groups (layers) of the document. */
export interface LayersListParams {
}

/** Remove layers. With deleteContent the content of the layers is deleted too. */
export interface LayersRemoveParams {
  /** Layer ids from layers.list. */
  layerIds: string[];
  /**
   * True deletes the marked content; False keeps it as plain content.
   * @default false
   */
  deleteContent?: boolean;
}

/** Make layers visible or hidden by default. */
export interface LayersSetVisibilityParams {
  /** Layer ids from layers.list. */
  layerIds: string[];
  visible: boolean;
}

/** Options of the rule-based analysis. `pages` null means every page. */
export interface LayoutAnalyzeParams {
  /** 0-based pages; null for all. */
  pages?: number[];
  /**
   * Header, footer, page number lines.
   * @default true
   */
  dropRepeated?: boolean;
  /**
   * Join paragraphs across breaks.
   * @default true
   */
  joinAcrossPages?: boolean;
  /**
   * Tables from ruling lines.
   * @default true
   */
  detectTables?: boolean;
  /**
   * Experimental; off by default.
   * @default false
   */
  borderlessTables?: boolean;
  /**
   * Continue a table on the next page.
   * @default true
   */
  joinTables?: boolean;
  language?: string;
  /**
   * Also return the model inline.
   * @default false
   */
  includeModel?: boolean;
}

export interface LayoutPageModelParams {
  /** 0-based page. */
  pageIndex: number;
  /**
   * Analyse the whole document, so repeated furniture is recognised.
   * @default false
   */
  context?: boolean;
}

export interface LayoutReviewParams {
  modelPath: string;
  changes: ReviewChange[];
}

/** A link on one page. rect is (left, top, right, bottom) in the displayed frame. */
export interface LinksAddParams {
  pageIndex: number;
  rect: number[];
  kind: 'uri' | 'page';
  uri?: string;
  targetPage?: number;
  /** @default "fit" */
  view?: 'fit' | 'xyz';
  /** xyz: displayed x (points). */
  left?: number;
  /** xyz: displayed y (points), default top. */
  top?: number;
  /** @default 0.0 */
  borderWidth?: number;
  color?: string;
  /** @default "invert" */
  highlight?: 'none' | 'invert' | 'outline';
}

/** URI links for the web and e-mail addresses in the text. */
export interface LinksAutoDetectParams {
  /** 0-based pages; default all. */
  pages?: number[];
  /**
   * Do not add a link where a link already covers the text.
   * @default true
   */
  skipExisting?: boolean;
}

/** Links of one page, or of every page when pageIndex is left out. */
export interface LinksListParams {
  pageIndex?: number;
}

/** Remove links by id, or every link (of one page when pageIndex is given). */
export interface LinksRemoveParams {
  ids?: string[];
  /** @default false */
  all?: boolean;
  pageIndex?: number;
}

/** Change one link. Give uri or targetPage to change its target. */
export interface LinksUpdateParams {
  id: string;
  rect?: number[];
  uri?: string;
  targetPage?: number;
  view?: 'fit' | 'xyz';
  left?: number;
  top?: number;
  borderWidth?: number;
  color?: string;
  highlight?: 'none' | 'invert' | 'outline';
}

export interface NamingApplyParams {
  /** Files to rename. */
  files: string[];
  /** Tokens: {name} {index} {seq:N} {date} {time} {pages} {parent} {title} {counter}. */
  template: string;
  /**
   * suffix | skip | overwrite.
   * @default "suffix"
   */
  conflict?: 'suffix' | 'skip' | 'overwrite';
}

export interface NamingPreviewParams {
  /** Files to rename. */
  files: string[];
  /** Tokens: {name} {index} {seq:N} {date} {time} {pages} {parent} {title} {counter}. */
  template: string;
  /**
   * suffix | skip | overwrite.
   * @default "suffix"
   */
  conflict?: 'suffix' | 'skip' | 'overwrite';
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

/** Set the page box of the selected pages. Give exactly one of margins, box or autoTrim. */
export interface PageCropParams {
  /** @default "all" */
  scope?: 'all' | 'odd' | 'even' | 'pages';
  /** For scope 'pages'. */
  pages?: number[];
  /** @default "cropbox" */
  mode?: 'cropbox' | 'mediabox';
  /** Cut from the displayed page edges. */
  margins?: PageMargins;
  /** x0, y0, x1, y1 in points. */
  box?: number[];
  /**
   * Cut the blank margins around content.
   * @default false
   */
  autoTrim?: boolean;
  /** @default 3 */
  trimPaddingMm?: number;
  /**
   * Pixels darker count.
   * @default 240
   */
  trimThreshold?: number;
  /** @default 50 */
  trimDpi?: number;
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

export interface PageFindBlankParams {
  /** 0-based; default all. */
  pages?: number[];
  /**
   * 0 = only pure blank; 1 = tolerant of specks.
   * @default 0.5
   */
  sensitivity?: number;
  /**
   * Border ignored (edge marks).
   * @default 5
   */
  borderMm?: number;
  /**
   * Pages with annotations stay.
   * @default true
   */
  keepIfAnnotations?: boolean;
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

export interface PageRemoveBlankParams {
  /** 0-based; default all. */
  pages?: number[];
  /**
   * 0 = only pure blank; 1 = tolerant of specks.
   * @default 0.5
   */
  sensitivity?: number;
  /**
   * Border ignored (edge marks).
   * @default 5
   */
  borderMm?: number;
  /**
   * Pages with annotations stay.
   * @default true
   */
  keepIfAnnotations?: boolean;
}

/** Reorder pages: new page i = old page `order[i]` (a full permutation). */
export interface PageReorderParams {
  /** Full permutation of current 0-based indices. */
  order: number[];
}

/** Replace the given pages with pages of another file (counts may differ). */
export interface PageReplaceParams {
  /** 0-based pages to replace. */
  pages: number[];
  /** PDF to take the pages from. */
  path: string;
  password?: string;
  /** 0-based pages of that file; default all. */
  sourcePages?: number[];
}

/** Put pages on a standard or custom size; the content is scaled to fit or centred. */
export interface PageResizeParams {
  /** @default "all" */
  scope?: 'all' | 'odd' | 'even' | 'pages';
  pages?: number[];
  /** @default "A4" */
  size?: 'A3' | 'A4' | 'Letter' | 'custom';
  customWidthMm?: number;
  customHeightMm?: number;
  /** @default "scale" */
  fit?: 'scale' | 'center';
}

/** Rotate pages clockwise, relative to their current rotation. */
export interface PageRotateParams {
  /** 0-based page indices. */
  pages: number[];
  /** Clockwise rotation in degrees. */
  angle: 90 | 180 | 270;
}

/** Split each selected page into rows x cols pieces, each with its own CropBox. */
export interface PageSplitParams {
  /** 0-based; default all. */
  pages?: number[];
  /** @default 1 */
  rows?: number;
  /** @default 2 */
  cols?: number;
  /**
   * Overlap between pieces.
   * @default 0
   */
  overlapMm?: number;
  /**
   * Reading order of the pieces; rtl for right-to-left books.
   * @default "ltr"
   */
  order?: 'ltr' | 'rtl';
}

/** Find the sheet on each page and crop to it; unsure pages are reported (L15, L18, L19). */
export interface PageimgAutoCropParams {
  /** 0-based; default all. */
  pages?: number[];
  /**
   * Pages below this are left as they are and reported.
   * @default 0.6
   */
  minConfidence?: number;
  /**
   * 'auto' keeps the measured proportions.
   * @default "auto"
   */
  paperSize?: 'auto' | 'A4' | 'A5' | 'Letter';
  /**
   * Pixels added around the sheet.
   * @default 0
   */
  padding?: number;
  /** @default false */
  keepPageSize?: boolean;
  /** @default 80 */
  jpegQuality?: number;
}

/** Crop a page image by 4 corners, with perspective correction (L2, L16, L17). */
export interface PageimgCropParams {
  pages: CropPage[];
  /**
   * False: the page follows the new image at its resolution.
   * @default false
   */
  keepPageSize?: boolean;
  /** @default 80 */
  jpegQuality?: number;
}

/** A page and four normalized corners, in TL, TR, BR, BL order. */
export interface PageimgCropPreviewParams {
  pageIndex: number;
  corners: CropPoint[];
  /**
   * Fine rotation in degrees counter-clockwise after cropping.
   * @default 0
   */
  angle?: number;
  outSize?: number[];
}

/** Straighten the text of scanned pages (L1). */
export interface PageimgDeskewParams {
  /** 0-based; default all. */
  pages?: number[];
  /** @default "auto" */
  mode?: 'auto' | 'angle';
  /**
   * mode angle: skew to remove, degrees counter-clockwise (as mode auto reports it).
   * @default 0.0
   */
  angle?: number;
  /**
   * mode auto: below this the page is only reported.
   * @default 0.5
   */
  minConfidence?: number;
  /** @default 80 */
  jpegQuality?: number;
}

/** Detect the corners of the sheet on each page (no change to the document). */
export interface PageimgDetectQuadParams {
  /** 0-based; default all. */
  pages?: number[];
}

/** Flatten gently curved text lines on scanned pages (L13). */
export interface PageimgDewarpParams {
  /** 0-based; default all. */
  pages?: number[];
  /**
   * Below this confidence the page is only reported.
   * @default 0.35
   */
  minConfidence?: number;
  /** @default 88 */
  jpegQuality?: number;
}

/** Read-only before/after previews for up to three pages. */
export interface PageimgDewarpPreviewParams {
  pages: number[];
}

/** Clean up scanned pages: background, specks, levels, colour, resolution (L3, L4, L12). */
export interface PageimgEnhanceParams {
  /** 0-based; default all. */
  pages?: number[];
  /** @default false */
  whiten?: boolean;
  /** @default 0.8 */
  whitenStrength?: number;
  /** @default false */
  denoise?: boolean;
  /** @default 0.5 */
  denoiseStrength?: number;
  levels?: Levels;
  /** @default false */
  invert?: boolean;
  /** @default false */
  grayscale?: boolean;
  /** @default 0 */
  contrast?: number;
  /** @default 0 */
  brightness?: number;
  /** Resolution in dpi. Resamples the pixels (page keeps its size) unless resizePage is set. */
  dpi?: number;
  /**
   * With dpi: keep the pixels and change the page size so that the image has dpi.
   * @default false
   */
  resizePage?: boolean;
  /** @default 80 */
  jpegQuality?: number;
}

/** Erase rectangles or a mask on one page image and fill them with paper (L10). */
export interface PageimgEraseParams {
  pageIndex: number;
  rects?: Rect[];
  /** PNG mask, white = erase (instead of rects). */
  maskPath?: string;
  /** @default "paper" */
  fill?: string;
  /** @default 80 */
  jpegQuality?: number;
}

/** Propose the finger regions of a page as a mask image (no change to the document). */
export interface PageimgProposeFingerMaskParams {
  pageIndex: number;
}

export interface PageimgQuadPreviewParams {
  pages: number[];
}

/** Erase fingers on the edges of scanned pages (L14). Use proposeFingerMask first. */
export interface PageimgRemoveFingersParams {
  /** 0-based; default all. */
  pages?: number[];
  /** @default "auto" */
  mode?: 'auto' | 'mask';
  /** mode mask: PNG from proposeFingerMask (edited); white = erase. One page. */
  maskPng?: string;
  /** @default "paper" */
  fill?: string;
  /** @default 80 */
  jpegQuality?: number;
}

/** Erase one ink colour (blue pen, highlighter, red stamp) from page images (L11). */
export interface PageimgRemoveStainsParams {
  /** 0-based; default all. */
  pages?: number[];
  /** Hue start in degrees (red 0, yellow 60, green 120, blue 240). */
  hueMin: number;
  /** Hue end in degrees; less than hueMin wraps around red. */
  hueMax: number;
  /** @default 0.4 */
  minSaturation?: number;
  /** @default "paper" */
  fill?: string;
  /** @default 80 */
  jpegQuality?: number;
}

/** Split each page image (a two-page spread) into two pages (L6). */
export interface PageimgSplitSpreadParams {
  /** 0-based; default all. */
  pages?: number[];
  /** @default "auto" */
  mode?: 'auto' | 'x';
  /** mode x: split at this fraction. */
  x?: number;
  /**
   * ltr: left half first. rtl: right half first (Japanese, Arabic books).
   * @default "ltr"
   */
  order?: 'ltr' | 'rtl';
  /**
   * Fraction of the width removed on each side of the split.
   * @default 0.01
   */
  gutterMargin?: number;
  /**
   * mode auto: below this, not split.
   * @default 0.4
   */
  minConfidence?: number;
  /** @default 80 */
  jpegQuality?: number;
}

/** Run the checklist on the session document. */
export interface PreflightCheckParams {
  /** Size limit of the file (for example 10 MB). */
  maxBytes?: number;
  /**
   * Revocation check of the signatures. none: offline.
   * @default "none"
   */
  checkRevocation?: 'none' | 'soft' | 'hard';
}

/** Redact the matches (ids from redact.find) and the manual areas. */
export interface RedactApplyParams {
  patterns?: RedactPattern[];
  matchIds?: string[];
  rects?: ManualRect[];
  /**
   * Colour of the boxes.
   * @default "#000000"
   */
  fill?: string;
  /**
   * Also scrub information and XMP.
   * @default true
   */
  alsoMetadata?: boolean;
  /**
   * Delete annotations and form values in the areas.
   * @default true
   */
  removeFromAnnotations?: boolean;
  /** Label drawn centred in each redacted box, e.g. 'ĐÃ CHE'. */
  overlayText?: string;
}

/** Find the text to redact. */
export interface RedactFindParams {
  patterns: RedactPattern[];
  /** Limit to these 0-based pages. */
  pages?: number[];
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

/** Remove the protection of the document on the next save. */
export interface SecurityDecryptParams {
  /** Password of the file, checked against the one it was opened with. */
  password?: string;
}

/** Password(s) and permissions. At least one password is required. */
export interface SecurityEncryptParams {
  /** Password. Empty or null: no password is needed to open the file. */
  userPassword?: string;
  /** Password that changes the permissions. Null: the user password is used. */
  ownerPassword?: string;
  permissions?: PermissionFlags;
}

/** Encrypt a PDF file on disk (no session). */
export interface SecurityEncryptFileParams {
  /** Password. Empty or null: no password is needed to open the file. */
  userPassword?: string;
  /** Password that changes the permissions. Null: the user password is used. */
  ownerPassword?: string;
  permissions?: PermissionFlags;
  /** PDF file to encrypt. */
  inputPath: string;
  /** Password of the input file. */
  inputPassword?: string;
  /** Path of the encrypted PDF. May be the input path. */
  outputPath: string;
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

/** Would this text fit the line's font? Changes nothing. */
export interface TextCheckTextParams {
  /** Line id from text.getLines. */
  lineId: string;
  /** @default "" */
  newText?: string;
  /** @default true */
  keepStyle?: boolean;
}

/** Replace the text of one line. Empty text deletes the line. */
export interface TextEditLineParams {
  pageIndex: number;
  lineId: string;
  newText: string;
  /**
   * auto: keep the font when it writes everything, else replace. keep: never replace (error when characters are missing). replace: always replace.
   * @default "auto"
   */
  fontStrategy?: 'auto' | 'keep' | 'replace';
  /** Replacement font id from text.listFonts (implies replace). */
  fontName?: string;
  /**
   * Replacement font follows the bold/italic/serif style of the line.
   * @default true
   */
  keepStyle?: boolean;
  /**
   * none: the line may grow. shrink: lower the size (to 80%). track: lower spacing.
   * @default "none"
   */
  fitWidth?: 'none' | 'shrink' | 'track';
}

/** Replace the text of one paragraph and re-flow it in its box. */
export interface TextEditParagraphParams {
  /**
   * auto: keep the font when it writes everything, else a registry font. keep: never change the font (error when characters are missing). replace: always a registry font.
   * @default "auto"
   */
  fontStrategy?: 'auto' | 'keep' | 'replace';
  /** Registry font id (text.listFonts); overrides fontStrategy. */
  fontName?: string;
  /**
   * A registry font follows the sans/serif/mono class of the text.
   * @default true
   */
  keepStyle?: boolean;
  /**
   * Alignment of the lines.
   * @default "keep"
   */
  align?: 'keep' | 'left' | 'right' | 'center' | 'justify';
  /**
   * keep: the leading ratio of the paragraph; or a pitch in pt.
   * @default "keep"
   */
  lineSpacing?: 'keep' | number;
  /**
   * keep or points.
   * @default "keep"
   */
  fontSize?: 'keep' | number;
  /**
   * keep or #rrggbb.
   * @default "keep"
   */
  color?: 'keep' | string;
  /**
   * keep or true/false.
   * @default "keep"
   */
  bold?: 'keep' | boolean;
  /**
   * keep or true/false.
   * @default "keep"
   */
  italic?: 'keep' | boolean;
  /**
   * keep: up to the right edge of the text block; or points.
   * @default "keep"
   */
  boxWidth?: 'keep' | number;
  /** 0-based page. */
  pageIndex: number;
  /** Paragraph id from text.getLines. */
  paragraphId: string;
  /** New text; \n makes a hard break; empty deletes. */
  newText: string;
}

/** Find and replace text across the document, line by line. */
export interface TextFindReplaceParams {
  find: string;
  /** @default "" */
  replace?: string;
  /** @default false */
  caseSensitive?: boolean;
  /** @default false */
  ignoreDiacritics?: boolean;
  /** @default false */
  wholeWord?: boolean;
  /**
   * Python regular expression; \1 refers to groups.
   * @default false
   */
  regex?: boolean;
  /** 0-based pages (default: all). */
  pages?: number[];
  /**
   * List the matches without changing the file.
   * @default false
   */
  preview?: boolean;
  /** @default "auto" */
  fontStrategy?: 'auto' | 'keep' | 'replace';
  fontName?: string;
  /** @default true */
  keepStyle?: boolean;
  /** @default "none" */
  fitWidth?: 'none' | 'shrink' | 'track';
}

/** Lines of one page with their boxes (displayed frame, points, origin top-left). */
export interface TextGetLinesParams {
  /** 0-based page. */
  pageIndex: number;
  /**
   * Also list text marked as /Artifact (watermarks, page numbers).
   * @default false
   */
  includeArtifacts?: boolean;
}

/** The replacement fonts of the registry (no parameters). */
export interface TextListFontsParams {
}

/** Change the style of one paragraph; its text is kept. */
export interface TextStyleParagraphParams {
  /**
   * auto: keep the font when it writes everything, else a registry font. keep: never change the font (error when characters are missing). replace: always a registry font.
   * @default "auto"
   */
  fontStrategy?: 'auto' | 'keep' | 'replace';
  /** Registry font id (text.listFonts); overrides fontStrategy. */
  fontName?: string;
  /**
   * A registry font follows the sans/serif/mono class of the text.
   * @default true
   */
  keepStyle?: boolean;
  /**
   * Alignment of the lines.
   * @default "keep"
   */
  align?: 'keep' | 'left' | 'right' | 'center' | 'justify';
  /**
   * keep: the leading ratio of the paragraph; or a pitch in pt.
   * @default "keep"
   */
  lineSpacing?: 'keep' | number;
  /**
   * keep or points.
   * @default "keep"
   */
  fontSize?: 'keep' | number;
  /**
   * keep or #rrggbb.
   * @default "keep"
   */
  color?: 'keep' | string;
  /**
   * keep or true/false.
   * @default "keep"
   */
  bold?: 'keep' | boolean;
  /**
   * keep or true/false.
   * @default "keep"
   */
  italic?: 'keep' | boolean;
  /**
   * keep: up to the right edge of the text block; or points.
   * @default "keep"
   */
  boxWidth?: 'keep' | number;
  /** 0-based page. */
  pageIndex: number;
  /** Paragraph id from text.getLines. */
  paragraphId: string;
}

export interface TocFromHeadingsParams {
  /** @default 3 */
  maxLevel?: number;
  /** @default 0.6 */
  minConfidence?: number;
  /**
   * Keep '1.2' or 'Điều 3.' in titles.
   * @default true
   */
  includeNumbering?: boolean;
  /** @default "replace" */
  mode?: 'replace' | 'append';
}

export interface TocInsertPageParams {
  /** @default 3 */
  maxLevel?: number;
  /** @default 0.6 */
  minConfidence?: number;
  /**
   * Keep '1.2' or 'Điều 3.' in titles.
   * @default true
   */
  includeNumbering?: boolean;
  /** @default "Mục lục" */
  title?: string;
  /** @default "front" */
  placement?: 'front' | 'back' | 'afterPage';
  /** 1-based page number */
  afterPage?: number;
  /** @default "source" */
  pageSize?: 'source' | 'a4';
  /** @default true */
  dotLeader?: boolean;
  /** @default 0 */
  pageNumberOffset?: number;
  /** @default 1.0 */
  fontScale?: number;
  /** @default true */
  linkEntries?: boolean;
  /**
   * Append generated heading bookmarks to the existing outline.
   * @default false
   */
  addBookmark?: boolean;
}

export interface TocPreviewParams {
  /** @default 3 */
  maxLevel?: number;
  /** @default 0.6 */
  minConfidence?: number;
  /**
   * Keep '1.2' or 'Điều 3.' in titles.
   * @default true
   */
  includeNumbering?: boolean;
}

export interface WatchMarkDoneParams {
  ledgerPath: string;
  /** The file that was handled. */
  path: string;
  outputPath?: string;
  /** @default "done" */
  status?: 'done' | 'failed' | 'skipped';
}

export interface WatchReleaseParams {
  ledgerPath: string;
  paths?: string[];
}

export interface WatchScanParams {
  /** Folder to watch. */
  directory: string;
  outputDirectory?: string;
  /** State file (JSON). */
  ledgerPath: string;
  /**
   * Size and time must not change for this long.
   * @default 3.0
   */
  settleSeconds?: number;
  /** @default "*.pdf" */
  pattern?: string;
}

/** List the watermark candidates of the document (nothing is changed). */
export interface WatermarkDetectParams {
}

/** Remove chosen watermark candidates (from watermark.detect). */
export interface WatermarkRemoveParams {
  /** Candidate ids to remove. */
  candidateIds?: string[];
  /**
   * Remove every candidate.
   * @default false
   */
  all?: boolean;
  /** Limit to these 0-based pages. */
  pages?: number[];
}

export interface WorkflowRunParams {
  /** A workflow (see Workflow JSON schema). */
  workflow: Record<string, unknown>;
  files: WorkflowFile[];
  /** Values of {{secret:name}} placeholders. Never stored, logged or echoed back. */
  secrets?: Record<string, string>;
  /** Values for {{name}} placeholders of this run. */
  variables?: Record<string, string>;
  /** Replaces the output rule of the workflow for this run. */
  output?: WorkflowOutput;
  /**
   * Stop after the first failed file.
   * @default false
   */
  stopOnError?: boolean;
  /**
   * Only plan the output names: nothing is processed or written.
   * @default false
   */
  dryRun?: boolean;
}

/** No parameters. */
export interface WorkflowSamplesParams {
}

export interface WorkflowValidateParams {
  /** A workflow (see Workflow JSON schema). */
  workflow: Record<string, unknown>;
  /** Values of the run request, checked with the workflow. */
  variables?: Record<string, string>;
}

/** Params type of every operation, by op id. */
export interface OpParams {
  'annots.addFreeText': AnnotsAddFreeTextParams;
  'annots.addInk': AnnotsAddInkParams;
  'annots.addNote': AnnotsAddNoteParams;
  'annots.addShape': AnnotsAddShapeParams;
  'annots.addTextMarkup': AnnotsAddTextMarkupParams;
  'annots.export': AnnotsExportParams;
  'annots.flatten': AnnotsFlattenParams;
  'annots.list': AnnotsListParams;
  'annots.remove': AnnotsRemoveParams;
  'annots.removeAll': AnnotsRemoveAllParams;
  'annots.reply': AnnotsReplyParams;
  'annots.setStatus': AnnotsSetStatusParams;
  'annots.update': AnnotsUpdateParams;
  'background.detect': BackgroundDetectParams;
  'background.remove': BackgroundRemoveParams;
  'batch.run': BatchRunParams;
  'bookmarks.clear': BookmarksClearParams;
  'bookmarks.fromPages': BookmarksFromPagesParams;
  'bookmarks.get': BookmarksGetParams;
  'bookmarks.set': BookmarksSetParams;
  'color.convert': ColorConvertParams;
  'compress.estimate': CompressEstimateParams;
  'compress.file': CompressFileParams;
  'compress.fitSize': CompressFitSizeParams;
  'compress.pdf': CompressPdfParams;
  'compress.toSize': CompressToSizeParams;
  'content.adjustImage': ContentAdjustImageParams;
  'content.delete': ContentDeleteParams;
  'content.duplicate': ContentDuplicateParams;
  'content.eraseRegion': ContentEraseRegionParams;
  'content.extractImage': ContentExtractImageParams;
  'content.hitTest': ContentHitTestParams;
  'content.listObjects': ContentListObjectsParams;
  'content.move': ContentMoveParams;
  'content.removeSimilar': ContentRemoveSimilarParams;
  'content.reorder': ContentReorderParams;
  'content.replaceImage': ContentReplaceImageParams;
  'content.setColor': ContentSetColorParams;
  'content.setOpacity': ContentSetOpacityParams;
  'content.transform': ContentTransformParams;
  'content.viewByType': ContentViewByTypeParams;
  'convert.imagesToPdf': ConvertImagesToPdfParams;
  'convert.pdfToImages': ConvertPdfToImagesParams;
  'doc.attachments.add': DocAttachmentsAddParams;
  'doc.attachments.extract': DocAttachmentsExtractParams;
  'doc.attachments.list': DocAttachmentsListParams;
  'doc.attachments.remove': DocAttachmentsRemoveParams;
  'doc.extractImages': DocExtractImagesParams;
  'doc.extractText': DocExtractTextParams;
  'doc.optimizeWeb': DocOptimizeWebParams;
  'doc.repair': DocRepairParams;
  'doc.setMetadata': DocSetMetadataParams;
  'export.batch': ExportBatchParams;
  'export.document': ExportDocumentParams;
  'export.refresh': ExportRefreshParams;
  'file.merge': FileMergeParams;
  'file.split': FileSplitParams;
  'file.splitSmart': FileSplitSmartParams;
  'files.renameBatch': FilesRenameBatchParams;
  'forms.addField': FormsAddFieldParams;
  'forms.detectFields': FormsDetectFieldsParams;
  'forms.exportData': FormsExportDataParams;
  'forms.fill': FormsFillParams;
  'forms.flatten': FormsFlattenParams;
  'forms.getValues': FormsGetValuesParams;
  'forms.importData': FormsImportDataParams;
  'forms.list': FormsListParams;
  'forms.remove': FormsRemoveParams;
  'forms.rename': FormsRenameParams;
  'forms.reset': FormsResetParams;
  'forms.setTabOrder': FormsSetTabOrderParams;
  'forms.update': FormsUpdateParams;
  'image.cleanup': ImageCleanupParams;
  'image.fromStrokes': ImageFromStrokesParams;
  'image.removeBackground': ImageRemoveBackgroundParams;
  'image.separateColors': ImageSeparateColorsParams;
  'image.textSignature': ImageTextSignatureParams;
  'inspect.hiddenData': InspectHiddenDataParams;
  'inspect.removeHidden': InspectRemoveHiddenParams;
  'layers.flatten': LayersFlattenParams;
  'layers.list': LayersListParams;
  'layers.remove': LayersRemoveParams;
  'layers.setVisibility': LayersSetVisibilityParams;
  'layout.analyze': LayoutAnalyzeParams;
  'layout.pageModel': LayoutPageModelParams;
  'layout.review': LayoutReviewParams;
  'links.add': LinksAddParams;
  'links.autoDetect': LinksAutoDetectParams;
  'links.list': LinksListParams;
  'links.remove': LinksRemoveParams;
  'links.update': LinksUpdateParams;
  'naming.apply': NamingApplyParams;
  'naming.preview': NamingPreviewParams;
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
  'page.crop': PageCropParams;
  'page.delete': PageDeleteParams;
  'page.duplicate': PageDuplicateParams;
  'page.extract': PageExtractParams;
  'page.findBlank': PageFindBlankParams;
  'page.insertBlank': PageInsertBlankParams;
  'page.insertFromFile': PageInsertFromFileParams;
  'page.insertImages': PageInsertImagesParams;
  'page.removeBlank': PageRemoveBlankParams;
  'page.reorder': PageReorderParams;
  'page.replace': PageReplaceParams;
  'page.resize': PageResizeParams;
  'page.rotate': PageRotateParams;
  'page.split': PageSplitParams;
  'pageimg.autoCrop': PageimgAutoCropParams;
  'pageimg.crop': PageimgCropParams;
  'pageimg.cropPreview': PageimgCropPreviewParams;
  'pageimg.deskew': PageimgDeskewParams;
  'pageimg.detectQuad': PageimgDetectQuadParams;
  'pageimg.dewarp': PageimgDewarpParams;
  'pageimg.dewarpPreview': PageimgDewarpPreviewParams;
  'pageimg.enhance': PageimgEnhanceParams;
  'pageimg.erase': PageimgEraseParams;
  'pageimg.proposeFingerMask': PageimgProposeFingerMaskParams;
  'pageimg.quadPreview': PageimgQuadPreviewParams;
  'pageimg.removeFingers': PageimgRemoveFingersParams;
  'pageimg.removeStains': PageimgRemoveStainsParams;
  'pageimg.splitSpread': PageimgSplitSpreadParams;
  'preflight.check': PreflightCheckParams;
  'redact.apply': RedactApplyParams;
  'redact.find': RedactFindParams;
  'scan.fitSize': ScanFitSizeParams;
  'scan.preview': ScanPreviewParams;
  'scan.rasterize': ScanRasterizeParams;
  'security.decrypt': SecurityDecryptParams;
  'security.encrypt': SecurityEncryptParams;
  'security.encryptFile': SecurityEncryptFileParams;
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
  'text.checkText': TextCheckTextParams;
  'text.editLine': TextEditLineParams;
  'text.editParagraph': TextEditParagraphParams;
  'text.findReplace': TextFindReplaceParams;
  'text.getLines': TextGetLinesParams;
  'text.listFonts': TextListFontsParams;
  'text.styleParagraph': TextStyleParagraphParams;
  'toc.fromHeadings': TocFromHeadingsParams;
  'toc.insertPage': TocInsertPageParams;
  'toc.preview': TocPreviewParams;
  'watch.markDone': WatchMarkDoneParams;
  'watch.release': WatchReleaseParams;
  'watch.scan': WatchScanParams;
  'watermark.detect': WatermarkDetectParams;
  'watermark.remove': WatermarkRemoveParams;
  'workflow.run': WorkflowRunParams;
  'workflow.samples': WorkflowSamplesParams;
  'workflow.validate': WorkflowValidateParams;
}

export type OpId = keyof OpParams;

export const OP_IDS = [
  'annots.addFreeText',
  'annots.addInk',
  'annots.addNote',
  'annots.addShape',
  'annots.addTextMarkup',
  'annots.export',
  'annots.flatten',
  'annots.list',
  'annots.remove',
  'annots.removeAll',
  'annots.reply',
  'annots.setStatus',
  'annots.update',
  'background.detect',
  'background.remove',
  'batch.run',
  'bookmarks.clear',
  'bookmarks.fromPages',
  'bookmarks.get',
  'bookmarks.set',
  'color.convert',
  'compress.estimate',
  'compress.file',
  'compress.fitSize',
  'compress.pdf',
  'compress.toSize',
  'content.adjustImage',
  'content.delete',
  'content.duplicate',
  'content.eraseRegion',
  'content.extractImage',
  'content.hitTest',
  'content.listObjects',
  'content.move',
  'content.removeSimilar',
  'content.reorder',
  'content.replaceImage',
  'content.setColor',
  'content.setOpacity',
  'content.transform',
  'content.viewByType',
  'convert.imagesToPdf',
  'convert.pdfToImages',
  'doc.attachments.add',
  'doc.attachments.extract',
  'doc.attachments.list',
  'doc.attachments.remove',
  'doc.extractImages',
  'doc.extractText',
  'doc.optimizeWeb',
  'doc.repair',
  'doc.setMetadata',
  'export.batch',
  'export.document',
  'export.refresh',
  'file.merge',
  'file.split',
  'file.splitSmart',
  'files.renameBatch',
  'forms.addField',
  'forms.detectFields',
  'forms.exportData',
  'forms.fill',
  'forms.flatten',
  'forms.getValues',
  'forms.importData',
  'forms.list',
  'forms.remove',
  'forms.rename',
  'forms.reset',
  'forms.setTabOrder',
  'forms.update',
  'image.cleanup',
  'image.fromStrokes',
  'image.removeBackground',
  'image.separateColors',
  'image.textSignature',
  'inspect.hiddenData',
  'inspect.removeHidden',
  'layers.flatten',
  'layers.list',
  'layers.remove',
  'layers.setVisibility',
  'layout.analyze',
  'layout.pageModel',
  'layout.review',
  'links.add',
  'links.autoDetect',
  'links.list',
  'links.remove',
  'links.update',
  'naming.apply',
  'naming.preview',
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
  'page.crop',
  'page.delete',
  'page.duplicate',
  'page.extract',
  'page.findBlank',
  'page.insertBlank',
  'page.insertFromFile',
  'page.insertImages',
  'page.removeBlank',
  'page.reorder',
  'page.replace',
  'page.resize',
  'page.rotate',
  'page.split',
  'pageimg.autoCrop',
  'pageimg.crop',
  'pageimg.cropPreview',
  'pageimg.deskew',
  'pageimg.detectQuad',
  'pageimg.dewarp',
  'pageimg.dewarpPreview',
  'pageimg.enhance',
  'pageimg.erase',
  'pageimg.proposeFingerMask',
  'pageimg.quadPreview',
  'pageimg.removeFingers',
  'pageimg.removeStains',
  'pageimg.splitSpread',
  'preflight.check',
  'redact.apply',
  'redact.find',
  'scan.fitSize',
  'scan.preview',
  'scan.rasterize',
  'security.decrypt',
  'security.encrypt',
  'security.encryptFile',
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
  'text.checkText',
  'text.editLine',
  'text.editParagraph',
  'text.findReplace',
  'text.getLines',
  'text.listFonts',
  'text.styleParagraph',
  'toc.fromHeadings',
  'toc.insertPage',
  'toc.preview',
  'watch.markDone',
  'watch.release',
  'watch.scan',
  'watermark.detect',
  'watermark.remove',
  'workflow.run',
  'workflow.samples',
  'workflow.validate',
] as const;
