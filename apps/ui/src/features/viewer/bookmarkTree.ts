/**
 * Pure tree editing for the bookmarks editor (D3). Every function returns a new tree and leaves
 * the input alone. Node ids are local (never sent to the core): `nextId` makes them unique.
 *
 * Invariants (tested): indent / outdent / move keep the depth-first order of the outline, and a
 * move that cannot happen (first sibling indent, top-level outdent, first move up, last move
 * down) returns the same tree.
 */
import type { BookmarkNode, BookmarkView } from '@chef/contracts';

export interface EditNode {
  id: string;
  title: string;
  /** 0-based page, or null for a bookmark without a target. */
  page: number | null;
  view: BookmarkView | null;
  open: boolean;
  color: string | null;
  bold: boolean;
  italic: boolean;
  children: EditNode[];
}

export type IdFactory = () => string;

export function newNode(id: string, title: string, page: number | null = null): EditNode {
  return {
    id,
    title,
    page,
    view: null,
    open: true,
    color: null,
    bold: false,
    italic: false,
    children: [],
  };
}

/** Reads the core tree (bookmarks.get) into editable nodes with fresh ids. */
export function fromWire(list: readonly BookmarkNode[], nextId: IdFactory): EditNode[] {
  return list.map((b) => ({
    id: nextId(),
    title: b.title,
    page: typeof b.page === 'number' ? b.page : null,
    view: b.page === undefined || b.page === null ? null : (b.view ?? null),
    open: b.open !== false,
    color: b.color ?? null,
    bold: b.bold === true,
    italic: b.italic === true,
    children: fromWire(b.children ?? [], nextId),
  }));
}

/** The tree in the shape of bookmarks.set (ids dropped, empty optionals left out). */
export function toWire(nodes: readonly EditNode[]): BookmarkNode[] {
  return nodes.map((n) => {
    const out: BookmarkNode = { title: n.title.trim() };
    if (n.page !== null) out.page = n.page;
    if (n.page !== null && n.view) out.view = { ...n.view };
    if (!n.open) out.open = false;
    if (n.color) out.color = n.color;
    if (n.bold) out.bold = true;
    if (n.italic) out.italic = true;
    if (n.children.length > 0) out.children = toWire(n.children);
    return out;
  });
}

/** Every node in depth-first order, with its depth (0 for the top level). */
export function flatten(
  nodes: readonly EditNode[],
  depth = 0,
): { node: EditNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

export function countNodes(nodes: readonly EditNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

/** The path of child indices to a node, or null when the id is not in the tree. */
export function pathTo(nodes: readonly EditNode[], id: string): number[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.id === id) return [i];
    const sub = pathTo(n.children, id);
    if (sub) return [i, ...sub];
  }
  return null;
}

/** Applies `fn` to the list that holds the node, at its index. */
function editSiblings(
  nodes: readonly EditNode[],
  path: number[],
  fn: (siblings: EditNode[], index: number) => EditNode[],
): EditNode[] {
  const [head, ...rest] = path;
  if (head === undefined) return [...nodes];
  if (rest.length === 0) return fn([...nodes], head);
  return nodes.map((n, i) =>
    i === head ? { ...n, children: editSiblings(n.children, rest, fn) } : n,
  );
}

export function updateNode(
  nodes: readonly EditNode[],
  id: string,
  patch: (n: EditNode) => EditNode,
): EditNode[] {
  return nodes.map((n) =>
    n.id === id ? patch(n) : { ...n, children: updateNode(n.children, id, patch) },
  );
}

export function rename(nodes: readonly EditNode[], id: string, title: string): EditNode[] {
  return updateNode(nodes, id, (n) => ({ ...n, title }));
}

/** Sets the target page (a new target clears the view, the core then uses fit). */
export function setPage(nodes: readonly EditNode[], id: string, page: number | null): EditNode[] {
  return updateNode(nodes, id, (n) => ({ ...n, page, view: null }));
}

export function setStyle(
  nodes: readonly EditNode[],
  id: string,
  style: Partial<Pick<EditNode, 'color' | 'bold' | 'italic' | 'open'>>,
): EditNode[] {
  return updateNode(nodes, id, (n) => ({ ...n, ...style }));
}

/** Removes the node and its whole subtree. */
export function removeNode(nodes: readonly EditNode[], id: string): EditNode[] {
  const path = pathTo(nodes, id);
  if (!path) return [...nodes];
  return editSiblings(nodes, path, (siblings, index) => {
    siblings.splice(index, 1);
    return siblings;
  });
}

/**
 * Adds a node right after the selected one (same level), or at the end of the top level when
 * nothing is selected.
 */
export function addAfter(
  nodes: readonly EditNode[],
  selectedId: string | null,
  node: EditNode,
): EditNode[] {
  const path = selectedId ? pathTo(nodes, selectedId) : null;
  if (!path) return [...nodes, node];
  return editSiblings(nodes, path, (siblings, index) => {
    siblings.splice(index + 1, 0, node);
    return siblings;
  });
}

/**
 * Indent: the node becomes the last child of its previous sibling. The first sibling cannot be
 * indented (same tree back).
 */
export function indent(nodes: readonly EditNode[], id: string): EditNode[] {
  const path = pathTo(nodes, id);
  if (!path || path[path.length - 1] === 0) return [...nodes];
  return editSiblings(nodes, path, (siblings, index) => {
    const [node] = siblings.splice(index, 1);
    const prev = siblings[index - 1]!;
    siblings[index - 1] = { ...prev, open: true, children: [...prev.children, node!] };
    return siblings;
  });
}

/**
 * Outdent: the node moves up one level, right after its parent. Its later siblings become its
 * children, so the depth-first order does not change. A top-level node cannot be outdented.
 */
export function outdent(nodes: readonly EditNode[], id: string): EditNode[] {
  const path = pathTo(nodes, id);
  if (!path || path.length < 2) return [...nodes];
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const parent = getAt(nodes, parentPath);
  const current = parent?.children[index];
  if (!parent || !current) return [...nodes];
  const moved: EditNode = {
    ...current,
    children: [...current.children, ...parent.children.slice(index + 1)],
  };
  const trimmed: EditNode = { ...parent, children: parent.children.slice(0, index) };
  return replaceAt(nodes, parentPath, [trimmed, moved]);
}

/** Replaces the node at `path` by several nodes in the same list. */
function replaceAt(
  nodes: readonly EditNode[],
  path: number[],
  replacement: EditNode[],
): EditNode[] {
  const [head, ...rest] = path;
  if (head === undefined) return [...nodes];
  if (rest.length === 0) return [...nodes.slice(0, head), ...replacement, ...nodes.slice(head + 1)];
  return nodes.map((n, i) =>
    i === head ? { ...n, children: replaceAt(n.children, rest, replacement) } : n,
  );
}

function getAt(nodes: readonly EditNode[], path: number[]): EditNode | null {
  let list: readonly EditNode[] = nodes;
  let node: EditNode | null = null;
  for (const i of path) {
    node = list[i] ?? null;
    if (!node) return null;
    list = node.children;
  }
  return node;
}

function swapSiblings(nodes: readonly EditNode[], id: string, delta: -1 | 1): EditNode[] {
  const path = pathTo(nodes, id);
  if (!path) return [...nodes];
  const index = path[path.length - 1]!;
  const siblingsLength = siblingCount(nodes, path.slice(0, -1));
  const target = index + delta;
  if (target < 0 || target >= siblingsLength) return [...nodes];
  return editSiblings(nodes, path, (siblings, i) => {
    const t = siblings[target]!;
    siblings[target] = siblings[i]!;
    siblings[i] = t;
    return siblings;
  });
}

function siblingCount(nodes: readonly EditNode[], parentPath: number[]): number {
  if (parentPath.length === 0) return nodes.length;
  return getAt(nodes, parentPath)?.children.length ?? 0;
}

export function moveUp(nodes: readonly EditNode[], id: string): EditNode[] {
  return swapSiblings(nodes, id, -1);
}

export function moveDown(nodes: readonly EditNode[], id: string): EditNode[] {
  return swapSiblings(nodes, id, 1);
}

/** Looks a node up by id. */
export function findNode(nodes: readonly EditNode[], id: string): EditNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const sub = findNode(n.children, id);
    if (sub) return sub;
  }
  return null;
}
