import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLOR_FORM,
  colorIssues,
  colorParams,
  normalizeHex,
  readColorReport,
  type ColorForm,
} from './colorModel';

const form = (patch: Partial<ColorForm> = {}): ColorForm => ({ ...DEFAULT_COLOR_FORM, ...patch });

describe('normalizeHex', () => {
  it('accepts #rrggbb in any case and returns it lower-case', () => {
    expect(normalizeHex(' #FF8800 ')).toBe('#ff8800');
  });
  it('rejects short forms and non-hex text', () => {
    expect(normalizeHex('#fff')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#gg0000')).toBeNull();
  });
});

describe('colorIssues', () => {
  it('is clean for the defaults', () => {
    expect(colorIssues(DEFAULT_COLOR_FORM, 5)).toEqual([]);
  });

  it('flags a page selector that is empty or out of range', () => {
    expect(colorIssues(form({ scope: 'pages', pagesText: '' }), 5)).toEqual(['pages']);
    expect(colorIssues(form({ scope: 'pages', pagesText: '9' }), 5)).toEqual(['pages']);
    expect(colorIssues(form({ scope: 'pages', pagesText: '1-3' }), 5)).toEqual([]);
  });

  it('checks the threshold only for black and white', () => {
    expect(colorIssues(form({ mode: 'blackwhite', threshold: 300 }), 5)).toEqual(['threshold']);
    expect(colorIssues(form({ mode: 'gray', threshold: 300 }), 5)).toEqual([]);
  });

  it('checks the ink amount in 0..1', () => {
    expect(colorIssues(form({ mode: 'ink-saver', amount: 1.5 }), 5)).toEqual(['amount']);
    expect(colorIssues(form({ mode: 'ink-saver', amount: 0.8 }), 5)).toEqual([]);
  });

  it('checks both colours and the tolerance for replace-colour', () => {
    expect(
      colorIssues(form({ mode: 'replace-color', sourceColor: 'x', targetColor: '#00ff00' }), 5),
    ).toEqual(['sourceColor']);
    expect(colorIssues(form({ mode: 'replace-color', tolerance: -1 }), 5)).toEqual(['tolerance']);
  });
});

describe('colorParams', () => {
  it('sends only the fields of the chosen mode, with pages as 0-based indices', () => {
    expect(colorParams(form({ mode: 'gray' }), 5)).toEqual({ mode: 'gray' });
    expect(colorParams(form({ mode: 'gray', scope: 'pages', pagesText: '2,4-5' }), 5)).toEqual({
      mode: 'gray',
      pages: [1, 3, 4],
    });
  });

  it('builds the black-and-white and ink-saver params', () => {
    expect(colorParams(form({ mode: 'blackwhite', threshold: 150, dithering: true }), 5)).toEqual({
      mode: 'blackwhite',
      threshold: 150,
      dithering: true,
    });
    expect(colorParams(form({ mode: 'ink-saver', amount: 0.3 }), 5)).toEqual({
      mode: 'ink-saver',
      amount: 0.3,
    });
  });

  it('builds the replace-colour params with normalised colours', () => {
    expect(
      colorParams(
        form({
          mode: 'replace-color',
          sourceColor: '#FF0000',
          targetColor: '#00FF00',
          tolerance: 30,
        }),
        5,
      ),
    ).toEqual({
      mode: 'replace-color',
      sourceColor: '#ff0000',
      targetColor: '#00ff00',
      tolerance: 30,
    });
  });
});

describe('readColorReport', () => {
  it('reads the counts and the kept reasons, sorted by reason', () => {
    const r = readColorReport({
      coloursChanged: 12,
      imagesChanged: 2,
      pagesChanged: 3,
      kept: { shading: 1, pattern: 4, nothing: 0 },
    });
    expect(r).toEqual({
      coloursChanged: 12,
      imagesChanged: 2,
      pagesChanged: 3,
      kept: [
        { reason: 'pattern', count: 4 },
        { reason: 'shading', count: 1 },
      ],
    });
  });

  it('treats a missing payload as nothing changed', () => {
    const r = readColorReport(undefined);
    expect(r.coloursChanged + r.imagesChanged + r.pagesChanged).toBe(0);
    expect(r.kept).toEqual([]);
  });
});
