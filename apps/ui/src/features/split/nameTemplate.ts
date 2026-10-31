import { parsePageRanges, type PageGroup } from '../../lib/pageRange';
import type { SplitMode } from '../../lib/ops';

export const DEFAULT_NAME_TEMPLATE = '{name}_{index}';
export const TEMPLATE_VARIABLES = ['name', 'index', 'start', 'end'] as const;

export interface NameVars {
  name: string;
  /** 1-based. */
  index: number;
  total: number;
  start: number;
  end: number;
}

const VAR = /\{(\w+)\}/g;
// eslint-disable-next-line no-control-regex -- control characters are illegal in file names
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Variables used in a template that the core does not know. */
export function unknownVariables(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(VAR)) {
    const v = m[1]!;
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Render one output file name (with ".pdf"), following CONTRACTS §6. */
export function renderName(template: string, vars: NameVars): string {
  const digits = String(Math.max(1, vars.total)).length;
  const base = (template.trim() || DEFAULT_NAME_TEMPLATE).replace(VAR, (whole, v: string) => {
    switch (v) {
      case 'name':
        return vars.name;
      case 'index':
        return String(vars.index).padStart(digits, '0');
      case 'start':
        return String(vars.start);
      case 'end':
        return String(vars.end);
      default:
        return whole;
    }
  });
  const safe = base.replace(ILLEGAL, '_');
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`;
}

export interface SplitPlanInput {
  mode: SplitMode;
  pageCount: number;
  ranges?: string;
  n?: number;
  /** 1-based start pages of top-level bookmarks (for mode "bookmarks"). */
  bookmarkStarts?: number[];
}

/**
 * Page groups the split will produce, for the preview. Returns null when it
 * cannot be known on the client (maxSize) or the input is invalid.
 */
export function planSplit(input: SplitPlanInput): PageGroup[] | null {
  const { mode, pageCount } = input;
  if (pageCount < 1) return null;
  switch (mode) {
    case 'ranges': {
      const r = parsePageRanges(input.ranges ?? '', pageCount);
      return r.ok ? r.groups : null;
    }
    case 'everyN': {
      const n = Math.floor(input.n ?? 0);
      if (n < 1) return null;
      const groups: PageGroup[] = [];
      for (let s = 1; s <= pageCount; s += n)
        groups.push({ start: s, end: Math.min(pageCount, s + n - 1) });
      return groups;
    }
    case 'oddEven': {
      const groups: PageGroup[] = [
        { start: 1, end: pageCount % 2 === 1 ? pageCount : pageCount - 1 },
      ];
      if (pageCount > 1)
        groups.push({ start: 2, end: pageCount % 2 === 0 ? pageCount : pageCount - 1 });
      return groups;
    }
    case 'bookmarks': {
      const starts = [
        ...new Set((input.bookmarkStarts ?? []).filter((p) => p >= 1 && p <= pageCount)),
      ].sort((a, b) => a - b);
      if (starts.length === 0) return null;
      if (starts[0] !== 1) starts.unshift(1);
      return starts.map((s, i) => ({ start: s, end: (starts[i + 1] ?? pageCount + 1) - 1 }));
    }
    case 'maxSize':
      return null;
  }
}

/** Preview file names for a plan (first `limit` names). */
export function previewNames(
  template: string,
  sourceName: string,
  groups: PageGroup[],
  limit = 5,
): string[] {
  return groups
    .slice(0, limit)
    .map((g, i) =>
      renderName(template, {
        name: sourceName,
        index: i + 1,
        total: groups.length,
        start: g.start,
        end: g.end,
      }),
    );
}
