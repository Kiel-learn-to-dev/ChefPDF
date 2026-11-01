/**
 * Pure model of "Soi file & dọn dữ liệu ẩn" (J3, J4; T5.02). Reads the output of
 * inspect.hiddenData and builds the params of inspect.removeHidden.
 */
import type { InspectRemoveHiddenParams } from '@chef/contracts';

export type RemovableCategory = InspectRemoveHiddenParams['categories'][number];

export const INSPECT_CATEGORIES = [
  'metadata',
  'embeddedFiles',
  'javascript',
  'launchActions',
  'hiddenText',
  'hiddenLayers',
  'comments',
  'formValues',
  'bookmarks',
  'thumbnails',
  'externalLinks',
  'xfa',
  'revisionHistory',
  'unusedObjects',
  'fontsNotEmbedded',
  'images',
] as const;
export type InspectCategory = (typeof INSPECT_CATEGORIES)[number];

/** Categories inspect.removeHidden accepts (the rest are reported only). */
export const REMOVABLE: ReadonlySet<string> = new Set([
  'metadata',
  'embeddedFiles',
  'javascript',
  'launchActions',
  'hiddenLayers',
  'comments',
  'formValues',
  'bookmarks',
  'thumbnails',
  'externalLinks',
  'xfa',
  'revisionHistory',
  'unusedObjects',
]);

export type Severity = 'info' | 'warn' | 'risk';
const SEVERITIES: readonly Severity[] = ['info', 'warn', 'risk'];

export interface InspectItem {
  [key: string]: string | number | boolean | null;
}

export interface Finding {
  category: InspectCategory;
  severity: Severity;
  count: number;
  items: InspectItem[];
  fixAvailable: boolean;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(INSPECT_CATEGORIES);

function readItem(raw: unknown): InspectItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: InspectItem = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  return out;
}

/** Validates the findings of inspect.hiddenData. Unknown categories are dropped. */
export function readFindings(data: unknown): Finding[] {
  const list = (data as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  const out: Finding[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.category !== 'string' || !CATEGORY_SET.has(r.category)) continue;
    const severity = SEVERITIES.includes(r.severity as Severity)
      ? (r.severity as Severity)
      : 'info';
    const items = Array.isArray(r.items)
      ? r.items.map(readItem).filter((i): i is InspectItem => i !== null)
      : [];
    const count = typeof r.count === 'number' && r.count >= 0 ? Math.floor(r.count) : items.length;
    out.push({
      category: r.category as InspectCategory,
      severity,
      count,
      items,
      fixAvailable: r.fixAvailable === true,
    });
  }
  return out;
}

/** Findings with something to show, most severe first. */
export function presentFindings(findings: Finding[]): Finding[] {
  const rank: Record<Severity, number> = { risk: 0, warn: 1, info: 2 };
  return findings.filter((f) => f.count > 0).sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Categories the user can remove now: present, and the core has a fix for them. */
export function removableOf(findings: Finding[]): InspectCategory[] {
  return findings
    .filter((f) => f.count > 0 && f.fixAvailable && REMOVABLE.has(f.category))
    .map((f) => f.category);
}

/** Params of inspect.removeHidden; only removable categories, no duplicates. */
export function removeParams(selected: readonly string[]): InspectRemoveHiddenParams {
  const unique = [...new Set(selected)].filter((c) => REMOVABLE.has(c)) as RemovableCategory[];
  return { categories: unique };
}

export interface RemoveSummary {
  removed: Partial<Record<InspectCategory, number>>;
  before: Partial<Record<InspectCategory, number>>;
  after: Partial<Record<InspectCategory, number>>;
  /** Total items before and after across the categories. */
  totalBefore: number;
  totalAfter: number;
}

function readCounts(v: unknown): Partial<Record<InspectCategory, number>> {
  const out: Partial<Record<InspectCategory, number>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v)) {
    if (CATEGORY_SET.has(k) && typeof n === 'number') out[k as InspectCategory] = n;
  }
  return out;
}

/** Reads the data of inspect.removeHidden: what was removed and the counts before / after. */
export function readRemoveSummary(data: unknown): RemoveSummary {
  const d = (data ?? {}) as Record<string, unknown>;
  const before = readCounts(d.before);
  const after = readCounts(d.after);
  const sum = (c: Partial<Record<InspectCategory, number>>) =>
    Object.values(c).reduce<number>((a, n) => a + (n ?? 0), 0);
  return {
    removed: readCounts(d.removed),
    before,
    after,
    totalBefore: sum(before),
    totalAfter: sum(after),
  };
}

/** Human-readable line for one finding item (keys from the core: where, key, name, page...). */
export function itemText(
  item: InspectItem,
  tr: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (typeof item.page === 'number') parts.push(tr('inspect.item.page', { page: item.page }));
  if (typeof item.where === 'string') parts.push(item.where);
  if (typeof item.key === 'string') parts.push(item.key);
  if (typeof item.name === 'string') parts.push(item.name);
  if (typeof item.value === 'string' && item.value) parts.push(`= ${item.value}`);
  if (typeof item.file === 'string' && item.file) parts.push(item.file);
  if (typeof item.subtype === 'string') parts.push(item.subtype);
  if (typeof item.chars === 'number') parts.push(tr('inspect.item.chars', { count: item.chars }));
  return parts.length > 0 ? parts.join(' · ') : '—';
}
