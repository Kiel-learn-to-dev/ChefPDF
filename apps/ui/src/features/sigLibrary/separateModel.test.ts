import { describe, expect, it } from 'vitest';
import {
  MAX_LAYERS,
  addLayer,
  defaultLayers,
  keptLayers,
  layerItemName,
  layerProblem,
  parseLayerRows,
  removeLayer,
  separateParams,
} from './separateModel';

describe('separateParams', () => {
  it('auto-two sends no layers', () => {
    expect(separateParams('/w/a.png', '/w', 'auto-two', defaultLayers())).toEqual({
      inputPath: '/w/a.png',
      outputDir: '/w',
      mode: 'auto-two',
    });
  });

  it('custom mode sends trimmed names and upper-case colours', () => {
    const p = separateParams('/w/a.png', '/w', 'custom', [
      { name: ' Con dấu ', colorHex: '#d32f2f', tolerance: 40 },
    ]);
    expect(p).toEqual({
      inputPath: '/w/a.png',
      outputDir: '/w',
      mode: 'layers',
      layers: [{ name: 'Con dấu', colorHex: '#D32F2F', tolerance: 40 }],
    });
  });
});

describe('layerProblem', () => {
  it('accepts the defaults', () => {
    expect(layerProblem(defaultLayers())).toBeNull();
  });

  it('rejects an empty list, too many layers, bad names, colours and tolerances', () => {
    expect(layerProblem([])).toBe('empty');
    const many = Array.from({ length: MAX_LAYERS + 1 }, (_, i) => ({
      name: `L${i}`,
      colorHex: '#000000',
      tolerance: 60,
    }));
    expect(layerProblem(many)).toBe('tooMany');
    expect(layerProblem([{ name: '  ', colorHex: '#000000', tolerance: 60 }])).toBe('name');
    expect(layerProblem([{ name: 'x', colorHex: 'red', tolerance: 60 }])).toBe('color');
    expect(layerProblem([{ name: 'x', colorHex: '#000000', tolerance: 256 }])).toBe('tolerance');
    expect(layerProblem([{ name: 'x', colorHex: '#000000', tolerance: 1.5 }])).toBe('tolerance');
  });
});

describe('layerItemName', () => {
  it('appends the layer name to the item name', () => {
    expect(layerItemName('Con dấu Acme', 'Chữ ký', 'Mục')).toBe('Con dấu Acme - Chữ ký');
  });

  it('keeps the whole name within the library limit', () => {
    const name = layerItemName('a'.repeat(80), 'Chữ ký', 'Mục');
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith(' - Chữ ký')).toBe(true);
  });

  it('uses the fallback for a blank item name', () => {
    expect(layerItemName('   ', 'Con dấu', 'Mục')).toBe('Mục - Con dấu');
  });
});

describe('results', () => {
  it('keeps only layers with pixels', () => {
    const rows = [
      { name: 'A', path: '/w/a.png', pixels: 12 },
      { name: 'B', path: '/w/b.png', pixels: 0 },
    ];
    expect(keptLayers(rows)).toEqual([rows[0]]);
  });

  it('parses the core rows and skips malformed ones', () => {
    const data = {
      layers: [
        { name: 'Con dấu', path: '/w/1.png', pixels: 9 },
        { name: 3, path: '/w/2.png', pixels: 1 },
        null,
      ],
    };
    expect(parseLayerRows(data)).toEqual([{ name: 'Con dấu', path: '/w/1.png', pixels: 9 }]);
    expect(parseLayerRows(undefined)).toEqual([]);
  });
});

describe('add and remove layers', () => {
  it('adds a layer with a new colour until the limit', () => {
    let layers = defaultLayers();
    layers = addLayer(layers, 'Lớp 3');
    expect(layers).toHaveLength(3);
    expect(layers[2]!.name).toBe('Lớp 3');
    // addLayer stops at MAX_LAYERS, so ask for more than the limit with a bounded loop
    for (let i = 0; i < MAX_LAYERS + 2; i += 1) layers = addLayer(layers, 'Lớp');
    expect(layers).toHaveLength(MAX_LAYERS);
  });

  it('removes one layer by index', () => {
    expect(removeLayer(defaultLayers(), 0).map((l) => l.name)).toEqual(['Chữ ký']);
  });
});
