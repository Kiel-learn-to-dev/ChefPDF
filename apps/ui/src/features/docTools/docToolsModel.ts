/**
 * "Thuộc tính & tiện ích" (M7-M11) and "Sửa file hỏng" (M11): the forms, their checks and the core
 * params of each small action. Pure.
 */
import type { DocSetMetadataParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

// ---------- metadata (M9) ----------

/** Standard Info keys, in the order of the form. The core keys are the same names. */
export const STANDARD_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
] as const;
export type StandardKey = (typeof STANDARD_KEYS)[number];
export const DATE_KEYS: readonly StandardKey[] = ['CreationDate', 'ModDate'];
export const MAX_CUSTOM = 30;
export const MAX_VALUE = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface CustomEntry {
  key: string;
  value: string;
}

export type MetadataForm = Record<StandardKey, string> & { custom: CustomEntry[] };

export const EMPTY_METADATA: MetadataForm = {
  Title: '',
  Author: '',
  Subject: '',
  Keywords: '',
  Creator: '',
  Producer: '',
  CreationDate: '',
  ModDate: '',
  custom: [],
};

/** Form from the document's Info values (DocumentInfo.metadata). Unknown keys become custom. */
export function formFromMetadata(metadata: Record<string, string>): MetadataForm {
  const form: MetadataForm = { ...EMPTY_METADATA, custom: [] };
  for (const [key, value] of Object.entries(metadata)) {
    if ((STANDARD_KEYS as readonly string[]).includes(key)) {
      form[key as StandardKey] = value;
    } else {
      form.custom.push({ key, value });
    }
  }
  return form;
}

export type MetadataProblem = 'customKey' | 'duplicateKey' | 'customLimit' | 'date' | 'length';

/** First problem with the form, or null. Empty values mean "remove". */
export function metadataProblem(form: MetadataForm): MetadataProblem | null {
  for (const k of DATE_KEYS) {
    const v = form[k].trim();
    if (v.length > 0 && !ISO_DATE.test(v)) return 'date';
  }
  for (const k of STANDARD_KEYS) {
    if (form[k].length > MAX_VALUE) return 'length';
  }
  if (form.custom.length > MAX_CUSTOM) return 'customLimit';
  const seen = new Set<string>();
  for (const c of form.custom) {
    const key = c.key.trim();
    if (key.length === 0 || /[\s/()<>[\]{}%]/.test(key) || key.length > 64) return 'customKey';
    if ((STANDARD_KEYS as readonly string[]).includes(key)) return 'customKey';
    if (seen.has(key)) return 'duplicateKey';
    seen.add(key);
    if (c.value.length > MAX_VALUE) return 'length';
  }
  return null;
}

const WIRE: Record<
  StandardKey,
  'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer' | 'creationDate' | 'modDate'
> = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  Creator: 'creator',
  Producer: 'producer',
  CreationDate: 'creationDate',
  ModDate: 'modDate',
};

/** doc.setMetadata params. An empty value removes the key; `clear` removes every property first. */
export function metadataParams(form: MetadataForm, clear = false): DocSetMetadataParams {
  if (clear) return { clear: true };
  const out: DocSetMetadataParams = {};
  for (const k of STANDARD_KEYS) out[WIRE[k]] = form[k].trim();
  const custom: Record<string, string> = {};
  for (const c of form.custom) {
    const key = c.key.trim();
    if (key) custom[key] = c.value.trim();
  }
  out.custom = custom;
  return out;
}

// ---------- attachments (M8) ----------

export interface AttachmentRow {
  name: string;
  size: number;
  description: string;
}

/** Sort by name (case-insensitive), keeping the core's order for equal names. */
export function sortAttachments(rows: readonly AttachmentRow[]): AttachmentRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Attachment names to act on: the selection, or every attachment when nothing is selected. */
export function attachmentNames(
  rows: readonly AttachmentRow[],
  selected: ReadonlySet<string>,
): string[] {
  return selected.size === 0
    ? rows.map((r) => r.name)
    : rows.filter((r) => selected.has(r.name)).map((r) => r.name);
}

// ---------- extract images / text (M7) ----------

/** The page list of a "1,3-5" field, 0-based. An empty field means every page. */
export function pagesFromField(
  input: string,
  pageCount: number,
): { ok: true; pages: number[] | undefined } | { ok: false } {
  if (input.trim().length === 0) return { ok: true, pages: undefined };
  const r = parsePageRanges(input, pageCount);
  return r.ok ? { ok: true, pages: r.pages } : { ok: false };
}

export const DEFAULT_IMAGE_TEMPLATE = '{page}_{index}';

export type TemplateProblem = 'empty' | 'separator' | 'invalidChars' | 'long';

/** The image name template: a file name without extension. */
export function imageTemplateProblem(template: string): TemplateProblem | null {
  if (template.trim().length === 0) return 'empty';
  if (/[\\/]/.test(template)) return 'separator';
  if (/[<>:"|?*]/.test(template) || [...template].some((c) => c.charCodeAt(0) < 32)) {
    return 'invalidChars';
  }
  if (template.length > 80) return 'long';
  return null;
}

export function extractImagesParams(
  outputDir: string,
  pages: number[] | undefined,
  nameTemplate: string,
) {
  return {
    outputDir,
    ...(pages ? { pages } : {}),
    nameTemplate: nameTemplate.trim(),
  };
}

export function extractTextParams(outputPath: string, pageMarkers: boolean) {
  return { outputPath, pageMarkers };
}

// ---------- optimise for web (M10) ----------

/**
 * The saved file of the open document, or null when it must be saved first. A signed document is
 * never rewritten: linearising it would break its signatures.
 */
export function webSourcePath(state: {
  sourcePath: string | null;
  dirty: boolean;
  signed: boolean;
}): string | null {
  if (!state.sourcePath || state.dirty || state.signed) return null;
  return state.sourcePath;
}

/** Percent of bytes saved (0 when the file did not shrink or the size is unknown). */
export function savedPercent(beforeBytes: number, afterBytes: number): number {
  if (beforeBytes <= 0 || afterBytes >= beforeBytes) return 0;
  return Math.round(((beforeBytes - afterBytes) / beforeBytes) * 100);
}

// ---------- repair (M11) ----------

/** Output name of a repair: "<name>_sua.pdf" next to the damaged file. */
export function repairOutputPath(inputPath: string): string {
  const slash = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'));
  const dir = slash >= 0 ? inputPath.slice(0, slash + 1) : '';
  const name = slash >= 0 ? inputPath.slice(slash + 1) : inputPath;
  const dot = name.toLowerCase().endsWith('.pdf') ? name.length - 4 : name.length;
  return `${dir}${name.slice(0, dot)}_sua.pdf`;
}

export function repairParams(inputPath: string, outputPath: string) {
  return { inputPath, outputPath };
}

/** Warnings and page count of a repair result (doc.repair data). */
export function parseRepairData(data: unknown): {
  recovered: boolean;
  pageCount: number;
  warnings: string[];
} {
  const d = (data ?? {}) as { recovered?: unknown; pageCount?: unknown; warnings?: unknown };
  return {
    recovered: d.recovered === true,
    pageCount: typeof d.pageCount === 'number' ? d.pageCount : 0,
    warnings: Array.isArray(d.warnings)
      ? d.warnings.filter((w): w is string => typeof w === 'string')
      : [],
  };
}
