/**
 * DEV ONLY: the text (text.*), link (links.*) and annotation (annots.*) ops of the mock bridge. The
 * mock has no text model, so text.getLines has no lines and the text edits change nothing; links
 * and annotations are kept in memory per session, so the lists, the forms and the export work in
 * the dev and screenshot modes like the core. The PDF bytes never change here.
 */
import type { LinkItem } from '../features/links/linksModel';
import type { AnnotItem } from '../features/annots/annotModel';

interface MockTextLinksState {
  links: LinkItem[];
  annots: AnnotItem[];
  seq: number;
}

const stateBySession = new WeakMap<object, MockTextLinksState>();

function stateOf(session: object): MockTextLinksState {
  let st = stateBySession.get(session);
  if (!st) {
    st = { links: [], annots: [], seq: 0 };
    stateBySession.set(session, st);
  }
  return st;
}

const FONTS = [
  { id: 'BeVietnamPro', family: 'Be Vietnam Pro', style: 'Regular', bold: false, italic: false },
  { id: 'BeVietnamPro-Bold', family: 'Be Vietnam Pro', style: 'Bold', bold: true, italic: false },
];

export interface MockTextLinksResult {
  data: unknown;
  /** The ops that change the file (a new revision of identical bytes). */
  changed: boolean;
  changedPages: number[];
}

/** Ops of text, links and annotations; throws for an op it does not know. */
export function applyMockTextLinksOp(
  session: object,
  opId: string,
  p: Record<string, unknown>,
  pageCount: number,
): MockTextLinksResult {
  const st = stateOf(session);
  const nextId = (prefix: string, page: number) => `${prefix}${page}:mock${++st.seq}:0`;
  const none = (data: unknown = {}): MockTextLinksResult => ({
    data,
    changed: false,
    changedPages: [],
  });
  const edited = (data: unknown, pages: number[]): MockTextLinksResult => ({
    data,
    changed: true,
    changedPages: pages,
  });

  switch (opId) {
    case 'text.getLines':
      return none({
        pageIndex: p.pageIndex,
        digest: 'mock',
        displayWidth: 612,
        displayHeight: 792,
        rotation: 0,
        lines: [],
        paragraphs: [],
        blocks: [],
      });
    case 'text.listFonts':
      return none({ fonts: FONTS });
    case 'text.checkText':
      return none({ supported: true, missing: [], willSubstituteWith: null });
    case 'text.editLine':
      return edited(
        {
          lineId: p.lineId,
          changed: true,
          action: 'keep',
          fontFrom: 'BeVietnamPro',
          fontTo: 'BeVietnamPro',
          fit: 'none',
          fontSize: 11,
          tracking: 0,
          width: 0,
          overflow: 0,
          missing: [],
          warnings: [],
        },
        [p.pageIndex as number],
      );
    case 'text.editParagraph':
    case 'text.styleParagraph':
      return edited({ changed: true, overflow: 0, overlapsBlockIds: [] }, [p.pageIndex as number]);
    case 'text.findReplace':
      return p.preview
        ? none({ matches: [], replaced: 0, fontSubstitutions: [], skipped: [], preview: true })
        : none({ matches: [], replaced: 0, fontSubstitutions: [], skipped: [], preview: false });
    case 'links.list': {
      const page = typeof p.pageIndex === 'number' ? p.pageIndex : null;
      return none({ links: st.links.filter((l) => page === null || l.pageIndex === page) });
    }
    case 'links.add': {
      const page = p.pageIndex as number;
      const link: LinkItem = {
        id: nextId('K', page),
        pageIndex: page,
        kind: p.kind as string,
        target: (p.uri as string | undefined) ?? String(p.targetPage ?? 0),
        view: (p.view as string | undefined) ?? 'fit',
        left: null,
        top: null,
        rect: p.rect as number[],
        borderWidth: (p.borderWidth as number | undefined) ?? 0,
        color: (p.color as string | undefined) ?? null,
        highlight: (p.highlight as string | undefined) ?? 'invert',
      };
      st.links.push(link);
      return edited({ id: link.id }, [page]);
    }
    case 'links.update': {
      const link = st.links.find((l) => l.id === p.id);
      if (!link) throw new Error('LINK_NOT_FOUND');
      if (typeof p.uri === 'string') {
        link.kind = 'uri';
        link.target = p.uri;
      } else if (typeof p.targetPage === 'number') {
        link.kind = 'page';
        link.target = String(p.targetPage);
      }
      return edited({ id: link.id }, [link.pageIndex]);
    }
    case 'links.remove': {
      const ids = (p.ids as string[] | undefined) ?? [];
      const gone = st.links.filter((l) => (p.all ? true : ids.includes(l.id)));
      st.links = st.links.filter((l) => !gone.includes(l));
      return edited({ removed: gone.length }, [...new Set(gone.map((l) => l.pageIndex))]);
    }
    case 'links.autoDetect':
      return edited({ created: 0, links: [] }, []);
    case 'annots.list': {
      const page = typeof p.pageIndex === 'number' ? p.pageIndex : null;
      return none({ annots: st.annots.filter((a) => page === null || a.pageIndex === page) });
    }
    case 'annots.addTextMarkup':
    case 'annots.addNote':
    case 'annots.addFreeText':
    case 'annots.addInk':
    case 'annots.addShape': {
      const page = p.pageIndex as number;
      const kind = opId.slice('annots.add'.length);
      const subtype =
        {
          TextMarkup: 'Highlight',
          Note: 'Text',
          FreeText: 'FreeText',
          Ink: 'Ink',
          Shape: 'Square',
        }[kind] ?? 'Text';
      const id = nextId('A', page);
      const item: AnnotItem = {
        id,
        pageIndex: page,
        subtype,
        rect: [72, 72, 200, 96],
        contents: (p.contents as string | undefined) ?? (p.text as string | undefined) ?? '',
        author: (p.author as string | undefined) ?? '',
        modified: new Date().toISOString(),
        colour: (p.color as string | undefined) ?? null,
        opacity: (p.opacity as number | undefined) ?? 1,
        replies: [],
        inReplyTo: null,
        status: null,
        quads: [],
        icon: 'Note',
      };
      st.annots.push(item);
      return edited({ id, count: 1, ids: [id] }, [page]);
    }
    case 'annots.update': {
      const a = st.annots.find((x) => x.id === p.id);
      if (!a) throw new Error('ANNOTATION_NOT_FOUND');
      if (typeof p.contents === 'string') a.contents = p.contents;
      return edited({ id: a.id }, [a.pageIndex]);
    }
    case 'annots.remove': {
      const ids = (p.ids as string[]) ?? [];
      const gone = st.annots.filter((a) => ids.includes(a.id));
      st.annots = st.annots.filter((a) => !gone.includes(a));
      return edited({ removed: gone.length }, [...new Set(gone.map((a) => a.pageIndex))]);
    }
    case 'annots.reply': {
      const parent = st.annots.find((x) => x.id === p.id);
      if (!parent) throw new Error('ANNOTATION_NOT_FOUND');
      const id = nextId('A', parent.pageIndex);
      const reply: AnnotItem = {
        ...parent,
        id,
        subtype: 'Text',
        contents: String(p.text ?? ''),
        author: String(p.author ?? ''),
        replies: [],
        inReplyTo: parent.id,
        status: null,
      };
      parent.replies = [...parent.replies, id];
      st.annots.push(reply);
      return edited({ id }, [parent.pageIndex]);
    }
    case 'annots.setStatus': {
      const a = st.annots.find((x) => x.id === p.id);
      if (!a) throw new Error('ANNOTATION_NOT_FOUND');
      a.status = p.status === 'none' ? null : (p.status as AnnotItem['status']);
      return edited({ id: a.id }, [a.pageIndex]);
    }
    case 'annots.export':
      return none({ count: st.annots.length });
    case 'annots.flatten': {
      const kinds = (p.kinds as string[] | undefined) ?? null;
      const pages = (p.pages as number[] | undefined) ?? null;
      const gone = st.annots.filter(
        (a) => (!kinds || kinds.includes(a.subtype)) && (!pages || pages.includes(a.pageIndex)),
      );
      st.annots = st.annots.filter((a) => !gone.includes(a));
      return edited(
        { flattened: gone.length },
        [...new Set(gone.map((a) => a.pageIndex))].filter((i) => i < pageCount),
      );
    }
    default:
      throw new Error(`Unknown op ${opId}`);
  }
}

/** Ops that the mock answers here (the bridge sends the others on). */
export const MOCK_TEXT_LINK_OPS = new Set<string>([
  'text.getLines',
  'text.listFonts',
  'text.checkText',
  'text.editLine',
  'text.editParagraph',
  'text.styleParagraph',
  'text.findReplace',
  'links.list',
  'links.add',
  'links.update',
  'links.remove',
  'links.autoDetect',
  'annots.list',
  'annots.addTextMarkup',
  'annots.addNote',
  'annots.addFreeText',
  'annots.addInk',
  'annots.addShape',
  'annots.update',
  'annots.remove',
  'annots.reply',
  'annots.setStatus',
  'annots.export',
  'annots.flatten',
]);
