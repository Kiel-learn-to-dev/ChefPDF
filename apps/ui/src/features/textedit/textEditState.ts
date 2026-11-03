/**
 * In-memory state of the text edit mode (not saved): the mode toggle, the hovered and selected
 * line, the open editor, the replacement font list and the options of the editor. The line cache
 * is keyed by `<doc id>:<revision version>` like the object cache: a response for another revision
 * is dropped, so a slow text.getLines cannot put stale lines on screen.
 */
import { create } from 'zustand';
import {
  reduceEditor,
  type Editor,
  type EditorEvent,
  type FitWidth,
  type FontStrategy,
  type TextLine,
} from './textEditModel';
import { KEEP_STYLE, type ParagraphStyle, type TextBlock } from './textParagraphModel';

/** The open paragraph editor (D9): the paragraph, its text as typed, and its style choices. */
export interface ParaEditor {
  pageIndex: number;
  paragraphId: string;
  original: string;
  text: string;
  style: ParagraphStyle;
  applying: boolean;
  error: string | null;
}

export interface ReplacementFont {
  id: string;
  family: string;
  style: string;
  bold: boolean;
  italic: boolean;
}

interface TextEditState {
  /** Text edit mode is on (toolbar toggle). */
  active: boolean;
  /** Lines of the loaded pages, by 0-based page index. */
  lines: Record<number, TextLine[]>;
  key: string;
  hoverId: string | null;
  selectedId: string | null;
  editor: Editor | null;
  fonts: ReplacementFont[] | null;
  fitWidth: FitWidth;
  fontStrategy: FontStrategy;
  fontName: string | null;
  /** Paragraph mode (D9): a click selects a paragraph and a double click opens its editor. */
  paragraphMode: boolean;
  selectedParagraphId: string | null;
  /** Blocks of the loaded pages (for the overlap warnings), by page index. */
  blocks: Record<number, TextBlock[]>;
  paraEditor: ParaEditor | null;
  setActive(active: boolean): void;
  setParagraphMode(on: boolean): void;
  setSelectedParagraph(id: string | null): void;
  resetFor(key: string): void;
  setPage(key: string, index: number, lines: TextLine[], blocks?: TextBlock[]): void;
  setHover(id: string | null): void;
  setSelected(id: string | null): void;
  setFonts(fonts: ReplacementFont[]): void;
  setOptions(patch: Partial<Pick<TextEditState, 'fitWidth' | 'fontStrategy' | 'fontName'>>): void;
  dispatch(ev: EditorEvent): void;
  openParagraph(p: Omit<ParaEditor, 'style' | 'applying' | 'error'>): void;
  patchParagraph(patch: Partial<Pick<ParaEditor, 'text' | 'style' | 'applying' | 'error'>>): void;
  closeParagraph(): void;
}

export const useTextEdit = create<TextEditState>((set, get) => ({
  active: false,
  lines: {},
  key: '',
  hoverId: null,
  selectedId: null,
  editor: null,
  fonts: null,
  fitWidth: 'none',
  fontStrategy: 'auto',
  fontName: null,
  paragraphMode: false,
  selectedParagraphId: null,
  blocks: {},
  paraEditor: null,
  setActive(active) {
    set(
      active
        ? { active, editor: null, paraEditor: null }
        : {
            active,
            editor: null,
            paraEditor: null,
            hoverId: null,
            selectedId: null,
            selectedParagraphId: null,
          },
    );
  },
  setParagraphMode(on) {
    set({ paragraphMode: on, selectedParagraphId: null, paraEditor: null });
  },
  setSelectedParagraph(id) {
    set({ selectedParagraphId: id });
  },
  resetFor(key) {
    set((s) => (s.key === key ? s : { key, lines: {}, blocks: {}, hoverId: null }));
  },
  setPage(key, index, lines, blocks) {
    set((s) =>
      s.key !== key
        ? s
        : {
            lines: { ...s.lines, [index]: lines },
            ...(blocks ? { blocks: { ...s.blocks, [index]: blocks } } : {}),
          },
    );
  },
  openParagraph(p) {
    set({ paraEditor: { ...p, style: KEEP_STYLE, applying: false, error: null } });
  },
  patchParagraph(patch) {
    set((s) => (s.paraEditor ? { paraEditor: { ...s.paraEditor, ...patch } } : s));
  },
  closeParagraph() {
    set({ paraEditor: null });
  },
  setHover(id) {
    set({ hoverId: id });
  },
  setSelected(id) {
    set({ selectedId: id });
  },
  setFonts(fonts) {
    set({ fonts });
  },
  setOptions(patch) {
    set(patch);
  },
  dispatch(ev) {
    set({ editor: reduceEditor(get().editor, ev) });
  },
}));

/** The line with an id, found in the loaded pages. */
export function findLine(lines: Record<number, TextLine[]>, id: string | null): TextLine | null {
  if (!id) return null;
  for (const list of Object.values(lines)) {
    const hit = list.find((l) => l.id === id);
    if (hit) return hit;
  }
  return null;
}
