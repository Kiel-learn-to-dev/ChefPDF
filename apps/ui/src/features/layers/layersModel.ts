/**
 * Layers panel (E1) and the view-by-type filter (E2): pure helpers. The layer list is the result
 * of layers.list (optional-content groups of the document).
 */
import type { ObjectKind } from '../objects/objectModel';

export interface LayerInfo {
  id: string;
  name: string;
  intent: string[];
  usage: string[];
  visible: boolean;
  locked: boolean;
  objectCount: number;
  pageCount: number;
  pages: number[];
}

export interface LayersData {
  baseState: string | null;
  layers: LayerInfo[];
  order: unknown[];
}

/** The kinds of the filter chips, in display order. */
export const FILTER_KINDS: readonly ObjectKind[] = ['text', 'image', 'path', 'shading'];

/** Adds the kind when it is off, removes it when it is on. An empty list turns the filter off. */
export function toggleKind(
  kinds: readonly ObjectKind[] | null,
  kind: ObjectKind,
): ObjectKind[] | null {
  const current = kinds ?? [];
  const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
  return next.length === 0 ? null : next;
}

export interface LayerTotals {
  layers: number;
  hidden: number;
  locked: number;
  objects: number;
}

export function layerTotals(layers: readonly LayerInfo[]): LayerTotals {
  return {
    layers: layers.length,
    hidden: layers.filter((l) => !l.visible).length,
    locked: layers.filter((l) => l.locked).length,
    objects: layers.reduce((n, l) => n + l.objectCount, 0),
  };
}

/** The layers that a bulk action (remove, flatten) names; unknown ids are dropped. */
export function existingLayerIds(
  layers: readonly LayerInfo[],
  wanted: readonly string[],
): string[] {
  const known = new Set(layers.map((l) => l.id));
  return wanted.filter((id) => known.has(id));
}
