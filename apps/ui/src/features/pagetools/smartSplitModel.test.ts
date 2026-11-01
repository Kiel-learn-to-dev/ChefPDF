import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMART_SPLIT_FORM,
  readSmartSplitResult,
  smartSplitIssues,
  smartSplitParams,
  type SmartSplitForm,
} from './smartSplitModel';

const form = (patch: Partial<SmartSplitForm> = {}): SmartSplitForm => ({
  ...DEFAULT_SMART_SPLIT_FORM,
  outputDir: '/out',
  ...patch,
});

describe('smartSplitIssues', () => {
  it('is clean for the blank-page mode with an output folder', () => {
    expect(smartSplitIssues(form())).toEqual([]);
  });

  it('needs an output folder and a template with a known variable', () => {
    expect(smartSplitIssues(form({ outputDir: '' }))).toEqual(['outputDir']);
    expect(smartSplitIssues(form({ nameTemplate: '' }))).toEqual(['nameTemplate']);
    expect(smartSplitIssues(form({ nameTemplate: '{nope}' }))).toEqual(['nameTemplate']);
  });

  it('needs a valid level and a valid pattern for the pattern mode', () => {
    expect(smartSplitIssues(form({ mode: 'bookmarkLevel', level: 0 }))).toEqual(['level']);
    expect(smartSplitIssues(form({ mode: 'pattern', pattern: '' }))).toEqual(['pattern']);
    expect(smartSplitIssues(form({ mode: 'pattern', pattern: '([' }))).toEqual(['pattern']);
    expect(smartSplitIssues(form({ mode: 'pattern', pattern: 'Chuong \\d+' }))).toEqual([]);
  });
});

describe('smartSplitParams', () => {
  it('sends only the fields of the chosen mode', () => {
    expect(smartSplitParams(form(), '/in.pdf')).toEqual({
      path: '/in.pdf',
      mode: 'blank',
      dropSeparatorPages: false,
      blankSensitivity: 0.5,
      outputDir: '/out',
      nameTemplate: '{name}_{index}',
    });
  });

  it('sends the level for bookmarks and the pattern with its case flag', () => {
    const p = smartSplitParams(form({ mode: 'bookmarkLevel', level: 2 }), '/in.pdf', 'pw');
    expect(p).toMatchObject({ mode: 'bookmarkLevel', level: 2, password: 'pw' });
    expect(p.pattern).toBeUndefined();
    expect(
      smartSplitParams(form({ mode: 'pattern', pattern: 'A', ignoreCase: false }), '/in.pdf'),
    ).toMatchObject({ mode: 'pattern', pattern: 'A', ignoreCase: false });
  });
});

describe('readSmartSplitResult', () => {
  it('reads the part count and the written files', () => {
    expect(readSmartSplitResult({ parts: 3 }, ['/out/a.pdf', '/out/b.pdf'])).toEqual({
      parts: 3,
      outputs: ['/out/a.pdf', '/out/b.pdf'],
    });
    expect(readSmartSplitResult(undefined, [])).toEqual({ parts: 0, outputs: [] });
  });
});
