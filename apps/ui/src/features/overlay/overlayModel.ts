/**
 * Pure logic of the overlay tools (T4.02-T4.10): forms -> core params, page choices, barcode
 * checks, placement units, the overlay list grouping. No React, no RPC.
 *
 * Coordinates: x/y are the anchor point from the TOP-LEFT of the DISPLAYED page (after /Rotate),
 * in the form's unit (pt or mm). Placement by drag converts the viewer box with placementGeometry
 * (CropBox origin (0, 0) is assumed, as for signatures). Margins of header/footer and page numbers
 * are millimetres (core Margins).
 */
import type {
  OverlayAddImageParams,
  OverlayAddTextParams,
  OverlayBarcodeParams,
  OverlayBatesParams,
  OverlayHeaderFooterParams,
  OverlayLetterheadParams,
  OverlayPageNumbersParams,
  OverlayQrCodeParams,
  OverlayWatermarkParams,
  TextZones,
} from '@chef/contracts';
import {
  mmToPt,
  pageGeom,
  ptToMm,
  screenBoxToDisplayRect,
  type ScreenBox,
} from '../sign/placementGeometry';
import { parsePageRanges } from '../../lib/pageRange';
import { parseTemplate, type VariableName } from './variables';

export type Unit = 'pt' | 'mm';

/** Anchor of an object: which point of it sits at x, y (core Placed.anchor). */
export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/** The 3x3 anchor selector, row by row. */
export const ANCHOR_GRID: Anchor[][] = [
  ['top-left', 'top-center', 'top-right'],
  ['center-left', 'center', 'center-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
];

export type PagesChoice = 'current' | 'all' | 'range' | 'odd' | 'even';

export interface PagesSel {
  choice: PagesChoice;
  /** Used with choice 'range': "1-3, 5, 8-". */
  range: string;
}

export const DEFAULT_PAGES: PagesSel = { choice: 'current', range: '' };

export type PageSelection =
  { ok: true; params: { pages?: number[]; pageRange?: string } } | { ok: false; error: 'range' };

/**
 * The core's page params for a choice. `current` is the page shown (0-based); `all` sends
 * nothing (the core default is every page). Range text is checked here so the dialog can show
 * the problem next to the field.
 */
export function pageSelection(
  sel: PagesSel,
  currentIndex: number,
  pageCount: number,
): PageSelection {
  switch (sel.choice) {
    case 'current':
      return { ok: true, params: { pages: [currentIndex] } };
    case 'all':
      return { ok: true, params: {} };
    case 'odd':
      return { ok: true, params: { pageRange: 'odd' } };
    case 'even':
      return { ok: true, params: { pageRange: 'even' } };
    case 'range': {
      const parsed = parsePageRanges(sel.range, pageCount);
      if (!parsed.ok) return { ok: false, error: 'range' };
      return { ok: true, params: { pages: parsed.pages } };
    }
  }
}

/** Pages affected by a selection, for the preview and the warnings (0-based). */
export function selectedPages(sel: PagesSel, currentIndex: number, pageCount: number): number[] {
  const r = pageSelection(sel, currentIndex, pageCount);
  if (!r.ok) return [];
  if (r.params.pages) return r.params.pages;
  const all = Array.from({ length: pageCount }, (_, i) => i);
  if (r.params.pageRange === 'odd') return all.filter((i) => i % 2 === 0);
  if (r.params.pageRange === 'even') return all.filter((i) => i % 2 === 1);
  return all;
}

// ---------- units and placement ----------

/** A value in `unit` as points (the core's internal unit). */
export function toPt(value: number, unit: Unit): number {
  return unit === 'mm' ? mmToPt(value) : value;
}

/** Points as a value in `unit`, rounded for a form field (1 decimal). */
export function fromPt(pt: number, unit: Unit): number {
  const v = unit === 'mm' ? ptToMm(pt) : pt;
  return round1(v);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The viewer box of a drag as top-left coordinates of the displayed page, in points. `dispW` and
 * `dispH` are the displayed size (DocumentInfo.pages), `scale` the px per point of the page image.
 */
export function boxToTopLeft(
  box: ScreenBox,
  dispW: number,
  dispH: number,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  const g = pageGeom({ width: dispW, height: dispH, rotation: 0 });
  const r = screenBoxToDisplayRect(box, g, scale);
  return {
    x: round1(r.x1),
    y: round1(dispH - r.y2),
    width: round1(r.x2 - r.x1),
    height: round1(r.y2 - r.y1),
  };
}

// ---------- shared checks ----------

export type FormCheck = { ok: true } | { ok: false; field: string };

/** Hex colour #RRGGBB. */
export function isHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

export function inRange(v: number, min: number, max: number): boolean {
  return Number.isFinite(v) && v >= min && v <= max;
}

const IMAGE_EXT = /\.(png|jpe?g)$/i;

// ---------- text and image ----------

export type Align = 'left' | 'center' | 'right';

export interface TextForm {
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
  align: Align;
  rotation: number;
  opacity: number;
  under: boolean;
  anchor: Anchor;
  unit: Unit;
  x: number;
  y: number;
  /** 0 = no width (no wrap). */
  width: number;
  pages: PagesSel;
}

export const DEFAULT_TEXT_FORM: TextForm = {
  text: '',
  fontSize: 12,
  bold: false,
  color: '#000000',
  align: 'left',
  rotation: 0,
  opacity: 1,
  under: false,
  anchor: 'top-left',
  unit: 'mm',
  x: 20,
  y: 20,
  width: 0,
  pages: DEFAULT_PAGES,
};

export function checkText(form: TextForm, pageCount: number, current: number): FormCheck {
  if (form.text.trim() === '' || form.text.length > 5000) return { ok: false, field: 'text' };
  if (!inRange(form.fontSize, 1, 200)) return { ok: false, field: 'fontSize' };
  if (!isHexColor(form.color)) return { ok: false, field: 'color' };
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!inRange(form.x, -10000, 10000) || !inRange(form.y, -10000, 10000)) {
    return { ok: false, field: 'position' };
  }
  if (!inRange(form.width, 0, 10000)) return { ok: false, field: 'width' };
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

export function addTextParams(
  form: TextForm,
  current: number,
  pageCount: number,
): OverlayAddTextParams {
  const sel = pageSelection(form.pages, current, pageCount);
  return {
    x: form.x,
    y: form.y,
    unit: form.unit,
    anchor: form.anchor,
    rotation: form.rotation,
    opacity: form.opacity,
    under: form.under,
    ...(sel.ok ? sel.params : {}),
    text: form.text,
    fontName: 'BeVietnamPro',
    fontSize: form.fontSize,
    bold: form.bold,
    color: form.color,
    align: form.align,
    ...(form.width > 0 ? { width: form.width } : {}),
  };
}

export interface ImageForm {
  path: string;
  /** 0 = keep the natural size for that side. */
  width: number;
  height: number;
  unit: Unit;
  x: number;
  y: number;
  anchor: Anchor;
  rotation: number;
  opacity: number;
  under: boolean;
  pages: PagesSel;
}

export const DEFAULT_IMAGE_FORM: ImageForm = {
  path: '',
  width: 40,
  height: 0,
  unit: 'mm',
  x: 20,
  y: 20,
  anchor: 'top-left',
  rotation: 0,
  opacity: 1,
  under: false,
  pages: DEFAULT_PAGES,
};

export function checkImage(form: ImageForm, pageCount: number, current: number): FormCheck {
  if (!IMAGE_EXT.test(form.path)) return { ok: false, field: 'path' };
  if (!inRange(form.width, 0, 10000) || !inRange(form.height, 0, 10000)) {
    return { ok: false, field: 'size' };
  }
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!inRange(form.x, -10000, 10000) || !inRange(form.y, -10000, 10000)) {
    return { ok: false, field: 'position' };
  }
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

export function addImageParams(
  form: ImageForm,
  current: number,
  pageCount: number,
): OverlayAddImageParams {
  const sel = pageSelection(form.pages, current, pageCount);
  return {
    x: form.x,
    y: form.y,
    unit: form.unit,
    anchor: form.anchor,
    rotation: form.rotation,
    opacity: form.opacity,
    under: form.under,
    ...(sel.ok ? sel.params : {}),
    path: form.path,
    ...(form.width > 0 ? { width: form.width } : {}),
    ...(form.height > 0 ? { height: form.height } : {}),
  };
}

// ---------- watermark ----------

export interface WatermarkLook {
  fontSize: number;
  bold: boolean;
  color: string;
  opacity: number;
  rotation: number;
}

export interface WatermarkForm extends WatermarkLook {
  kind: 'text' | 'image';
  text: string;
  path: string;
  mode: 'center' | 'tiled';
  spacing: number;
  width: number;
  height: number;
  under: boolean;
  pages: PagesSel;
}

export const DEFAULT_WATERMARK_FORM: WatermarkForm = {
  kind: 'text',
  text: 'BẢN SAO',
  path: '',
  fontSize: 60,
  bold: true,
  color: '#808080',
  opacity: 0.25,
  rotation: 45,
  mode: 'center',
  spacing: 60,
  width: 0,
  height: 0,
  under: false,
  pages: DEFAULT_PAGES,
};

export interface BuiltinWatermark {
  key: 'copy' | 'secret' | 'draft' | 'approved';
  /** i18n key of the text printed on the page (also the menu label). */
  textKey: string;
  look: WatermarkLook;
}

/** Built-in look presets (F2 style). The texts are localised with i18n keys. */
export const BUILTIN_WATERMARKS: BuiltinWatermark[] = [
  {
    key: 'copy',
    textKey: 'overlay.presetText.copy',
    look: { fontSize: 60, bold: true, color: '#808080', opacity: 0.25, rotation: 45 },
  },
  {
    key: 'secret',
    textKey: 'overlay.presetText.secret',
    look: { fontSize: 90, bold: true, color: '#B00020', opacity: 0.2, rotation: 45 },
  },
  {
    key: 'draft',
    textKey: 'overlay.presetText.draft',
    look: { fontSize: 80, bold: true, color: '#808080', opacity: 0.2, rotation: 45 },
  },
  {
    key: 'approved',
    textKey: 'overlay.presetText.approved',
    look: { fontSize: 56, bold: true, color: '#1E8E3E', opacity: 0.3, rotation: 0 },
  },
];

export function checkWatermark(form: WatermarkForm, pageCount: number, current: number): FormCheck {
  if (form.kind === 'text') {
    if (form.text.trim() === '' || form.text.length > 500) return { ok: false, field: 'text' };
    if (!inRange(form.fontSize, 1, 400)) return { ok: false, field: 'fontSize' };
    if (!isHexColor(form.color)) return { ok: false, field: 'color' };
  } else {
    if (!IMAGE_EXT.test(form.path)) return { ok: false, field: 'path' };
    if (!inRange(form.width, 0, 2000) || !inRange(form.height, 0, 2000)) {
      return { ok: false, field: 'size' };
    }
  }
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!inRange(form.rotation, -360, 360)) return { ok: false, field: 'rotation' };
  if (!inRange(form.spacing, 0, 1000)) return { ok: false, field: 'spacing' };
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

export function watermarkParams(
  form: WatermarkForm,
  current: number,
  pageCount: number,
): OverlayWatermarkParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const common = {
    ...(sel.ok ? sel.params : {}),
    opacity: form.opacity,
    rotation: form.rotation,
    under: form.under,
    mode: form.mode,
    spacing: form.spacing,
  };
  if (form.kind === 'image') {
    return {
      ...common,
      path: form.path,
      ...(form.width > 0 ? { width: form.width } : {}),
      ...(form.height > 0 ? { height: form.height } : {}),
    };
  }
  return {
    ...common,
    text: form.text,
    fontName: 'BeVietnamPro',
    fontSize: form.fontSize,
    bold: form.bold,
    color: form.color,
  };
}

/** The look part of a watermark form (what a preset keeps): never a path or a page list. */
export function lookOf(form: WatermarkForm): WatermarkLook {
  return {
    fontSize: form.fontSize,
    bold: form.bold,
    color: form.color,
    opacity: form.opacity,
    rotation: form.rotation,
  };
}

// ---------- header / footer and page numbers ----------

export const ZONE_KEYS = ['left', 'center', 'right'] as const;
export type ZoneKey = (typeof ZONE_KEYS)[number];
export type Zones = Record<ZoneKey, string>;
export type Margins = { top: number; bottom: number; left: number; right: number };

export interface HeaderFooterForm {
  header: Zones;
  footer: Zones;
  fontSize: number;
  bold: boolean;
  color: string;
  opacity: number;
  margins: Margins;
  dateFormat: string;
  skipFirst: boolean;
  startNumber: number;
  mirrorOddEven: boolean;
  pages: PagesSel;
  batesPrefix: string;
  batesSuffix: string;
  batesDigits: number;
}

export const DEFAULT_HEADER_FOOTER_FORM: HeaderFooterForm = {
  header: { left: '', center: '', right: '' },
  footer: { left: '{filename}', center: '', right: 'Trang {page}/{pages}' },
  fontSize: 10,
  bold: false,
  color: '#000000',
  opacity: 1,
  margins: { top: 10, bottom: 10, left: 20, right: 20 },
  dateFormat: 'dd/MM/yyyy',
  skipFirst: false,
  startNumber: 1,
  mirrorOddEven: false,
  pages: DEFAULT_PAGES,
  batesPrefix: '',
  batesSuffix: '',
  batesDigits: 6,
};

/** The first broken template of the zones, or null. */
export function zonesProblem(zones: Zones): { field: ZoneKey; issue: string } | null {
  for (const key of ZONE_KEYS) {
    const p = parseTemplate(zones[key]);
    if (!p.ok) return { field: key, issue: p.issue };
  }
  return null;
}

export function zonesEmpty(zones: Zones): boolean {
  return ZONE_KEYS.every((k) => zones[k].trim() === '');
}

export function checkMargins(m: Margins): boolean {
  return (Object.values(m) as number[]).every((v) => inRange(v, 0, 200));
}

export function headerFooterParams(
  form: HeaderFooterForm,
  current: number,
  pageCount: number,
): OverlayHeaderFooterParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const zones = (z: Zones): TextZones => ({ left: z.left, center: z.center, right: z.right });
  return {
    ...(sel.ok ? sel.params : {}),
    header: zones(form.header),
    footer: zones(form.footer),
    margins: form.margins,
    fontName: 'BeVietnamPro',
    fontSize: form.fontSize,
    bold: form.bold,
    color: form.color,
    opacity: form.opacity,
    dateFormat: form.dateFormat,
    skipFirst: form.skipFirst,
    startNumber: form.startNumber,
    mirrorOddEven: form.mirrorOddEven,
    batesPrefix: form.batesPrefix,
    batesSuffix: form.batesSuffix,
    batesDigits: form.batesDigits,
  };
}

export type NumberPosition = NonNullable<OverlayPageNumbersParams['position']>;

export const NUMBER_POSITIONS: NumberPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export interface PageNumbersForm {
  preset: 'nd30' | 'custom';
  numberFormat: 'arabic' | 'roman' | 'ROMAN' | 'alpha' | 'ALPHA';
  template: string;
  position: NumberPosition;
  margins: Margins;
  fontSize: number;
  bold: boolean;
  color: string;
  opacity: number;
  startNumber: number;
  skipFirst: boolean;
  writeLabels: boolean;
  dateFormat: string;
  pages: PagesSel;
}

export const DEFAULT_PAGE_NUMBERS_FORM: PageNumbersForm = {
  preset: 'custom',
  numberFormat: 'arabic',
  template: 'Trang {page}/{pages}',
  position: 'bottom-center',
  margins: { top: 10, bottom: 10, left: 20, right: 20 },
  fontSize: 10,
  bold: false,
  color: '#000000',
  opacity: 1,
  startNumber: 1,
  skipFirst: false,
  writeLabels: false,
  dateFormat: 'dd/MM/yyyy',
  pages: DEFAULT_PAGES,
};

/** The Nghị định 30/2020/NĐ-CP preset: the values the core applies (overlay_header.py). */
export const ND30_VALUES = {
  numberFormat: 'arabic',
  template: '{page}',
  position: 'top-center',
  fontSize: 13,
  skipFirst: true,
} as const;

export function pageNumbersParams(
  form: PageNumbersForm,
  current: number,
  pageCount: number,
): OverlayPageNumbersParams {
  const sel = pageSelection(form.pages, current, pageCount);
  return {
    ...(sel.ok ? sel.params : {}),
    ...(form.preset === 'nd30' ? { preset: 'nd30' as const } : {}),
    numberFormat: form.numberFormat,
    template: form.template,
    position: form.position,
    margins: form.margins,
    fontName: 'BeVietnamPro',
    fontSize: form.fontSize,
    bold: form.bold,
    color: form.color,
    opacity: form.opacity,
    startNumber: form.startNumber,
    skipFirst: form.skipFirst,
    writeLabels: form.writeLabels,
    dateFormat: form.dateFormat,
  };
}

/** The template as the core will see it (nd30 overrides it). */
export function effectiveNumberTemplate(form: PageNumbersForm): string {
  return form.preset === 'nd30' ? ND30_VALUES.template : form.template;
}

export function checkPageNumbers(
  form: PageNumbersForm,
  pageCount: number,
  current: number,
): FormCheck {
  if (form.preset === 'custom' && !parseTemplate(form.template).ok) {
    return { ok: false, field: 'template' };
  }
  if (!inRange(form.startNumber, 0, 1_000_000_000)) return { ok: false, field: 'startNumber' };
  if (!inRange(form.fontSize, 1, 200)) return { ok: false, field: 'fontSize' };
  if (!checkMargins(form.margins)) return { ok: false, field: 'margins' };
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

/** The variables offered as chips, in the order the core documents them. */
export const CHIP_VARIABLES: VariableName[] = [
  'page',
  'pages',
  'page_roman',
  'page_alpha',
  'date',
  'time',
  'filename',
  'title',
  'author',
  'bates',
  'section',
];

// ---------- QR and barcode ----------

export const ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const;
export type EccLevel = (typeof ECC_LEVELS)[number];

export interface QrForm {
  content: string;
  errorCorrection: EccLevel;
  size: number;
  label: string;
  color: string;
  background: string;
  x: number;
  y: number;
  anchor: Anchor;
  pages: PagesSel;
}

export const DEFAULT_QR_FORM: QrForm = {
  content: '{filename} - trang {page}',
  errorCorrection: 'M',
  size: 25,
  label: '',
  color: '#000000',
  background: '',
  x: 150,
  y: 20,
  anchor: 'top-left',
  pages: DEFAULT_PAGES,
};

export type BarcodeKind = 'code128' | 'ean13' | 'code39';
export const BARCODE_KINDS_LIST: BarcodeKind[] = ['code128', 'ean13', 'code39'];

export interface BarcodeForm {
  kind: BarcodeKind;
  content: string;
  unit: Unit;
  moduleWidth: number;
  height: number;
  label: string;
  color: string;
  background: string;
  x: number;
  y: number;
  anchor: Anchor;
  pages: PagesSel;
}

export const DEFAULT_BARCODE_FORM: BarcodeForm = {
  kind: 'code128',
  content: 'HS-000001',
  unit: 'mm',
  moduleWidth: 0.33,
  height: 15,
  label: '',
  color: '#000000',
  background: '',
  x: 20,
  y: 260,
  anchor: 'top-left',
  pages: DEFAULT_PAGES,
};

const CODE39_RE = /^[0-9A-Z \-.$/+%]+$/;

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export type BarcodeProblem =
  'empty' | 'ean13Digits' | 'ean13Length' | 'ean13Check' | 'code39' | 'code128';

/** null when the content is valid for the barcode kind. EAN-13 accepts 12 or 13 digits. */
export function barcodeProblem(kind: BarcodeKind, content: string): BarcodeProblem | null {
  if (content.length === 0) return 'empty';
  if (kind === 'ean13') {
    if (!/^\d+$/.test(content)) return 'ean13Digits';
    if (content.length !== 12 && content.length !== 13) return 'ean13Length';
    if (content.length === 13 && ean13CheckDigit(content) !== Number(content[12])) {
      return 'ean13Check';
    }
    return null;
  }
  if (kind === 'code39') return CODE39_RE.test(content) ? null : 'code39';
  return /^[\x20-\x7E]+$/.test(content) ? null : 'code128';
}

/** The EAN-13 with its check digit, from 12 or 13 digits. */
export function ean13Complete(content: string): string {
  if (content.length === 13) return content;
  return content + String(ean13CheckDigit(content));
}

/** The content of a QR code: templates must be valid (the core renders the variables). */
export function qrContentProblem(content: string): string | null {
  if (content.trim() === '') return 'empty';
  const p = parseTemplate(content);
  return p.ok ? null : p.issue;
}

export function qrParams(form: QrForm, current: number, pageCount: number): OverlayQrCodeParams {
  const sel = pageSelection(form.pages, current, pageCount);
  return {
    x: form.x,
    y: form.y,
    unit: 'mm',
    anchor: form.anchor,
    ...(sel.ok ? sel.params : {}),
    content: form.content,
    errorCorrection: form.errorCorrection,
    size: form.size,
    color: form.color,
    ...(form.background ? { background: form.background } : {}),
    ...(form.label ? { label: form.label, fontName: 'BeVietnamPro' as const } : {}),
  };
}

export function barcodeParams(
  form: BarcodeForm,
  current: number,
  pageCount: number,
): OverlayBarcodeParams {
  const sel = pageSelection(form.pages, current, pageCount);
  return {
    x: form.x,
    y: form.y,
    unit: form.unit,
    anchor: form.anchor,
    ...(sel.ok ? sel.params : {}),
    kind: form.kind,
    content: form.kind === 'ean13' ? ean13Complete(form.content) : form.content,
    moduleWidth: form.moduleWidth,
    height: form.height,
    color: form.color,
    ...(form.background ? { background: form.background } : {}),
    ...(form.label ? { label: form.label, fontName: 'BeVietnamPro' as const } : {}),
  };
}

// ---------- preview geometry (approximate) ----------

/** Rough size of a text block in points (the preview only; the core measures exactly). */
export function estimateTextBox(
  text: string,
  fontSize: number,
  width: number,
): { w: number; h: number; lines: number } {
  const rows = text.split('\n');
  const charW = fontSize * 0.52;
  const naturalW = Math.max(1, ...rows.map((l) => l.length)) * charW;
  const lines =
    width > 0
      ? rows.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * charW) / width)), 0)
      : rows.length;
  return { w: width > 0 ? width : naturalW, h: lines * fontSize * 1.2, lines };
}

/** Offset from the object's top-left to its anchor point. */
export function anchorShift(anchor: Anchor, w: number, h: number): { dx: number; dy: number } {
  const dx =
    anchor.endsWith('center') || anchor === 'center' ? w / 2 : anchor.endsWith('right') ? w : 0;
  const dy =
    anchor.startsWith('center') || anchor === 'center'
      ? h / 2
      : anchor.startsWith('bottom')
        ? h
        : 0;
  return { dx, dy };
}

/** Where an object sits on a page preview, as percentages of the page (approximate). */
export function previewBox(
  x: number,
  y: number,
  w: number,
  h: number,
  anchor: Anchor,
  page: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const { dx, dy } = anchorShift(anchor, w, h);
  return {
    left: ((x - dx) / page.width) * 100,
    top: ((y - dy) / page.height) * 100,
    width: (w / page.width) * 100,
    height: (h / page.height) * 100,
  };
}

// ---------- Bates ----------

export const BATES_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'outside-alternating',
] as const;
export type BatesPosition = (typeof BATES_POSITIONS)[number];

export interface BatesForm {
  files: string[];
  prefix: string;
  suffix: string;
  startNumber: number;
  digits: number;
  position: BatesPosition;
  fontSize: number;
  outputMode: 'suffix' | 'folder' | 'overwrite';
  outputSuffix: string;
  folder: string;
  stopOnError: boolean;
}

export const DEFAULT_BATES_FORM: BatesForm = {
  files: [],
  prefix: 'HS-',
  suffix: '',
  startNumber: 1,
  digits: 6,
  position: 'bottom-right',
  fontSize: 9,
  outputMode: 'suffix',
  outputSuffix: '_bates',
  folder: '',
  stopOnError: false,
};

export type BatesCheck =
  { ok: true } | { ok: false; field: 'files' | 'folder' | 'digits' | 'start' | 'suffix' };

export function checkBates(form: BatesForm): BatesCheck {
  if (form.files.length === 0) return { ok: false, field: 'files' };
  if (form.outputMode === 'folder' && form.folder.trim() === '') {
    return { ok: false, field: 'folder' };
  }
  if (!inRange(form.digits, 1, 12)) return { ok: false, field: 'digits' };
  if (!inRange(form.startNumber, 0, 1_000_000_000)) return { ok: false, field: 'start' };
  if (form.outputMode === 'suffix' && form.outputSuffix.trim() === '') {
    return { ok: false, field: 'suffix' };
  }
  return { ok: true };
}

/** A Bates code: prefix + zero-padded number + suffix. */
export function batesCode(form: BatesForm, n: number): string {
  return `${form.prefix}${String(n).padStart(form.digits, '0')}${form.suffix}`;
}

export function batesParams(form: BatesForm): OverlayBatesParams {
  const output =
    form.outputMode === 'folder'
      ? { mode: 'folder' as const, folder: form.folder }
      : form.outputMode === 'suffix'
        ? { mode: 'suffix' as const, suffix: form.outputSuffix }
        : { mode: 'overwrite' as const };
  return {
    files: form.files.map((path) => ({ path })),
    prefix: form.prefix,
    suffix: form.suffix,
    startNumber: form.startNumber,
    digits: form.digits,
    position: form.position,
    fontSize: form.fontSize,
    output,
    stopOnError: form.stopOnError,
  };
}

/** One row of overlay.bates (data.files), as the core writes it. */
export interface BatesRow {
  path: string;
  status: 'done' | 'failed' | 'skipped';
  outputPath: string | null;
  pages: number | null;
  firstNumber: string | null;
  lastNumber: string | null;
  errorKind: string | null;
  message: string | null;
}

export function readBatesRows(data: unknown): BatesRow[] {
  const files = (data as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return files.map((f) => {
    const r = f as Record<string, unknown>;
    const status = r.status === 'done' || r.status === 'skipped' ? r.status : 'failed';
    return {
      path: String(r.path ?? ''),
      status,
      outputPath: str(r.outputPath),
      pages: typeof r.pages === 'number' ? r.pages : null,
      firstNumber: str(r.firstLabel) ?? str(r.firstNumber),
      lastNumber: str(r.lastLabel) ?? str(r.lastNumber),
      errorKind: str(r.errorKind),
      message: str(r.message),
    };
  });
}

// ---------- letterhead ----------

export const LETTERHEAD_ROLES = ['first', 'odd', 'even', 'rest'] as const;
export type LetterheadRole = (typeof LETTERHEAD_ROLES)[number];

export interface LetterheadForm {
  sourcePath: string;
  /** Source page (0-based) per role; null = that role is not used. */
  roles: Record<LetterheadRole, number | null>;
  scaling: 'none' | 'fit';
  under: boolean;
  pages: PagesSel;
}

export const DEFAULT_LETTERHEAD_FORM: LetterheadForm = {
  sourcePath: '',
  roles: { first: 0, odd: null, even: null, rest: 0 },
  scaling: 'fit',
  under: true,
  pages: DEFAULT_PAGES,
};

export function letterheadParams(
  form: LetterheadForm,
  current: number,
  pageCount: number,
): OverlayLetterheadParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const roles: Partial<Record<LetterheadRole, number>> = {};
  for (const role of LETTERHEAD_ROLES) {
    const v = form.roles[role];
    if (v !== null) roles[role] = v;
  }
  return {
    ...(sel.ok ? sel.params : {}),
    sourcePath: form.sourcePath,
    sourcePage: form.roles.first ?? 0,
    ...roles,
    scaling: form.scaling,
    under: form.under,
  };
}

export function letterheadProblem(form: LetterheadForm): 'source' | 'roles' | null {
  if (!/\.pdf$/i.test(form.sourcePath)) return 'source';
  if (LETTERHEAD_ROLES.every((r) => form.roles[r] === null)) return 'roles';
  return null;
}

// ---------- overlay manager ----------

export const OVERLAY_KINDS = [
  'text',
  'image',
  'watermark',
  'stamp',
  'header',
  'footer',
  'number',
  'qr',
  'letterhead',
] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export interface OverlayItem {
  id: string;
  kind: OverlayKind;
  group: string;
  pages: number[];
  label: string;
}

export interface OverlayGroup {
  key: string;
  kind: OverlayKind;
  group: string;
  label: string;
  /** 0-based, sorted, unique. */
  pages: number[];
  count: number;
}

/** Items from overlay.listOverlays (data.overlays); malformed entries are skipped. */
export function readOverlays(data: unknown): OverlayItem[] {
  const list = (data as { overlays?: unknown } | null)?.overlays;
  if (!Array.isArray(list)) return [];
  const out: OverlayItem[] = [];
  for (const o of list) {
    const r = o as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.group !== 'string') continue;
    if (!(OVERLAY_KINDS as readonly string[]).includes(String(r.kind))) continue;
    out.push({
      id: r.id,
      kind: r.kind as OverlayKind,
      group: r.group,
      pages: Array.isArray(r.pages)
        ? r.pages.filter((p): p is number => typeof p === 'number')
        : [],
      label: typeof r.label === 'string' ? r.label : '',
    });
  }
  return out;
}

/** Groups overlays by kind and operation group, in kind order. */
export function groupOverlays(items: OverlayItem[]): OverlayGroup[] {
  const map = new Map<string, OverlayGroup>();
  for (const it of items) {
    const key = `${it.kind}\u0000${it.group}`;
    let g = map.get(key);
    if (!g) {
      g = { key, kind: it.kind, group: it.group, label: it.label, pages: [], count: 0 };
      map.set(key, g);
    }
    g.count++;
    for (const p of it.pages) if (!g.pages.includes(p)) g.pages.push(p);
  }
  const rank = (k: OverlayKind) => OVERLAY_KINDS.indexOf(k);
  return [...map.values()]
    .map((g) => ({ ...g, pages: [...g.pages].sort((a, b) => a - b) }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.group.localeCompare(b.group));
}

// ---------- watermark presets from settings ----------

export const MAX_OVERLAY_PRESET_NAME = 60;

export type PresetNameIssue = 'empty' | 'tooLong' | 'duplicate';

/** Trimmed name, unique (case-insensitive) among `taken`. */
export function validatePresetName(
  raw: string,
  taken: string[],
): { ok: true; name: string } | { ok: false; issue: PresetNameIssue } {
  const name = raw.trim();
  if (name === '') return { ok: false, issue: 'empty' };
  if (name.length > MAX_OVERLAY_PRESET_NAME) return { ok: false, issue: 'tooLong' };
  const low = name.toLowerCase();
  if (taken.some((t) => t.toLowerCase() === low)) return { ok: false, issue: 'duplicate' };
  return { ok: true, name };
}

/** The look of a stored preset (bad values fall back to `fallback`). */
export function presetLook(
  params: Record<string, unknown>,
  fallback: WatermarkLook,
): WatermarkLook {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    fontSize: num(params.fontSize, fallback.fontSize),
    bold: typeof params.bold === 'boolean' ? params.bold : fallback.bold,
    color:
      typeof params.color === 'string' && isHexColor(params.color) ? params.color : fallback.color,
    opacity: num(params.opacity, fallback.opacity),
    rotation: num(params.rotation, fallback.rotation),
  };
}
