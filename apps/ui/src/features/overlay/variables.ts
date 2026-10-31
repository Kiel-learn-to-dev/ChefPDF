/**
 * Template variables for header, footer, page numbers and Bates text (F7, F8, F9), for the
 * PREVIEW only. The core (core/chef_core/overlay/variables.py) renders the real output; this
 * port must give the same text for the same inputs (see variables.test.ts).
 */

export const VARIABLE_NAMES = [
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
] as const;
export type VariableName = (typeof VARIABLE_NAMES)[number];

export type NumberFormat = 'arabic' | 'roman' | 'ROMAN' | 'alpha' | 'ALPHA';

const ROMAN_TABLE: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** Upper-case roman numeral, 1..3999; null outside that range. */
export function toRoman(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return null;
  let rest = n;
  let out = '';
  for (const [value, letters] of ROMAN_TABLE) {
    const count = Math.floor(rest / value);
    rest -= count * value;
    out += letters.repeat(count);
  }
  return out;
}

/** Upper-case bijective base-26 letters (1 = A, 27 = AA); null for n < 1. */
export function toAlpha(n: number): string | null {
  if (!Number.isInteger(n) || n < 1) return null;
  let rest = n;
  let out = '';
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/** The number in a format; null when the format cannot show it (roman > 3999, alpha < 1). */
export function formatNumber(n: number, fmt: NumberFormat): string | null {
  switch (fmt) {
    case 'arabic':
      return String(n);
    case 'roman':
      return toRoman(n)?.toLowerCase() ?? null;
    case 'ROMAN':
      return toRoman(n);
    case 'alpha':
      return toAlpha(n)?.toLowerCase() ?? null;
    case 'ALPHA':
      return toAlpha(n);
  }
}

const DATE_TOKEN = /'(?:[^']|'')*'|yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g;

/** Date with the token pattern used by the signature appearance (yyyy MM dd HH mm ss, quotes). */
export function formatDate(value: Date, pattern: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const tokens: Record<string, string> = {
    yyyy: pad(value.getFullYear(), 4),
    yy: pad(value.getFullYear() % 100),
    MM: pad(value.getMonth() + 1),
    M: String(value.getMonth() + 1),
    dd: pad(value.getDate()),
    d: String(value.getDate()),
    HH: pad(value.getHours()),
    H: String(value.getHours()),
    mm: pad(value.getMinutes()),
    m: String(value.getMinutes()),
    ss: pad(value.getSeconds()),
    s: String(value.getSeconds()),
  };
  return pattern.replace(DATE_TOKEN, (token) =>
    token.startsWith("'") ? token.slice(1, -1).replace(/''/g, "'") : (tokens[token] ?? token),
  );
}

export type TemplatePart = { text: string } | { variable: VariableName };

export type TemplateIssue = 'unclosed' | 'stray' | 'unknown';

/** Splits a template; `{{` and `}}` are literal braces. Errors name the problem. */
export function parseTemplate(
  template: string,
): { ok: true; parts: TemplatePart[] } | { ok: false; issue: TemplateIssue; variable?: string } {
  const parts: TemplatePart[] = [];
  let buf = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === '{') {
      if (template.startsWith('{{', i)) {
        buf += '{';
        i += 2;
        continue;
      }
      const end = template.indexOf('}', i);
      if (end === -1) return { ok: false, issue: 'unclosed' };
      const name = template.slice(i + 1, end);
      if (!(VARIABLE_NAMES as readonly string[]).includes(name)) {
        return { ok: false, issue: 'unknown', variable: name };
      }
      if (buf) parts.push({ text: buf });
      buf = '';
      parts.push({ variable: name as VariableName });
      i = end + 1;
    } else if (ch === '}') {
      if (template.startsWith('}}', i)) {
        buf += '}';
        i += 2;
        continue;
      }
      return { ok: false, issue: 'stray' };
    } else {
      buf += ch;
      i++;
    }
  }
  if (buf) parts.push({ text: buf });
  return { ok: true, parts };
}

/** Document values used by the preview (the same fields as core DocVars). */
export interface PreviewDoc {
  filename: string;
  title: string;
  author: string;
  pageCount: number;
  startNumber: number;
  dateFormat: string;
  now: Date;
  /** [0-based start page, title] */
  sections: [number, string][];
  batesPrefix: string;
  batesSuffix: string;
  batesDigits: number;
}

export type RenderResult =
  { ok: true; text: string } | { ok: false; issue: 'range' | TemplateIssue; variable?: string };

/** Text of `template` for the page at `index` (0-based). */
export function renderTemplate(
  template: string,
  index: number,
  doc: PreviewDoc,
  numberFormat: NumberFormat = 'arabic',
): RenderResult {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return parsed;
  const page = index + doc.startNumber;
  const last = doc.pageCount - 1 + doc.startNumber;
  const sections = [...doc.sections].sort((a, b) => a[0] - b[0]);
  let section = '';
  for (const [start, name] of sections) if (start <= index) section = name;
  const value = (name: VariableName): string | null => {
    switch (name) {
      case 'page':
        return formatNumber(page, numberFormat);
      case 'pages':
        return formatNumber(last, numberFormat);
      case 'page_roman':
        return formatNumber(page, 'ROMAN');
      case 'page_alpha':
        return formatNumber(page, 'ALPHA');
      case 'date':
        return formatDate(doc.now, doc.dateFormat);
      case 'time':
        return `${pad2(doc.now.getHours())}:${pad2(doc.now.getMinutes())}`;
      case 'filename':
        return doc.filename;
      case 'title':
        return doc.title;
      case 'author':
        return doc.author;
      case 'bates':
        return `${doc.batesPrefix}${String(page).padStart(doc.batesDigits, '0')}${doc.batesSuffix}`;
      case 'section':
        return section;
    }
  };
  let out = '';
  for (const part of parsed.parts) {
    if ('text' in part) {
      out += part.text;
      continue;
    }
    const v = value(part.variable);
    if (v === null) return { ok: false, issue: 'range', variable: part.variable };
    out += v;
  }
  return { ok: true, text: out };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
