import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINK_FORM,
  addLinkParams,
  autoDetectParams,
  dragRect,
  formOf,
  groupLinksByPage,
  isLinkSized,
  linkTargetText,
  normalizeUri,
  updateLinkParams,
  validateLinkForm,
  type LinkItem,
} from './linksModel';

const link = (over: Partial<LinkItem>): LinkItem => ({
  id: 'K0:abc:0',
  pageIndex: 0,
  kind: 'uri',
  target: 'https://example.com',
  view: 'fit',
  left: null,
  top: null,
  rect: [10, 10, 80, 22],
  borderWidth: 0,
  color: null,
  highlight: 'invert',
  ...over,
});

describe('normalizeUri', () => {
  it('keeps text that already has a scheme', () => {
    expect(normalizeUri('https://chef.vn/a')).toBe('https://chef.vn/a');
    expect(normalizeUri('mailto:a@b.vn')).toBe('mailto:a@b.vn');
  });

  it('adds mailto: to an e-mail address and https:// to a host', () => {
    expect(normalizeUri(' hr@congty.vn ')).toBe('mailto:hr@congty.vn');
    expect(normalizeUri('congty.vn/lien-he')).toBe('https://congty.vn/lien-he');
    expect(normalizeUri('   ')).toBe('');
  });
});

describe('validateLinkForm', () => {
  it('needs a URI for a web link and a valid page for a page link', () => {
    expect(validateLinkForm(DEFAULT_LINK_FORM, 4)).toBe('URI_REQUIRED');
    expect(validateLinkForm({ ...DEFAULT_LINK_FORM, uri: 'x.vn' }, 4)).toBeNull();
    const page = { ...DEFAULT_LINK_FORM, kind: 'page' as const };
    expect(validateLinkForm({ ...page, targetPage: '5' }, 4)).toBe('PAGE_INVALID');
    expect(validateLinkForm({ ...page, targetPage: 'x' }, 4)).toBe('PAGE_INVALID');
    expect(validateLinkForm({ ...page, targetPage: '4' }, 4)).toBeNull();
  });

  it('checks the colour', () => {
    expect(validateLinkForm({ ...DEFAULT_LINK_FORM, uri: 'x.vn', color: 'red' }, 4)).toBe(
      'COLOUR_INVALID',
    );
  });
});

describe('addLinkParams and updateLinkParams', () => {
  it('builds a URI link with the normalised address', () => {
    expect(addLinkParams(2, [1, 2, 3, 4], { ...DEFAULT_LINK_FORM, uri: 'congty.vn' })).toEqual({
      pageIndex: 2,
      rect: [1, 2, 3, 4],
      kind: 'uri',
      borderWidth: 0,
      color: '#0000ff',
      highlight: 'invert',
      uri: 'https://congty.vn',
    });
  });

  it('builds a page link with a 0-based target and the view', () => {
    const p = addLinkParams(0, [0, 0, 5, 5], {
      ...DEFAULT_LINK_FORM,
      kind: 'page',
      targetPage: '3',
      view: 'xyz',
    });
    expect(p).toMatchObject({ kind: 'page', targetPage: 2, view: 'xyz' });
    expect(p.uri).toBeUndefined();
  });

  it('updates the target and the look of a link', () => {
    expect(
      updateLinkParams('K1', { ...DEFAULT_LINK_FORM, uri: 'a.vn', borderWidth: 1 }),
    ).toMatchObject({ id: 'K1', uri: 'https://a.vn', borderWidth: 1 });
  });
});

describe('formOf', () => {
  it('reads a page link back as a 1-based page', () => {
    const f = formOf(link({ kind: 'page', target: '4', view: 'xyz', highlight: 'outline' }));
    expect(f).toMatchObject({ kind: 'page', targetPage: '5', view: 'xyz', highlight: 'outline' });
  });

  it('reads a URI link back with its address', () => {
    expect(formOf(link({ target: 'https://x.vn' })).uri).toBe('https://x.vn');
  });
});

describe('dragRect and isLinkSized', () => {
  it('normalises a drag in any direction', () => {
    expect(dragRect({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual([10, 5, 50, 40]);
  });

  it('treats tiny drags as clicks', () => {
    expect(isLinkSized([0, 0, 2, 20])).toBe(false);
    expect(isLinkSized([0, 0, 20, 20])).toBe(true);
  });
});

describe('groupLinksByPage and linkTargetText', () => {
  it('groups links by page in page order', () => {
    const groups = groupLinksByPage([
      link({ id: 'a', pageIndex: 3 }),
      link({ id: 'b', pageIndex: 1 }),
      link({ id: 'c', pageIndex: 3 }),
    ]);
    expect(groups.map((g) => [g.pageIndex, g.links.length])).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it('shows the page of a page link 1-based', () => {
    expect(linkTargetText(link({ kind: 'page', target: '0' }))).toEqual({
      kind: 'page',
      text: '1',
    });
    expect(linkTargetText(link({ kind: 'uri', target: 'https://a.vn' }))).toEqual({
      kind: 'uri',
      text: 'https://a.vn',
    });
  });
});

describe('autoDetectParams', () => {
  it('detects on every page unless pages are given, and keeps existing links', () => {
    expect(autoDetectParams()).toEqual({ skipExisting: true });
    expect(autoDetectParams([0, 2])).toEqual({ pages: [0, 2], skipExisting: true });
  });
});
