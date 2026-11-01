import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPLACE_FORM,
  replaceIssues,
  replaceParams,
  type ReplaceForm,
} from './replaceModel';

const form = (patch: Partial<ReplaceForm> = {}): ReplaceForm => ({
  ...DEFAULT_REPLACE_FORM,
  sourcePath: '/docs/new.pdf',
  sourceCount: 4,
  ...patch,
});

describe('replaceIssues', () => {
  it('needs target pages inside the document and a source file', () => {
    expect(replaceIssues(form({ targetText: '1-2' }), 5)).toEqual([]);
    expect(replaceIssues(form({ targetText: '' }), 5)).toEqual(['target']);
    expect(replaceIssues(form({ targetText: '7' }), 5)).toEqual(['target']);
    expect(replaceIssues(form({ targetText: '1', sourcePath: '' }), 5)).toEqual(['source']);
  });

  it('checks the source range against the source page count', () => {
    expect(replaceIssues(form({ targetText: '1', sourceText: '2-3' }), 5)).toEqual([]);
    expect(replaceIssues(form({ targetText: '1', sourceText: '5' }), 5)).toEqual(['sourcePages']);
  });
});

describe('replaceParams', () => {
  it('sends 0-based target pages and omits the source range when empty', () => {
    expect(replaceParams(form({ targetText: '2,4' }), 5)).toEqual({
      pages: [1, 3],
      path: '/docs/new.pdf',
    });
  });

  it('sends the source range and password when given', () => {
    expect(
      replaceParams(form({ targetText: '1', sourceText: '3-4', sourcePassword: 'x' }), 5),
    ).toEqual({ pages: [0], path: '/docs/new.pdf', password: 'x', sourcePages: [2, 3] });
  });
});
