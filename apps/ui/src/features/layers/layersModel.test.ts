import { describe, expect, it } from 'vitest';
import { existingLayerIds, layerTotals, toggleKind, type LayerInfo } from './layersModel';

const layer = (id: string, extra: Partial<LayerInfo> = {}): LayerInfo => ({
  id,
  name: id,
  intent: ['View'],
  usage: [],
  visible: true,
  locked: false,
  objectCount: 0,
  pageCount: 0,
  pages: [],
  ...extra,
});

describe('view-by-type filter', () => {
  it('adds and removes kinds; empty means off', () => {
    expect(toggleKind(null, 'text')).toEqual(['text']);
    expect(toggleKind(['text'], 'image')).toEqual(['text', 'image']);
    expect(toggleKind(['text', 'image'], 'text')).toEqual(['image']);
    expect(toggleKind(['text'], 'text')).toBeNull();
  });
});

describe('layers', () => {
  it('totals hidden, locked and object counts', () => {
    const totals = layerTotals([
      layer('a', { visible: false, objectCount: 4 }),
      layer('b', { locked: true, objectCount: 2 }),
      layer('c'),
    ]);
    expect(totals).toEqual({ layers: 3, hidden: 1, locked: 1, objects: 6 });
  });

  it('keeps only ids of known layers', () => {
    expect(existingLayerIds([layer('a'), layer('b')], ['b', 'zz'])).toEqual(['b']);
  });
});
