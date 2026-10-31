/**
 * Driver list of the token section (T3.02): sorting and probe summary. Pure.
 */
import type { DriverConfidence, DriverProbe, DriverRow } from '@chef/contracts';

const CONFIDENCE_RANK: Record<DriverConfidence, number> = {
  documented: 0,
  reported: 1,
  unverified: 2,
};

/**
 * Drivers found on this computer come first, then the more trusted entries (documented before
 * reported before unverified), then CA name, model and path. Does not mutate the input.
 */
export function sortDrivers(rows: readonly DriverRow[]): DriverRow[] {
  return [...rows].sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    const conf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (conf !== 0) return conf;
    return (
      a.ca.localeCompare(b.ca, 'vi') ||
      a.model.localeCompare(b.model, 'vi') ||
      a.path.localeCompare(b.path)
    );
  });
}

export type ProbeSummary =
  | { kind: 'none' }
  | { kind: 'labels'; labels: string[] }
  | { kind: 'error'; errorKind: string | null; reason: string | null };

/** What a probed driver reported: token labels, a load error, or nothing (not probed). */
export function probeSummary(probe: DriverProbe | undefined): ProbeSummary {
  if (!probe) return { kind: 'none' };
  if (probe.status === 'ok') return { kind: 'labels', labels: probe.tokenLabels };
  return { kind: 'error', errorKind: probe.errorKind, reason: probe.reason };
}

/** A driver row is selectable only when its file exists on this computer. */
export function isSelectable(row: DriverRow): boolean {
  return row.exists;
}
