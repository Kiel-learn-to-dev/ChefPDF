import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  buildThread,
  exportParams,
  filterAnnots,
  flattenParams,
  groupAnnotsByPage,
  inkParams,
  kindsOf,
  quotedText,
  selectionRectsByPage,
  shapeParams,
  simplify,
  textMarkupParams,
  noteParams,
  type AnnotItem,
  type PageSpot,
} from './annotModel';

const item = (over: Partial<AnnotItem> & { id: string }): AnnotItem => ({
  pageIndex: 0,
  subtype: 'Text',
  rect: [0, 0, 20, 20],
  contents: '',
  author: 'An',
  modified: null,
  colour: null,
  opacity: 1,
  replies: [],
  inReplyTo: null,
  status: null,
  quads: [],
  icon: 'Note',
  ...over,
});

describe('selectionRectsByPage', () => {
  const pages: PageSpot[] = [
    { index: 0, left: 0, top: 0, width: 400, height: 500, scale: 2 },
    { index: 1, left: 0, top: 520, width: 400, height: 500, scale: 2 },
  ];

  it('converts client rects to displayed points of the page holding them', () => {
    const out = selectionRectsByPage(
      [
        { left: 20, top: 40, right: 120, bottom: 60 },
        { left: 20, top: 560, right: 60, bottom: 580 },
      ],
      pages,
      { left: 0, top: 0 },
    );
    expect(out).toEqual([
      { pageIndex: 0, rects: [[10, 20, 60, 30]] },
      { pageIndex: 1, rects: [[10, 20, 30, 30]] },
    ]);
  });

  it('drops rects outside the pages and empty rects', () => {
    const out = selectionRectsByPage(
      [
        { left: 900, top: 900, right: 950, bottom: 920 },
        { left: 10, top: 10, right: 10, bottom: 20 },
      ],
      pages,
      { left: 0, top: 0 },
    );
    expect(out).toEqual([]);
  });
});

describe('add params', () => {
  it('builds text markup with the selected text as contents', () => {
    expect(
      textMarkupParams(2, 'highlight', [[1, 2, 3, 4]], {
        color: '#FFE14D',
        opacity: 0.5,
        contents: 'Điều khoản thanh toán',
        author: 'An',
      }),
    ).toEqual({
      pageIndex: 2,
      kind: 'highlight',
      rects: [[1, 2, 3, 4]],
      color: '#FFE14D',
      opacity: 0.5,
      contents: 'Điều khoản thanh toán',
      author: 'An',
    });
  });

  it('builds a note at a point with the icon', () => {
    const p = noteParams(0, { x: 10.04, y: 20 }, 'Xem lại', {
      author: 'An',
      icon: 'Comment',
      color: '#000000',
    });
    expect(p).toMatchObject({ left: 10.04, top: 20, contents: 'Xem lại', icon: 'Comment' });
  });

  it('builds a line from two points and a rect from a drag in any direction', () => {
    expect(
      shapeParams(
        0,
        'arrow',
        { x: 5, y: 9 },
        { x: 50, y: 60 },
        { author: 'An', color: '#f00', width: 1.5 },
      ),
    ).toMatchObject({
      points: [5, 9, 50, 60],
    });
    expect(
      shapeParams(
        0,
        'rect',
        { x: 50, y: 60 },
        { x: 5, y: 9 },
        { author: 'An', color: '#f00', width: 1.5, fill: '#0f0' },
      ),
    ).toMatchObject({
      rect: [5, 9, 50, 60],
      fill: '#0f0',
    });
  });

  it('smooths ink strokes and drops strokes of one point', () => {
    const line = [0, 1, 2, 3, 4].map((x) => ({ x, y: 0.1 * x }));
    const out = inkParams(0, [line, [{ x: 1, y: 1 }]], { author: 'An', color: '#00f', width: 2 });
    expect(out?.strokes).toEqual([
      [
        [0, 0],
        [4, 0.4],
      ],
    ]);
    expect(inkParams(0, [[{ x: 1, y: 1 }]], { author: 'An', color: '#00f', width: 2 })).toBeNull();
  });

  it('keeps the points that bend a stroke', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 10 },
      { x: 10, y: 0 },
    ];
    expect(simplify(pts, 1)).toHaveLength(3);
    expect(simplify(pts, 50)).toHaveLength(2);
  });
});

describe('list', () => {
  const items = [
    item({ id: 'a', pageIndex: 1, subtype: 'Highlight', contents: 'giá trọn gói', author: 'Bình' }),
    item({
      id: 'b',
      pageIndex: 0,
      subtype: 'Text',
      contents: 'Kiểm tra số liệu',
      author: 'An',
      status: 'accepted',
    }),
    item({
      id: 'c',
      pageIndex: 0,
      subtype: 'Text',
      contents: 'Đã sửa',
      author: 'Bình',
      inReplyTo: 'b',
    }),
    item({ id: 'd', pageIndex: 0, subtype: 'Ink', author: 'An' }),
  ];

  it('groups top-level annotations by page and hides the replies', () => {
    const groups = groupAnnotsByPage(items);
    expect(groups.map((g) => [g.pageIndex, g.items.map((i) => i.id)])).toEqual([
      [0, ['b', 'd']],
      [1, ['a']],
    ]);
  });

  it('filters by kind, author, status and text', () => {
    expect(filterAnnots(items, { ...EMPTY_FILTER, kinds: ['Highlight'] }).map((i) => i.id)).toEqual(
      ['a'],
    );
    expect(filterAnnots(items, { ...EMPTY_FILTER, author: 'bìn' }).map((i) => i.id)).toEqual([
      'a',
      'c',
    ]);
    expect(filterAnnots(items, { ...EMPTY_FILTER, status: 'accepted' }).map((i) => i.id)).toEqual([
      'b',
    ]);
    expect(filterAnnots(items, { ...EMPTY_FILTER, status: 'none' }).map((i) => i.id)).toEqual([
      'a',
      'c',
      'd',
    ]);
    expect(filterAnnots(items, { ...EMPTY_FILTER, query: 'SỐ LIỆU' }).map((i) => i.id)).toEqual([
      'b',
    ]);
  });

  it('builds a thread with the replies of a root', () => {
    const t = buildThread(items, 'b');
    expect(t?.root.id).toBe('b');
    expect(t?.replies.map((r) => r.id)).toEqual(['c']);
    expect(buildThread(items, 'zz')).toBeNull();
  });

  it('shows the quoted text only for markup', () => {
    expect(quotedText(items[0]!)).toBe('giá trọn gói');
    expect(quotedText(items[1]!)).toBe('');
    expect(kindsOf(items)).toEqual(['Highlight', 'Ink', 'Text']);
  });
});

describe('export and flatten params', () => {
  it('sends the format and the optional pages and kinds', () => {
    expect(exportParams('/tmp/a.csv', 'csv', [3, 1, 3], undefined)).toEqual({
      outputPath: '/tmp/a.csv',
      format: 'csv',
      pages: [1, 3],
    });
    expect(exportParams('/tmp/a.md', 'md', [], ['Text'])).toEqual({
      outputPath: '/tmp/a.md',
      format: 'md',
      kinds: ['Text'],
    });
  });

  it('keeps links and form fields unless told otherwise', () => {
    expect(flattenParams(undefined, undefined, { links: true, formFields: true })).toEqual({
      keepLinks: true,
      keepFormFields: true,
    });
    expect(flattenParams([2], ['Highlight'], { links: false, formFields: true })).toEqual({
      keepLinks: false,
      keepFormFields: true,
      pages: [2],
      kinds: ['Highlight'],
    });
  });
});
