import { describe, expect, it } from 'vitest';
import {
  addAfter,
  countNodes,
  findNode,
  flatten,
  fromWire,
  indent,
  moveDown,
  moveUp,
  newNode,
  outdent,
  removeNode,
  rename,
  setPage,
  setStyle,
  toWire,
  type EditNode,
} from './bookmarkTree';

/** A tree with readable ids, for the tests. */
function tree(): EditNode[] {
  return [
    {
      ...newNode('a', 'Chương 1', 0),
      children: [newNode('a1', 'Mục 1.1', 1), newNode('a2', 'Mục 1.2', 2)],
    },
    newNode('b', 'Chương 2', 3),
  ];
}

/** The order of titles, depth first, as the outline shows it. */
const order = (nodes: EditNode[]) => flatten(nodes).map((x) => x.node.title);
const depths = (nodes: EditNode[]) => flatten(nodes).map((x) => x.depth);

describe('indent', () => {
  it('makes the node the last child of its previous sibling', () => {
    const out = indent(tree(), 'b');
    expect(out).toHaveLength(1);
    expect(out[0]!.children.map((c) => c.id)).toEqual(['a1', 'a2', 'b']);
  });

  it('does nothing for the first sibling', () => {
    const before = tree();
    expect(indent(before, 'a1')).toEqual(before);
    expect(indent(before, 'a')).toEqual(before);
  });

  it('keeps the depth-first order', () => {
    const before = order(tree());
    expect(order(indent(tree(), 'b'))).toEqual(before);
    expect(order(indent(tree(), 'a2'))).toEqual(before);
  });
});

describe('outdent', () => {
  it('moves the node up one level, right after its parent', () => {
    const out = outdent(tree(), 'a1');
    expect(out.map((n) => n.id)).toEqual(['a', 'a1', 'b']);
    expect(out[0]!.children.map((c) => c.id)).toEqual([]);
  });

  it('makes the later siblings children of the outdented node', () => {
    const out = outdent(tree(), 'a1');
    expect(out[1]!.children.map((c) => c.id)).toEqual(['a2']);
  });

  it('does nothing for a top-level node', () => {
    const before = tree();
    expect(outdent(before, 'a')).toEqual(before);
    expect(outdent(before, 'b')).toEqual(before);
  });

  it('keeps the depth-first order', () => {
    const before = order(tree());
    expect(order(outdent(tree(), 'a1'))).toEqual(before);
    expect(order(outdent(tree(), 'a2'))).toEqual(before);
  });

  it('indent then outdent gives back the same order and depths', () => {
    const base = tree();
    const round = outdent(indent(base, 'b'), 'b');
    expect(order(round)).toEqual(order(base));
    expect(depths(round)).toEqual(depths(base));
  });
});

describe('move up and down', () => {
  it('swaps with the sibling', () => {
    expect(moveDown(tree(), 'a').map((n) => n.id)).toEqual(['b', 'a']);
    expect(moveUp(tree(), 'b').map((n) => n.id)).toEqual(['b', 'a']);
    expect(moveDown(tree(), 'a1')[0]!.children.map((c) => c.id)).toEqual(['a2', 'a1']);
  });

  it('does nothing at the ends of a list', () => {
    const before = tree();
    expect(moveUp(before, 'a')).toEqual(before);
    expect(moveDown(before, 'b')).toEqual(before);
    expect(moveUp(before, 'a1')).toEqual(before);
    expect(moveDown(before, 'a2')).toEqual(before);
  });

  it('does nothing for an unknown id', () => {
    const before = tree();
    expect(moveUp(before, 'zzz')).toEqual(before);
  });
});

describe('add, remove, rename, page and style', () => {
  it('adds after the selected node at the same level', () => {
    const out = addAfter(tree(), 'a1', newNode('x', 'Mới'));
    expect(out[0]!.children.map((c) => c.id)).toEqual(['a1', 'x', 'a2']);
  });

  it('adds at the end of the top level without a selection', () => {
    const out = addAfter(tree(), null, newNode('x', 'Mới'));
    expect(out.map((n) => n.id)).toEqual(['a', 'b', 'x']);
  });

  it('removes the whole subtree', () => {
    const out = removeNode(tree(), 'a');
    expect(out.map((n) => n.id)).toEqual(['b']);
    expect(countNodes(out)).toBe(1);
  });

  it('renames, sets the page and styles a node without touching the others', () => {
    let t = rename(tree(), 'a2', 'Đổi tên');
    t = setPage(t, 'a2', 9);
    t = setStyle(t, 'a2', { color: '#C00000', bold: true, italic: true });
    expect(findNode(t, 'a2')).toMatchObject({
      title: 'Đổi tên',
      page: 9,
      color: '#C00000',
      bold: true,
      italic: true,
    });
    expect(findNode(t, 'a1')).toMatchObject({ title: 'Mục 1.1', page: 1, bold: false });
  });

  it('a new page target drops the saved view', () => {
    const t = tree();
    t[0]!.view = { type: 'xyz', left: 1, top: 2, zoom: 1 };
    const out = setPage(t, 'a', 5);
    expect(findNode(out, 'a')!.view).toBeNull();
  });
});

describe('ids, counts and the wire shape', () => {
  it('flatten lists every node once with its depth', () => {
    expect(order(tree())).toEqual(['Chương 1', 'Mục 1.1', 'Mục 1.2', 'Chương 2']);
    expect(depths(tree())).toEqual([0, 1, 1, 0]);
    expect(countNodes(tree())).toBe(4);
  });

  it('fromWire gives every node a fresh unique id', () => {
    let n = 0;
    const nodes = fromWire(
      [
        { title: 'A', page: 0, children: [{ title: 'A1', page: 1 }] },
        { title: 'B', page: 2 },
      ],
      () => `id${++n}`,
    );
    const ids = flatten(nodes).map((x) => x.node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['id1', 'id2', 'id3']);
  });

  it('toWire drops the ids and leaves out the empty optionals', () => {
    const wire = toWire(tree());
    expect(wire).toEqual([
      {
        title: 'Chương 1',
        page: 0,
        children: [
          { title: 'Mục 1.1', page: 1 },
          { title: 'Mục 1.2', page: 2 },
        ],
      },
      { title: 'Chương 2', page: 3 },
    ]);
    expect(JSON.stringify(wire)).not.toContain('"id"');
  });

  it('round-trips the core tree with colour, bold, italic and closed items', () => {
    const core = [
      {
        title: 'Phụ lục',
        page: 4,
        open: false,
        color: '#1F4E9A',
        bold: true,
        italic: true,
        view: { type: 'xyz' as const, left: 10, top: 20, zoom: 1.5 },
        children: [{ title: 'Phụ lục A' }],
      },
    ];
    let n = 0;
    const back = toWire(fromWire(core, () => `k${++n}`));
    expect(back).toEqual(core.map((c) => ({ ...c, children: [{ title: 'Phụ lục A' }] })));
  });

  it('a node without a page never gets a view on the wire', () => {
    const wire = toWire([{ ...newNode('z', 'Không trang'), view: { type: 'fit' } }]);
    expect(wire[0]).not.toHaveProperty('view');
    expect(wire[0]).not.toHaveProperty('page');
  });

  it('trims the title on the wire', () => {
    expect(toWire([newNode('q', '  Tên  ', 0)])[0]!.title).toBe('Tên');
  });
});
