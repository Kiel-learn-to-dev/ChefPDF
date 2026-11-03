import type { FormsAddFieldParams } from '@chef/contracts';

export const FORM_KINDS = [
  'text',
  'multiline',
  'comb',
  'checkbox',
  'radio',
  'dropdown',
  'signature',
] as const;
export type FormKind = (typeof FORM_KINDS)[number];
export type FormValue = boolean | string | string[] | null;

export interface FormField {
  name: string;
  type: string;
  page: number | null;
  value: FormValue;
  options: { export: string; display: string }[];
  tooltip?: string | null;
  flags: { readOnly: boolean; required: boolean; maxLen: number | null; multiline?: boolean };
  widgets: { page: number | null; rect: number[] | null; hasAppearance: boolean }[];
}

export interface PendingFormRect {
  pageIndex: number;
  rect: number[];
}

export interface CreateFormDraft {
  kind: FormKind;
  name: string;
  label: string;
  optionsText: string;
  maxLenText: string;
  required: boolean;
}

export const DEFAULT_CREATE_FORM: CreateFormDraft = {
  kind: 'text',
  name: '',
  label: '',
  optionsText: '',
  maxLenText: '',
  required: false,
};

export function parseOptions(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export type CreateIssue = 'name' | 'options' | 'maxLen' | 'rect' | 'radioSize';

export function createIssue(
  draft: CreateFormDraft,
  pending: PendingFormRect | null,
): CreateIssue | null {
  const name = draft.name.trim();
  if (
    !name ||
    name.length > 120 ||
    name.split('.').some((part) => !/^[^\s.[\](){}<>/%]+$/.test(part))
  ) {
    return 'name';
  }
  if (!pending || pending.rect.length !== 4) return 'rect';
  const [x0, top, x1, bottom] = pending.rect as [number, number, number, number];
  const width = x1 - x0;
  if (![x0, top, x1, bottom].every(Number.isFinite) || width < 14 || bottom - top < 14) {
    return 'rect';
  }
  const options = parseOptions(draft.optionsText);
  if ((draft.kind === 'radio' || draft.kind === 'dropdown') && options.length < 2) {
    return 'options';
  }
  if (draft.kind === 'radio' && width / options.length < 14) return 'radioSize';
  if (draft.kind === 'comb') {
    const maxLen = Number(draft.maxLenText);
    if (!Number.isInteger(maxLen) || maxLen < 1 || maxLen > 100_000) return 'maxLen';
  }
  return null;
}

/** Build core field params. Radio choices share a field name and divide the drawn box evenly. */
export function createParams(
  draft: CreateFormDraft,
  pending: PendingFormRect,
): FormsAddFieldParams[] | null {
  if (createIssue(draft, pending)) return null;
  const name = draft.name.trim();
  const options = parseOptions(draft.optionsText);
  const [x0, top, x1, bottom] = pending.rect as [number, number, number, number];
  const base = {
    kind: draft.kind,
    pageIndex: pending.pageIndex,
    rect: pending.rect,
    name,
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
    required: draft.required,
  } as const;
  if (draft.kind === 'radio') {
    const slot = (x1 - x0) / options.length;
    return options.map((option, index) => ({
      ...base,
      kind: 'radio',
      rect: [x0 + slot * index, top, x0 + slot * (index + 1), bottom],
      exportValue: option,
    }));
  }
  if (draft.kind === 'dropdown') return [{ ...base, kind: 'dropdown', options }];
  if (draft.kind === 'comb') {
    return [{ ...base, kind: 'comb', maxLen: Number(draft.maxLenText) }];
  }
  if (draft.kind === 'checkbox') return [{ ...base, kind: 'checkbox' }];
  if (draft.kind === 'signature') return [{ ...base, kind: 'signature' }];
  return [{ ...base, kind: draft.kind }];
}

export function readFormFields(data: unknown): {
  fields: FormField[];
  xfa: boolean;
  needAppearances: boolean;
} {
  if (typeof data !== 'object' || data === null)
    return { fields: [], xfa: false, needAppearances: false };
  const value = data as { fields?: unknown; xfa?: unknown; needAppearances?: unknown };
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((field): field is FormField => {
        if (typeof field !== 'object' || field === null) return false;
        const item = field as Partial<FormField>;
        return typeof item.name === 'string' && typeof item.type === 'string';
      })
    : [];
  return { fields, xfa: value.xfa === true, needAppearances: value.needAppearances === true };
}

export function isChanged(changes: Record<string, FormValue>): boolean {
  return Object.keys(changes).length > 0;
}
