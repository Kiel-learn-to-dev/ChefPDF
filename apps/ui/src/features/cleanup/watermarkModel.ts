/**
 * Watermark candidates (E3): reading the watermark.detect result, ranking, the default checks and
 * the watermark.remove params. Pure. The core never removes anything on detect; the UI only
 * removes what the user checked.
 */
import type { WatermarkRemoveParams } from '@chef/contracts';
import { scopeFieldsOf, type CleanupScope } from './scope';

export interface WatermarkCandidate {
  id: string;
  kind: string;
  tier: number;
  /** 0..1. */
  confidence: number;
  pages: number[];
  count: number;
  sample: { pageIndex: number; bbox: number[] } | null;
  description: { vi: string; en: string };
  evidence: string[];
  preview: { pageIndex: number; bboxes: number[][] }[];
}

/** Candidates at or above this confidence start checked. */
export const HIGH_CONFIDENCE = 0.8;

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= HIGH_CONFIDENCE) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

function readOne(raw: unknown): WatermarkCandidate | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.confidence !== 'number') {
    return null;
  }
  const desc = isRecord(raw.description) ? raw.description : {};
  const sample = isRecord(raw.sample)
    ? { pageIndex: Number(raw.sample.pageIndex), bbox: numbers(raw.sample.bbox) }
    : null;
  const preview = Array.isArray(raw.preview)
    ? raw.preview.filter(isRecord).map((p) => ({
        pageIndex: Number(p.pageIndex),
        bboxes: Array.isArray(p.bboxes) ? p.bboxes.map(numbers) : [],
      }))
    : [];
  return {
    id: raw.id,
    kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
    tier: typeof raw.tier === 'number' ? raw.tier : 4,
    confidence: raw.confidence,
    pages: numbers(raw.pages),
    count: typeof raw.count === 'number' ? raw.count : 0,
    sample,
    description: {
      vi: typeof desc.vi === 'string' ? desc.vi : '',
      en: typeof desc.en === 'string' ? desc.en : '',
    },
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.filter((x): x is string => typeof x === 'string')
      : [],
    preview,
  };
}

/** Candidates of a watermark.detect result; malformed entries are skipped. */
export function readCandidates(data: unknown): WatermarkCandidate[] {
  if (!isRecord(data) || !Array.isArray(data.candidates)) return [];
  return data.candidates.map(readOne).filter((c): c is WatermarkCandidate => c !== null);
}

/** Most confident first; for equal confidence the stronger tier (lower number) first. */
export function rankCandidates(list: readonly WatermarkCandidate[]): WatermarkCandidate[] {
  return [...list].sort(
    (a, b) => b.confidence - a.confidence || a.tier - b.tier || a.id.localeCompare(b.id),
  );
}

/** Ids checked when the list opens: every candidate at or above HIGH_CONFIDENCE. */
export function defaultChecked(list: readonly WatermarkCandidate[]): string[] {
  return list.filter((c) => c.confidence >= HIGH_CONFIDENCE).map((c) => c.id);
}

/** Boxes of a candidate on one page (display frame, points, origin top-left). */
export function candidateBoxes(c: WatermarkCandidate, pageIndex: number): number[][] {
  return c.preview.find((p) => p.pageIndex === pageIndex)?.bboxes ?? [];
}

/** The page the viewer jumps to when a candidate is clicked. */
export function samplePage(c: WatermarkCandidate): number | null {
  if (c.sample && Number.isInteger(c.sample.pageIndex)) return c.sample.pageIndex;
  return c.pages[0] ?? null;
}

/**
 * watermark.remove params for the checked candidates. Null when nothing is checked or the page
 * scope is not valid (the core refuses an empty selection).
 */
export function watermarkRemoveParams(
  checked: readonly string[],
  scope: CleanupScope,
  pageCount: number,
): WatermarkRemoveParams | null {
  if (checked.length === 0) return null;
  const fields = scopeFieldsOf(scope, pageCount);
  if (!fields) return null;
  return { candidateIds: [...new Set(checked)], ...fields };
}

export interface WatermarkRemoveResult {
  removedObjects: number;
  removedAnnotations: number;
  removedOverlays: number;
  removedLayers: number;
}

/** Counts of a watermark.remove result (zero for anything missing). */
export function readRemoveResult(data: unknown): WatermarkRemoveResult {
  const d = isRecord(data) ? data : {};
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  return {
    removedObjects: n('removedObjects'),
    removedAnnotations: n('removedAnnotations'),
    removedOverlays: n('removedOverlays'),
    removedLayers: n('removedLayers'),
  };
}

export function removedTotal(r: WatermarkRemoveResult): number {
  return r.removedObjects + r.removedAnnotations + r.removedOverlays + r.removedLayers;
}
