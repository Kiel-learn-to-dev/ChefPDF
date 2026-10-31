// Order matters: ./pdfjs sets globalThis.pdfjsLib, which pdf_viewer.mjs reads at evaluation time.
import { pdfjsLib } from './pdfjs';
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { findMatches } from '../../lib/diacritics';

interface FindStateLike {
  caseSensitive?: boolean;
  entireWord?: boolean;
  matchDiacritics?: boolean;
}

/**
 * PDFFindController whose diacritics-insensitive matching also folds đ/Đ → d
 * (U+0111 has no Unicode decomposition, so pdf.js alone can't match "dinh" to "định").
 * `pageContent` is pdf.js' normalized page text; returned indices refer to it.
 */
export class ChefFindController extends PDFFindController {
  override match(query: string | string[], pageContent: string, pageIndex: number) {
    const state = this.state as FindStateLike | null;
    if (state?.matchDiacritics) return super.match(query, pageContent, pageIndex);
    const queries = (Array.isArray(query) ? query : [query]).filter(Boolean);
    const out: { index: number; length: number }[] = [];
    for (const q of queries) {
      out.push(
        ...findMatches(pageContent, q, {
          caseSensitive: !!state?.caseSensitive,
          entireWord: !!state?.entireWord,
        }),
      );
    }
    return out.sort((a, b) => a.index - b.index);
  }
}

export const AnnotationMode = pdfjsLib.AnnotationMode;
export { EventBus, PDFLinkService, PDFViewer, ScrollMode, SpreadMode };
