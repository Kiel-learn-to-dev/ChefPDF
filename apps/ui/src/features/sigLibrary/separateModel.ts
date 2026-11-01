/**
 * Colour separation of a library item (I22): the two automatic ink colours or a custom list of
 * colour layers. Pure: the forms, their checks and the core params. Each kept layer is saved as a
 * new library item named "<item> - <layer>".
 */
import type { ImageSeparateColorsParams, SeparationLayer } from '@chef/contracts';
import { NAME_MAX, itemName } from './libraryModel';

export const MAX_LAYERS = 8;
export const MAX_LAYER_NAME = 60;
export const DEFAULT_TOLERANCE = 60;
const HEX = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#D32F2F', '#1F3A93', '#2E7D32', '#F9A825', '#6A1B9A', '#00838F', '#5D4037'];

export type SeparateMode = 'auto-two' | 'custom';

export interface LayerForm {
  name: string;
  colorHex: string;
  tolerance: number;
}

export type LayerProblem = 'empty' | 'tooMany' | 'name' | 'color' | 'tolerance';

/** Two starting layers for the custom mode: a red seal and a blue signature. */
export function defaultLayers(): LayerForm[] {
  return [
    { name: 'Con dấu', colorHex: '#D32F2F', tolerance: DEFAULT_TOLERANCE },
    { name: 'Chữ ký', colorHex: '#1F3A93', tolerance: DEFAULT_TOLERANCE },
  ];
}

/** The first problem with the custom layers, or null when they can be sent to the core. */
export function layerProblem(layers: readonly LayerForm[]): LayerProblem | null {
  if (layers.length === 0) return 'empty';
  if (layers.length > MAX_LAYERS) return 'tooMany';
  for (const l of layers) {
    const name = l.name.trim();
    if (name.length === 0 || name.length > MAX_LAYER_NAME) return 'name';
    if (!HEX.test(l.colorHex)) return 'color';
    if (!Number.isInteger(l.tolerance) || l.tolerance < 0 || l.tolerance > 255) {
      return 'tolerance';
    }
  }
  return null;
}

/** Params of image.separateColors for the chosen mode. Only the mode's own fields are set. */
export function separateParams(
  inputPath: string,
  outputDir: string,
  mode: SeparateMode,
  layers: readonly LayerForm[],
): ImageSeparateColorsParams {
  if (mode === 'auto-two') return { inputPath, outputDir, mode: 'auto-two' };
  const wire: SeparationLayer[] = layers.map((l) => ({
    name: l.name.trim(),
    colorHex: l.colorHex.toUpperCase() as SeparationLayer['colorHex'],
    tolerance: l.tolerance,
  }));
  return { inputPath, outputDir, mode: 'layers', layers: wire };
}

/**
 * Name of the library item made from one layer. The item name keeps its start and the layer
 * name its end, so the whole name fits the library limit. `fallback` is used for a blank item name.
 */
export function layerItemName(base: string, layer: string, fallback: string): string {
  const suffix = ` - ${layer.trim()}`;
  const room = NAME_MAX - suffix.length;
  const head = itemName(base, fallback);
  return `${head.slice(0, Math.max(room, 0))}${suffix}`.slice(0, NAME_MAX);
}

export interface LayerOutcome {
  name: string;
  path: string;
  pixels: number;
}

/** Layers that matched at least one pixel: only these become library items. */
export function keptLayers(outcomes: readonly LayerOutcome[]): LayerOutcome[] {
  return outcomes.filter((o) => o.pixels > 0);
}

/** Reads the core's data.layers rows. Malformed rows are skipped. */
export function parseLayerRows(data: unknown): LayerOutcome[] {
  const rows = (data as { layers?: unknown } | null)?.layers;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const row = r as Partial<LayerOutcome> | null;
    if (!row || typeof row.name !== 'string' || typeof row.path !== 'string') return [];
    return [{ name: row.name, path: row.path, pixels: Number(row.pixels) || 0 }];
  });
}

/** Adds a layer with the next colour of a fixed palette; never more than MAX_LAYERS. */
export function addLayer(layers: readonly LayerForm[], name: string): LayerForm[] {
  if (layers.length >= MAX_LAYERS) return [...layers];
  const colorHex = PALETTE[layers.length % PALETTE.length]!;
  return [...layers, { name, colorHex, tolerance: DEFAULT_TOLERANCE }];
}

export function removeLayer(layers: readonly LayerForm[], index: number): LayerForm[] {
  return layers.filter((_, i) => i !== index);
}
