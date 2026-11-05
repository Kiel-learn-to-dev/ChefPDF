/**
 * In-memory state of the text edit mode (not saved): the mode toggle, the hovered line, the
 * selected paragraph, the open paragraph session (D62) and the replacement font list. The line cache
 * is keyed by `<doc id>:<revision version>` like the object cache: a response for another revision
 * is dropped, so a slow text.getLines cannot put stale lines on screen.
 */
import { create } from 'zustand';
import type { SessionRow } from './textSession';
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
  notes: SessionNote[];
  seq: number;
  committing: boolean;
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
  hoverId: string | null;
  fonts: ReplacementFont[] | null;
  fontStrategy: FontStrategy;
  fontName: string | null;
  selectedParagraphId: string | null;
  /** Blocks of the loaded pages (for the overlap warnings), by page index. */
  blocks: Record<number, TextBlock[]>;
  /** Paragraph align and indent of the loaded pages, by page index. */
  paragraphs: Record<number, ParagraphInfo[]>;
  /** A format change is running: the bar takes no new change until it ends (one op at a time). */
  formatBusy: boolean;
  session: ParaSession | null;
  setActive(active: boolean): void;
  setSelectedParagraph(id: string | null): void;
  resetFor(key: string): void;
  setPage(
    key: string,
    index: number,
    lines: TextLine[],
    blocks?: TextBlock[],
    paragraphs?: ParagraphInfo[],
  ): void;
  setFormatBusy(on: boolean): void;
  setHover(id: string | null): void;
  setFonts(fonts: ReplacementFont[]): void;
  setFontName(id: string | null): void;
  openSession(
    s: Pick<ParaSession, 'docId' | 'pageIndex' | 'paragraphId' | 'original' | 'fontSize'>,
  ): void;
  patchSession(patch: Partial<ParaSession>): void;
  closeSession(): void;
}

export const useTextEdit = create<TextEditState>((set) => ({
  active: false,
  lines: {},
  key: '',
  hoverId: null,
  fonts: null,
  fontStrategy: 'auto',
  fontName: null,
  selectedParagraphId: null,
  blocks: {},
  paragraphs: {},
  formatBusy: false,
  session: null,
  setActive(active) {
    // Turning the mode off keeps an open session: the layer writes it, so typed text is not lost.
    set(active ? { active } : { active, hoverId: null, selectedParagraphId: null });
  },
  setSelectedParagraph(id) {
    set({ selectedParagraphId: id });
  },
  resetFor(key) {
    set((s) => (s.key === key ? s : { key, lines: {}, blocks: {}, paragraphs: {}, hoverId: null }));
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
  setHover(id) {
    set({ hoverId: id });
  },
  setFonts(fonts) {
    set({ fonts });
  },
  setFontName(id) {
    set({ fontName: id });
  },
  openSession(s) {
    set({
      session: {
        ...s,
        text: s.original,
        caret: s.original.length,
        anchor: s.original.length,
        rows: null,
        notes: [],
        seq: 0,
        committing: false,
      },
      selectedParagraphId: s.paragraphId,
    });
  },
  patchSession(patch) {
    set((s) => (s.session ? { session: { ...s.session, ...patch } } : s));
  },
  closeSession() {
    set({ session: null });
  },
}));
