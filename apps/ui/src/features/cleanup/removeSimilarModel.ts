/**
 * "Gỡ đối tượng giống thế này" (E4): the object under a clicked point (content.hitTest), the
 * content.removeSimilar params and the matches list. Pure.
 */
import type { ContentRemoveSimilarParams } from '@chef/contracts';

export type SimilarScope = 'all' | 'others';

export const DEFAULT_TOLERANCE_MM = 2;
export const MAX_TOLERANCE_MM = 20;

export interface PickedObject {
  id: string;
  pageIndex: number;
  kind: string;
  /** Display frame [x1, y1, x2, y2], points, origin top-left. */
  bbox: number[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** The first object of a content.hitTest result, or null when the point is on no object. */
export function readPickedObject(data: unknown): PickedObject | null {
  if (!isRecord(data) || !isRecord(data.object)) return null;
  const o = data.object;
  if (typeof o.id !== 'string') return null;
  return {
    id: o.id,
    pageIndex: typeof o.pageIndex === 'number' ? o.pageIndex : 0,
    kind: typeof o.kind === 'string' ? o.kind : 'unknown',
    bbox: Array.isArray(o.bbox) ? o.bbox.map(Number) : [],
  };
}

export function clampTolerance(mm: number): number {
  if (!Number.isFinite(mm)) return DEFAULT_TOLERANCE_MM;
  return Math.min(MAX_TOLERANCE_MM, Math.max(0, mm));
}

/** content.removeSimilar params (dryRun true lists the matches only). */
export function similarParams(
  picked: Pick<PickedObject, 'id' | 'pageIndex'>,
  scope: SimilarScope,
  toleranceMm: number,
  dryRun: boolean,
): ContentRemoveSimilarParams {
  return {
    pageIndex: picked.pageIndex,
    objectId: picked.id,
    scope,
    toleranceMm: clampTolerance(toleranceMm),
    dryRun,
  };
}

export interface SimilarMatch {
  id: string;
  pageIndex: number;
  bbox: number[];
}

export interface SimilarResult {
  dryRun: boolean;
  matches: SimilarMatch[];
  removedObjects: number;
}

/** A content.removeSimilar result. */
export function readSimilarResult(data: unknown): SimilarResult {
  const d = isRecord(data) ? data : {};
  const matches = Array.isArray(d.matches)
    ? d.matches.filter(isRecord).map((m) => ({
        id: typeof m.id === 'string' ? m.id : '',
        pageIndex: typeof m.pageIndex === 'number' ? m.pageIndex : 0,
        bbox: Array.isArray(m.bbox) ? m.bbox.map(Number) : [],
      }))
    : [];
  return {
    dryRun: d.dryRun !== false,
    matches,
    removedObjects: typeof d.removedObjects === 'number' ? d.removedObjects : 0,
  };
}

/** Pages with matches and their counts, in page order: for the list of the preview. */
export function matchesPerPage(
  matches: readonly SimilarMatch[],
): { pageIndex: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const m of matches) counts.set(m.pageIndex, (counts.get(m.pageIndex) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageIndex, count]) => ({ pageIndex, count }));
}
