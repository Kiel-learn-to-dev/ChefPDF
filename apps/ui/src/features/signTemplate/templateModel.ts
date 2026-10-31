/**
 * Signature template model (I10-I18). Pure: no React, no bridge.
 *
 * `SignatureTemplate` is the wire object of the core (packages/contracts/src/generated/ops.ts).
 * The limits below mirror core/chef_core/signing/appearance.py, so a template saved here is always
 * accepted by the core. Values out of range are clamped and reported as warnings.
 */
import type { ImageSlot, SignatureTemplate, TemplateLine } from '@chef/contracts';

export const TEMPLATE_FORMAT = 'chef-sign-template';
export const TEMPLATE_FORMAT_VERSION = 1;
export const MAX_TEMPLATE_LINES = 12;

export const LAYOUTS = ['text-only', 'image-left', 'image-right', 'image-background'] as const;
export const LINE_SOURCES = [
  'signerName',
  'organization',
  'taxCode',
  'citizenId',
  'reason',
  'location',
  'contact',
  'date',
  'custom',
] as const;
export const ALIGNS = ['left', 'center', 'right'] as const;
export const VALIGNS = ['top', 'middle', 'bottom'] as const;
export const FITS = ['contain', 'cover', 'stretch'] as const;

/** Python defaults (appearance.py SignatureTemplate). */
export const DEFAULT_TEMPLATE: SignatureTemplate = {
  name: 'Mặc định',
  layout: 'text-only',
  header: 'Ký số bởi',
  lines: [
    { source: 'signerName', enabled: true },
    { source: 'date', enabled: true },
  ],
  dateFormat: 'dd/MM/yyyy HH:mm:ss',
  showTimezone: false,
  fontName: 'BeVietnamPro',
  fontSize: 9,
  minFontSize: 5,
  autoShrink: true,
  bold: false,
  textColor: '#000000',
  align: 'left',
  valign: 'middle',
  padding: 4,
  border: { color: '#1F3A93', width: 0.8 },
  background: { color: '#FFFFFF', opacity: 0 },
  checkmark: false,
  checkColor: '#1E8E3E',
  imageRatio: 0.35,
};

/** Clones the defaults, so callers can change the result freely. */
export function defaultTemplate(name?: string): SignatureTemplate {
  const copy = structuredClone(DEFAULT_TEMPLATE);
  if (name) copy.name = name;
  return copy;
}

export const LIMITS = {
  nameMax: 80,
  headerMax: 120,
  labelMax: 60,
  textMax: 500,
  dateFormatMax: 80,
  fontSize: [2, 72] as const,
  minFontSize: [1, 72] as const,
  lineFontSize: [1, 72] as const,
  padding: [0, 60] as const,
  borderWidth: [0.1, 10] as const,
  imageRatio: [0.1, 0.9] as const,
  opacity: [0, 1] as const,
} as const;

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

export function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

/** Result of normalising untrusted template data: a valid template plus what was changed. */
export interface Normalized {
  template: SignatureTemplate;
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(
  v: unknown,
  range: readonly [number, number],
  fallback: number,
  warnings: string[],
  what: string,
): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    warnings.push(`${what}: ${String(v)} is not a number`);
    return fallback;
  }
  const c = clamp(v, range);
  if (c !== v) warnings.push(`${what} limited to ${range[0]}–${range[1]}`);
  return c;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return (options as readonly string[]).includes(v as string) ? (v as T) : fallback;
}

function color(v: unknown, fallback: string, warnings: string[], what: string): string {
  if (v === undefined || v === null) return fallback;
  if (isHexColor(v)) return v.toUpperCase();
  warnings.push(`${what}: colour must look like #1F3A93`);
  return fallback;
}

function slot(v: unknown, warnings: string[], what: string): ImageSlot | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v) || typeof v.path !== 'string' || v.path.length === 0) {
    warnings.push(`${what}: needs a file`);
    return null;
  }
  return {
    path: v.path,
    fit: oneOf(v.fit, FITS, 'contain'),
    opacity: num(v.opacity, LIMITS.opacity, 1, warnings, `${what} opacity`),
  };
}

function line(raw: unknown, warnings: string[]): TemplateLine | null {
  if (!isObj(raw)) return null;
  const source = oneOf(raw.source, LINE_SOURCES, 'signerName' as (typeof LINE_SOURCES)[number]);
  if (source !== raw.source) return null;
  const out: TemplateLine = { source, enabled: bool(raw.enabled, true) };
  if (typeof raw.label === 'string') out.label = raw.label.slice(0, LIMITS.labelMax);
  if (typeof raw.text === 'string') out.text = raw.text.slice(0, LIMITS.textMax);
  if (raw.fontSize !== undefined && raw.fontSize !== null) {
    out.fontSize = num(raw.fontSize, LIMITS.lineFontSize, 9, warnings, 'line font size');
  }
  if (source === 'custom' && !(out.text && out.text.trim())) {
    // The core refuses a custom line without text: keep it, but disabled, and say why.
    out.enabled = false;
    warnings.push('a custom line without text was turned off');
  }
  return out;
}

/** Clamps every field to the core's limits and fills defaults. Never throws. */
export function normalizeTemplate(raw: unknown): Normalized {
  const warnings: string[] = [];
  const d = DEFAULT_TEMPLATE;
  if (!isObj(raw)) return { template: defaultTemplate(), warnings: ['template is not an object'] };

  const fontSize = num(raw.fontSize, LIMITS.fontSize, d.fontSize!, warnings, 'font size');
  let minFontSize = num(
    raw.minFontSize,
    LIMITS.minFontSize,
    d.minFontSize!,
    warnings,
    'minimum font size',
  );
  if (minFontSize > fontSize) {
    warnings.push('minimum font size cannot be larger than the font size');
    minFontSize = fontSize;
  }

  const rawLines = Array.isArray(raw.lines) ? raw.lines : d.lines!;
  const lines: TemplateLine[] = [];
  for (const item of rawLines.slice(0, MAX_TEMPLATE_LINES)) {
    const parsed = line(item, warnings);
    if (parsed) lines.push(parsed);
    else warnings.push('an unknown line was removed');
  }
  if (rawLines.length > MAX_TEMPLATE_LINES) warnings.push(`at most ${MAX_TEMPLATE_LINES} lines`);

  const dateFormat =
    typeof raw.dateFormat === 'string' &&
    raw.dateFormat.length > 0 &&
    raw.dateFormat.length <= LIMITS.dateFormatMax
      ? raw.dateFormat
      : d.dateFormat!;

  const template: SignatureTemplate = {
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, LIMITS.nameMax)
        : d.name!,
    layout: oneOf(raw.layout, LAYOUTS, d.layout!),
    header:
      raw.header === null
        ? null
        : typeof raw.header === 'string'
          ? raw.header.slice(0, LIMITS.headerMax)
          : d.header!,
    lines,
    dateFormat,
    showTimezone: bool(raw.showTimezone, d.showTimezone!),
    fontName: 'BeVietnamPro',
    fontSize,
    minFontSize,
    autoShrink: bool(raw.autoShrink, d.autoShrink!),
    bold: bool(raw.bold, d.bold!),
    textColor: color(raw.textColor, d.textColor!, warnings, 'text colour'),
    align: oneOf(raw.align, ALIGNS, d.align!),
    valign: oneOf(raw.valign, VALIGNS, d.valign!),
    padding: num(raw.padding, LIMITS.padding, d.padding!, warnings, 'padding'),
    checkmark: bool(raw.checkmark, d.checkmark!),
    checkColor: color(raw.checkColor, d.checkColor!, warnings, 'check colour'),
    imageRatio: num(raw.imageRatio, LIMITS.imageRatio, d.imageRatio!, warnings, 'image share'),
  };

  if (raw.border === null) template.border = null;
  else if (isObj(raw.border)) {
    template.border = {
      color: color(raw.border.color, d.border!.color!, warnings, 'border colour'),
      width: num(raw.border.width, LIMITS.borderWidth, d.border!.width!, warnings, 'border width'),
    };
  } else template.border = { ...d.border! };

  if (isObj(raw.background)) {
    template.background = {
      color: color(raw.background.color, d.background!.color!, warnings, 'background colour'),
      opacity: num(raw.background.opacity, LIMITS.opacity, 0, warnings, 'background opacity'),
    };
  } else template.background = { ...d.background! };

  const image = slot(raw.image, warnings, 'image');
  if (image) template.image = image;
  const logo = slot(raw.logo, warnings, 'logo');
  if (logo) template.logo = logo;

  return { template, warnings };
}

/**
 * Wire object for the core: image and logo are removed here, because their file paths are only
 * valid while the studio is open (the library item is the stored reference).
 */
export function toWire(template: SignatureTemplate): SignatureTemplate {
  const rest: SignatureTemplate = { ...template };
  delete rest.image;
  delete rest.logo;
  return structuredClone(rest);
}

/** Form value -> stored form: round trip through normalise, so stored data is always valid. */
export function fromWire(raw: unknown): SignatureTemplate {
  return normalizeTemplate(raw).template;
}

/** Moves the line at `from` to `to` (both indices in range; out of range is a no-op). */
export function moveLine(lines: readonly TemplateLine[], from: number, to: number): TemplateLine[] {
  if (from < 0 || to < 0 || from >= lines.length || to >= lines.length || from === to) {
    return [...lines];
  }
  const next = [...lines];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** A new empty line for a source (custom lines get a placeholder text). */
export function newLine(source: (typeof LINE_SOURCES)[number]): TemplateLine {
  return source === 'custom'
    ? { source, enabled: true, text: 'Thông tin tùy ý' }
    : { source, enabled: true };
}

/** File written by "Xuất mẫu" and read by "Nhập mẫu". */
export function templateFileText(template: SignatureTemplate): string {
  return (
    JSON.stringify(
      { format: TEMPLATE_FORMAT, version: TEMPLATE_FORMAT_VERSION, template: toWire(template) },
      null,
      2,
    ) + '\n'
  );
}

/** Reads a template file (the wrapper above, or a bare template object). Throws on bad JSON. */
export function parseTemplateFile(text: string): Normalized {
  const parsed: unknown = JSON.parse(text);
  if (!isObj(parsed)) throw new Error('not a template');
  if (parsed.format === TEMPLATE_FORMAT) {
    if (parsed.version !== TEMPLATE_FORMAT_VERSION) throw new Error('unsupported version');
    return normalizeTemplate(parsed.template);
  }
  if ('layout' in parsed || 'lines' in parsed || 'fontSize' in parsed)
    return normalizeTemplate(parsed);
  throw new Error('not a template');
}

// -- dates -------------------------------------------------------------------------------------

const DATE_TOKEN = /'(?:[^']|'')*'|yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g;

/**
 * Formats a date with the core's token pattern (appearance.py format_date): yyyy yy MM M dd d
 * HH H mm m ss s; text in single quotes is literal ('' is one quote). Uses the local time zone.
 */
export function formatDatePattern(date: Date, pattern: string, showTimezone = false): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    yyyy: String(date.getFullYear()).padStart(4, '0'),
    yy: p2(date.getFullYear() % 100),
    MM: p2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: p2(date.getDate()),
    d: String(date.getDate()),
    HH: p2(date.getHours()),
    H: String(date.getHours()),
    mm: p2(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: p2(date.getSeconds()),
    s: String(date.getSeconds()),
  };
  let text = pattern.replace(DATE_TOKEN, (token) =>
    token.startsWith("'") ? token.slice(1, -1).replace(/''/g, "'") : (tokens[token] ?? token),
  );
  if (showTimezone) {
    // getTimezoneOffset is minutes behind UTC, so flip the sign.
    const minutes = -date.getTimezoneOffset();
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    text += ` (UTC${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)})`;
  }
  return text;
}
