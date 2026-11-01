/**
 * DEV ONLY: the object edit (content.*) and layer (layers.*) ops of the mock bridge. The mock has
 * no content model: each session gets three fixed sample objects per page (a path, a line of text
 * and an image) and a fixed set of three layers. Moves, deletes, duplicates, colour, opacity and
 * order work on that list, so the dev and screenshot modes behave like the core. The PDF bytes do
 * not change (the mock writes a new revision only).
 */
import type { ListObjectsData, PageObject, ViewByTypeData } from '../features/objects/objectModel';
import type { LayersData, LayerInfo } from '../features/layers/layersModel';

interface MockLayerState {
  layers: LayerInfo[];
}

const objectsBySession = new WeakMap<object, Map<number, PageObject[]>>();
const layersBySession = new WeakMap<object, MockLayerState>();

function sampleObjects(page: number): PageObject[] {
  const base = {
    pageIndex: page,
    parentId: null,
    editable: true,
    layer: null,
    clipped: false,
    opacity: [1, 1] as [number, number],
  };
  return [
    {
      ...base,
      id: '',
      kind: 'path',
      ordinal: 0,
      bbox: [72, 90, 300, 200],
      fillColor: '#ff0000',
      strokeColor: null,
      layer: 'Watermark',
    },
    {
      ...base,
      id: '',
      kind: 'text',
      ordinal: 1,
      bbox: [72, 240, 360, 262],
      string: 'Xin chào, đây là dòng chữ mẫu',
      font: 'Helvetica',
      fontSize: 18,
      fillColor: '#000000',
      strokeColor: null,
    },
    {
      ...base,
      id: '',
      kind: 'image',
      ordinal: 2,
      bbox: [72, 300, 272, 420],
      pixelSize: [400, 240],
      imageName: 'Im1',
      inline: false,
      smask: false,
    },
  ];
}

function pageObjects(session: object, page: number): PageObject[] {
  let pages = objectsBySession.get(session);
  if (!pages) {
    pages = new Map();
    objectsBySession.set(session, pages);
  }
  let list = pages.get(page);
  if (!list) {
    list = sampleObjects(page);
    pages.set(page, list);
  }
  return list;
}

function withIds(list: PageObject[], page: number, rev: number): PageObject[] {
  return list.map((o) => ({ ...o, id: `p${page}:m${rev}:${o.ordinal}` }));
}

/** Parses an id of the mock (p<page>:<digest>:<ordinal>). */
function parse(id: string): { page: number; ordinal: number } | null {
  const m = /^p(\d+):[^:]+:(\d+)$/.exec(id);
  return m ? { page: Number(m[1]), ordinal: Number(m[2]) } : null;
}

export function mockListObjects(session: object, page: number, rev: number): ListObjectsData {
  return {
    pageIndex: page,
    digest: `m${rev}`,
    displayWidth: 612,
    displayHeight: 792,
    rotation: 0,
    objects: withIds(pageObjects(session, page), page, rev),
  };
}

export function mockViewByType(session: object, page: number, rev: number): ViewByTypeData {
  const kinds: ViewByTypeData['kinds'] = {};
  for (const o of withIds(pageObjects(session, page), page, rev)) {
    const entry = kinds[o.kind] ?? { count: 0, bboxes: [], ids: [] };
    entry.count += 1;
    entry.bboxes.push(o.bbox);
    entry.ids.push(o.id);
    kinds[o.kind] = entry;
  }
  return { pageIndex: page, displayWidth: 612, displayHeight: 792, kinds };
}

/**
 * Applies a content.* edit to the mock list. Returns the pages it changed, or null when the op is
 * not a content edit of the mock.
 */
export function applyMockContentEdit(
  session: object,
  opId: string,
  params: unknown,
  rev: number,
): number[] | null {
  const p = params as Record<string, unknown>;
  const ids = Array.isArray(p.ids) ? (p.ids as string[]) : [];
  const targets: PageObject[] = [];
  const touched = new Set<number>();
  for (const id of ids) {
    const ref = parse(id);
    if (!ref) continue;
    const list = pageObjects(session, ref.page);
    const obj = list.find((o) => o.ordinal === ref.ordinal);
    if (obj) {
      targets.push(obj);
      touched.add(ref.page);
    }
  }
  const pages = [...touched].sort((a, b) => a - b);
  switch (opId) {
    case 'content.move': {
      const dx = Number(p.dx ?? 0);
      const dy = Number(p.dy ?? 0);
      for (const o of targets) {
        o.bbox = [o.bbox[0] + dx, o.bbox[1] + dy, o.bbox[2] + dx, o.bbox[3] + dy];
      }
      return pages;
    }
    case 'content.delete': {
      for (const page of pages) {
        const list = pageObjects(session, page);
        const drop = new Set(targets.filter((o) => list.includes(o)).map((o) => o.ordinal));
        const kept = list.filter((o) => !drop.has(o.ordinal));
        objectsBySession.get(session)!.set(page, kept);
      }
      return pages;
    }
    case 'content.duplicate': {
      const dx = Number(p.dx ?? 10);
      const dy = Number(p.dy ?? 10);
      for (const page of pages) {
        const list = pageObjects(session, page);
        let top = Math.max(...list.map((o) => o.ordinal));
        for (const o of targets.filter((t) => list.includes(t))) {
          top += 1;
          list.push({
            ...o,
            ordinal: top,
            bbox: [o.bbox[0] + dx, o.bbox[1] + dy, o.bbox[2] + dx, o.bbox[3] + dy],
          });
        }
      }
      return pages;
    }
    case 'content.reorder': {
      const mode = String(p.mode);
      for (const page of pages) {
        const list = pageObjects(session, page);
        const top = Math.max(...list.map((o) => o.ordinal));
        const bottom = Math.min(...list.map((o) => o.ordinal));
        for (const o of targets.filter((t) => list.includes(t))) {
          if (mode === 'front') o.ordinal = top + 1;
          else if (mode === 'back') o.ordinal = bottom - 1;
          else if (mode === 'forward') o.ordinal += 1.5;
          else o.ordinal -= 1.5;
        }
        const sorted = [...list]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((o, i) => ({ ...o, ordinal: i }));
        objectsBySession.get(session)!.set(page, sorted);
      }
      return pages;
    }
    case 'content.setColor': {
      for (const o of targets) {
        if (typeof p.fill === 'string') o.fillColor = p.fill;
        if (typeof p.stroke === 'string') o.strokeColor = p.stroke;
      }
      return pages;
    }
    case 'content.setOpacity': {
      const v = Number(p.opacity ?? 1);
      for (const o of targets) o.opacity = [v, v];
      return pages;
    }
    default:
      void rev;
      return null;
  }
}

/** Layers of a mock session (created on first use). */
export function mockLayersOf(session: object): LayerInfo[] {
  let state = layersBySession.get(session);
  if (!state) {
    state = {
      layers: [
        {
          id: 'l1',
          name: 'Watermark',
          intent: ['View'],
          usage: ['Print'],
          visible: true,
          locked: false,
          objectCount: 1,
          pageCount: 1,
          pages: [0],
        },
        {
          id: 'l2',
          name: 'Chú thích',
          intent: ['View'],
          usage: [],
          visible: true,
          locked: false,
          objectCount: 2,
          pageCount: 1,
          pages: [0],
        },
        {
          id: 'l3',
          name: 'Ghi chú nội bộ',
          intent: ['Design'],
          usage: [],
          visible: false,
          locked: true,
          objectCount: 0,
          pageCount: 0,
          pages: [],
        },
      ],
    };
    layersBySession.set(session, state);
  }
  return state.layers;
}

export function mockLayersData(session: object): LayersData {
  return { baseState: 'ON', layers: mockLayersOf(session), order: [] };
}

/** Applies a layers.* op to the mock list. Returns false when the op is not a layer op. */
export function applyMockLayerOp(session: object, opId: string, params: unknown): boolean {
  const list = mockLayersOf(session);
  const state = layersBySession.get(session)!;
  const p = params as { layerIds?: string[]; visible?: boolean; deleteContent?: boolean };
  if (opId === 'layers.setVisibility') {
    for (const l of list) if (p.layerIds?.includes(l.id)) l.visible = !!p.visible;
    return true;
  }
  if (opId === 'layers.remove') {
    state.layers = list.filter((l) => !p.layerIds?.includes(l.id));
    return true;
  }
  if (opId === 'layers.flatten') {
    state.layers = [];
    return true;
  }
  return false;
}

/**
 * Mock of content.eraseRegion on the sample list: objects inside the rectangle are removed (cut)
 * or counted as covered; objects that only cross it count as split and stay.
 */
export function applyMockErase(
  session: object,
  p: { pageIndex?: number; rect: number[]; mode?: string; partial?: boolean },
): {
  removedObjects: number;
  splitObjects: number;
  modifiedImages: number;
  clippedObjects: number;
  covered: number;
  skipped: string[];
} {
  const page = p.pageIndex ?? 0;
  const [x0, y0, x1, y1] = p.rect as [number, number, number, number];
  const list = pageObjects(session, page);
  const inside = (o: PageObject) =>
    o.bbox[0] >= x0 && o.bbox[1] >= y0 && o.bbox[2] <= x1 && o.bbox[3] <= y1;
  const crosses = (o: PageObject) =>
    o.bbox[0] < x1 && o.bbox[2] > x0 && o.bbox[1] < y1 && o.bbox[3] > y0;
  let removed = 0;
  let split = 0;
  const kept: PageObject[] = [];
  for (const o of list) {
    if (inside(o)) {
      removed += p.mode === 'cover' ? 0 : 1;
      if (p.mode === 'cover') kept.push(o);
      continue;
    }
    if (crosses(o)) {
      if (p.partial === false) kept.push(o);
      else {
        split += 1;
        kept.push(o);
      }
      continue;
    }
    kept.push(o);
  }
  objectsBySession.get(session)!.set(page, kept);
  const covered = p.mode === 'cover' ? list.filter(inside).length : 0;
  return {
    removedObjects: removed,
    splitObjects: split,
    modifiedImages: 0,
    clippedObjects: 0,
    covered,
    skipped: [],
  };
}
