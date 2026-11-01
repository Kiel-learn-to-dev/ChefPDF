/**
 * Redaction (J6, T6.07): the pattern form -> redact.find params, grouping and checking of the
 * matches, the manual areas and the redact.apply params, and the verification result. Pure.
 *
 * Redaction is permanent: the core removes the content under the boxes and checks the saved file
 * (redact.apply fails with REDACTION_VERIFY_FAILED when text is still there). A match of a text
 * must be selected together with every other occurrence of that text, or the check fails.
 */
import type { RedactApplyParams, RedactPattern } from '@chef/contracts';

export type BuiltinKind = 'cccd' | 'phone' | 'email' | 'bankAccount' | 'taxCode' | 'date';

export const BUILTIN_KINDS: readonly BuiltinKind[] = [
  'cccd',
  'phone',
  'email',
  'bankAccount',
  'taxCode',
  'date',
];

export interface CustomRow {
  id: string;
  kind: 'literal' | 'regex';
  value: string;
  ignoreDiacritics: boolean;
}

export interface RedactForm {
  builtins: Record<BuiltinKind, boolean>;
  custom: CustomRow[];
}

export const DEFAULT_REDACT_FORM: RedactForm = {
  builtins: {
    cccd: true,
    phone: true,
    email: true,
    bankAccount: false,
    taxCode: false,
    date: false,
  },
  custom: [],
};

export type PatternProblem = { kind: 'empty' } | { kind: 'regex'; rowId: string };

/** The redact.find patterns of the form, or the problem that stops the search. */
export function formPatterns(
  form: RedactForm,
): { ok: true; patterns: RedactPattern[] } | { ok: false; problem: PatternProblem } {
  const patterns: RedactPattern[] = [];
  for (const k of BUILTIN_KINDS) {
    if (form.builtins[k]) patterns.push({ kind: k });
  }
  for (const row of form.custom) {
    const value = row.value.trim();
    if (!value) continue;
    if (row.kind === 'regex') {
      if (!isValidRegex(value)) return { ok: false, problem: { kind: 'regex', rowId: row.id } };
      patterns.push({ kind: 'regex', value, ignoreDiacritics: row.ignoreDiacritics });
    } else {
      patterns.push({ kind: 'literal', value, ignoreDiacritics: row.ignoreDiacritics });
    }
  }
  if (patterns.length === 0) return { ok: false, problem: { kind: 'empty' } };
  return { ok: true, patterns };
}

export function isValidRegex(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

export function newCustomRow(id: string, kind: CustomRow['kind'] = 'literal'): CustomRow {
  return { id, kind, value: '', ignoreDiacritics: true };
}

export interface RedactMatch {
  id: string;
  pageIndex: number;
  /** Label of the pattern that found it (a builtin kind or the typed text). */
  pattern: string;
  text: string;
  /** Display frame boxes [x1, y1, x2, y2], points, origin top-left. */
  rects: number[][];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Matches of a redact.find result; malformed entries are skipped. */
export function readMatches(data: unknown): RedactMatch[] {
  if (!isRecord(data) || !Array.isArray(data.matches)) return [];
  const out: RedactMatch[] = [];
  for (const raw of data.matches) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    out.push({
      id: raw.id,
      pageIndex: Number(raw.pageIndex),
      pattern: typeof raw.pattern === 'string' ? raw.pattern : '',
      text: typeof raw.text === 'string' ? raw.text : '',
      rects: Array.isArray(raw.rects)
        ? raw.rects.map((r) => (Array.isArray(r) ? r.map(Number) : []))
        : [],
    });
  }
  return out;
}

export interface MatchGroup {
  pattern: string;
  count: number;
  pages: number[];
  matches: RedactMatch[];
}

/** Matches grouped by pattern, in order of first appearance. */
export function groupMatches(matches: readonly RedactMatch[]): MatchGroup[] {
  const groups = new Map<string, MatchGroup>();
  for (const m of matches) {
    let g = groups.get(m.pattern);
    if (!g) {
      g = { pattern: m.pattern, count: 0, pages: [], matches: [] };
      groups.set(m.pattern, g);
    }
    g.count += 1;
    g.matches.push(m);
    if (!g.pages.includes(m.pageIndex)) g.pages.push(m.pageIndex);
  }
  for (const g of groups.values()) g.pages.sort((a, b) => a - b);
  return [...groups.values()];
}

/** Every match starts checked. */
export function defaultMatchSelection(matches: readonly RedactMatch[]): string[] {
  return matches.map((m) => m.id);
}

export function toggleMatch(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Checks or unchecks every match of one group. */
export function setGroupChecked(
  selected: readonly string[],
  group: MatchGroup,
  checked: boolean,
): string[] {
  const ids = new Set(group.matches.map((m) => m.id));
  const rest = selected.filter((id) => !ids.has(id));
  return checked ? [...rest, ...group.matches.map((m) => m.id)] : rest;
}

/**
 * Matches not checked. A non-zero count means some occurrences stay visible; the dialog then
 * warns that all occurrences of a text should be redacted.
 */
export function unselectedCount(
  matches: readonly RedactMatch[],
  selected: readonly string[],
): number {
  const on = new Set(selected);
  return matches.filter((m) => !on.has(m.id)).length;
}

/** A manual area: a box drawn on a page, display frame points [x1, y1, x2, y2], origin top-left. */
export interface ManualArea {
  id: string;
  pageIndex: number;
  rect: [number, number, number, number];
}

/** A placement result (overlay placement layer, box mode) as a manual area; null when empty. */
export function manualFromBox(
  id: string,
  box: { pageIndex: number; x: number; y: number; width: number; height: number },
): ManualArea | null {
  if (box.width < 1 || box.height < 1) return null;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    id,
    pageIndex: box.pageIndex,
    rect: [round(box.x), round(box.y), round(box.x + box.width), round(box.y + box.height)],
  };
}

export interface ApplyChoices {
  patterns: RedactPattern[];
  matchIds: string[];
  areas: ManualArea[];
  fill: string;
  alsoMetadata: boolean;
  removeFromAnnotations: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * redact.apply params, or null when nothing is chosen. The patterns go along with the match ids,
 * because the core finds the matches again to check them.
 */
export function applyParams(c: ApplyChoices): RedactApplyParams | null {
  if (c.matchIds.length === 0 && c.areas.length === 0) return null;
  const fill = HEX.test(c.fill) ? c.fill : '#000000';
  return {
    ...(c.matchIds.length > 0 ? { patterns: c.patterns, matchIds: [...new Set(c.matchIds)] } : {}),
    rects: c.areas.map((a) => ({ pageIndex: a.pageIndex, rect: [...a.rect] })),
    fill,
    alsoMetadata: c.alsoMetadata,
    removeFromAnnotations: c.removeFromAnnotations,
  };
}

export interface RedactLeak {
  where: string;
  pattern: string;
}

export interface Verification {
  ok: boolean;
  leaks: RedactLeak[];
}

/** The verification part of a redact.apply result. */
export function readVerification(data: unknown): Verification {
  const v = isRecord(data) && isRecord(data.verification) ? data.verification : {};
  const leaks = Array.isArray(v.leaks)
    ? v.leaks.filter(isRecord).map((l) => ({
        where: typeof l.where === 'string' ? l.where : '',
        pattern: typeof l.pattern === 'string' ? l.pattern : '',
      }))
    : [];
  return { ok: v.ok !== false && leaks.length === 0, leaks };
}
