/**
 * Pure model of "Tách thông minh" (C10; T5.09): file.splitSmart, which splits one PDF into files
 * at blank separator pages, at a bookmark level, or at pages matching a regular expression.
 */
import type { FileSplitSmartParams } from '@chef/contracts';
import { DEFAULT_NAME_TEMPLATE, unknownVariables } from '../split/nameTemplate';

export type SmartMode = 'blank' | 'bookmarkLevel' | 'pattern';

export interface SmartSplitForm {
  mode: SmartMode;
  /** bookmarkLevel: 1 = top level. */
  level: number;
  pattern: string;
  ignoreCase: boolean;
  dropSeparatorPages: boolean;
  blankSensitivity: number;
  outputDir: string;
  nameTemplate: string;
}

export const DEFAULT_SMART_SPLIT_FORM: SmartSplitForm = {
  mode: 'blank',
  level: 1,
  pattern: '',
  ignoreCase: true,
  dropSeparatorPages: false,
  blankSensitivity: 0.5,
  outputDir: '',
  nameTemplate: DEFAULT_NAME_TEMPLATE,
};

export type SmartSplitIssue = 'level' | 'pattern' | 'outputDir' | 'nameTemplate';

function patternValid(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function smartSplitIssues(form: SmartSplitForm): SmartSplitIssue[] {
  const out: SmartSplitIssue[] = [];
  if (
    form.mode === 'bookmarkLevel' &&
    !(Number.isInteger(form.level) && form.level >= 1 && form.level <= 10)
  ) {
    out.push('level');
  }
  if (form.mode === 'pattern' && (!form.pattern || !patternValid(form.pattern))) {
    out.push('pattern');
  }
  if (!form.outputDir) out.push('outputDir');
  if (!form.nameTemplate.trim() || unknownVariables(form.nameTemplate).length > 0) {
    out.push('nameTemplate');
  }
  return out;
}

/** Params of file.splitSmart; only the fields of the chosen mode are sent. */
export function smartSplitParams(
  form: SmartSplitForm,
  path: string,
  password?: string,
): FileSplitSmartParams {
  const out: FileSplitSmartParams = {
    path,
    mode: form.mode,
    dropSeparatorPages: form.mode === 'blank' ? form.dropSeparatorPages : false,
    blankSensitivity: form.blankSensitivity,
    outputDir: form.outputDir,
    nameTemplate: form.nameTemplate,
  };
  if (password) out.password = password;
  if (form.mode === 'bookmarkLevel') out.level = form.level;
  if (form.mode === 'pattern') {
    out.pattern = form.pattern;
    out.ignoreCase = form.ignoreCase;
  }
  return out;
}

export interface SmartSplitResult {
  parts: number;
  outputs: string[];
}

/** Reads the result of file.splitSmart: the part count and the written file paths. */
export function readSmartSplitResult(data: unknown, outputs: readonly string[]): SmartSplitResult {
  const d = (data ?? {}) as Record<string, unknown>;
  const parts = typeof d.parts === 'number' && Number.isFinite(d.parts) ? d.parts : outputs.length;
  return { parts, outputs: [...outputs] };
}
