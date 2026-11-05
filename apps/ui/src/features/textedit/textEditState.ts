/**
 * In-memory state of the text edit mode (not saved): the mode toggle, the text selected on the page
 * (D65), the open paragraph session (D62) and the replacement font list. The line cache is keyed by
 * `<doc id>:<revision version>` like the object cache: a response for another revision is dropped,
 * so a slow text.getLines cannot put stale lines on screen.
 */
import { create } from 'zustand';
import type { SessionRow } from './textSession';
import type { PageSelection } from './textSelection';
import type { FontStrategy, TextLine } from './textEditModel';
import type { ParagraphInfo, TextBlock } from './textParagraphModel';

/** A message the session shows: the font takes over, characters are missing, text overflows. */
export interface SessionNote {
  tone: 'warn' | 'error';
  text: string;
}

/**
 * The paragraph being typed into (D62). The text is what the paragraph would have; nothing is
 * written until the session commits. `rows` is the layout of the text from text.previewParagraph
 * (null until the first answer), and `seq` drops answers that come after a newer keystroke.
 */
export interface ParaSession {
  /** The document the session writes into. */
  docId: string;
  pageIndex: number;
  /** The paragraph id of the revision the session started from. */
  paragraphId: string;
  original: string;
  text: string;
  caret: number;
  anchor: number;
  fontSize: number;
  rows: SessionRow[] | null;
  /** Font of the rows, from text.previewParagraph (null until the first answer). */
  render: RenderFont | null;
  notes: SessionNote[];
  seq: number;
  committing: boolean;
}

/** How the session draws its text: the family the commit writes (installed fonts only), else a style. */
export interface RenderFont {
  family: string | null;
  style: string;
  bold: boolean;
  italic: boolean;
}

/** A new text box: where it goes (points, displayed frame) and the text typed so far. */
export interface Draft {
  /** The document the new text goes into. */
  docId: string;
  pageIndex: number;
  x: number;
  y: number;
  text: string;
}

export interface ReplacementFont {
  id: string;
  family: string;
  style: string;
  bold: boolean;
  italic: boolean;
  /** 'bundled' (shipped with the app) or 'system' (installed on this computer). */
  source?: string;
}

interface TextEditState {
  /** Text edit mode is on (toolbar toggle). */
  active: boolean;
  /** Lines of the loaded pages, by 0-based page index. */
  lines: Record<number, TextLine[]>;
  key: string;
  fonts: ReplacementFont[] | null;
  fontStrategy: FontStrategy;
  fontName: string | null;
  /** The text selected on the page (D65), or null. Its paragraph is the one the format bar changes. */
  selection: PageSelection | null;
  /** Blocks of the loaded pages (for the overlap warnings), by page index. */
  blocks: Record<number, TextBlock[]>;
  /** Paragraph align and indent of the loaded pages, by page index. */
  paragraphs: Record<number, ParagraphInfo[]>;
  /** A format change is running: the bar takes no new change until it ends (one op at a time). */
  formatBusy: boolean;
  session: ParaSession | null;
  /** The Thêm văn bản tool is on: a press on the page starts a new text box (D66). */
  addingText: boolean;
  /** A new text box being typed on the page (D66); nothing is written until it is committed. */
  draft: Draft | null;
  setActive(active: boolean): void;
  setAddingText(on: boolean): void;
  openDraft(draft: { docId: string; pageIndex: number; x: number; y: number }): void;
  patchDraft(text: string): void;
  closeDraft(): void;
  setSelection(selection: PageSelection | null): void;
  resetFor(key: string): void;
  setPage(
    key: string,
    index: number,
    lines: TextLine[],
    blocks?: TextBlock[],
    paragraphs?: ParagraphInfo[],
  ): void;
  setFormatBusy(on: boolean): void;
  setFonts(fonts: ReplacementFont[]): void;
  setFontName(id: string | null): void;
  openSession(
    s: Pick<ParaSession, 'docId' | 'pageIndex' | 'paragraphId' | 'original' | 'fontSize'> & {
      anchor?: number;
      caret?: number;
    },
  ): void;
  patchSession(patch: Partial<ParaSession>): void;
  closeSession(): void;
}

export const useTextEdit = create<TextEditState>((set) => ({
  active: false,
  lines: {},
  key: '',
  fonts: null,
  fontStrategy: 'auto',
  fontName: null,
  selection: null,
  blocks: {},
  paragraphs: {},
  formatBusy: false,
  session: null,
  addingText: false,
  draft: null,
  setActive(active) {
    // Turning the mode off keeps an open session and a draft: the layer writes them, so typed text
    // is not lost. The add-text tool goes off with the mode.
    set(active ? { active } : { active, selection: null, addingText: false });
  },
  setAddingText(on) {
    set({ addingText: on, ...(on ? {} : { draft: null }) });
  },
  openDraft(draft) {
    set({ draft: { ...draft, text: '' } });
  },
  patchDraft(text) {
    set((s) => (s.draft ? { draft: { ...s.draft, text } } : s));
  },
  closeDraft() {
    set({ draft: null });
  },
  setSelection(selection) {
    set({ selection });
  },
  resetFor(key) {
    set((s) => (s.key === key ? s : { key, lines: {}, blocks: {}, paragraphs: {} }));
  },
  setPage(key, index, lines, blocks, paragraphs) {
    set((s) =>
      s.key !== key
        ? s
        : {
            lines: { ...s.lines, [index]: lines },
            ...(blocks ? { blocks: { ...s.blocks, [index]: blocks } } : {}),
            ...(paragraphs ? { paragraphs: { ...s.paragraphs, [index]: paragraphs } } : {}),
          },
    );
  },
  setFormatBusy(on) {
    set({ formatBusy: on });
  },
  setFonts(fonts) {
    set({ fonts });
  },
  setFontName(id) {
    set({ fontName: id });
  },
  openSession(s) {
    const { anchor, caret, ...rest } = s;
    set({
      session: {
        ...rest,
        text: s.original,
        caret: caret ?? s.original.length,
        anchor: anchor ?? s.original.length,
        rows: null,
        render: null,
        notes: [],
        seq: 0,
        committing: false,
      },
    });
  },
  patchSession(patch) {
    set((s) => (s.session ? { session: { ...s.session, ...patch } } : s));
  },
  closeSession() {
    set({ session: null });
  },
}));
