import type { ViewMode } from '../../app/state/viewer';

export interface FindRequest {
  query: string;
  matchDiacritics: boolean;
  entireWord: boolean;
  caseSensitive: boolean;
  /** '' = new search, 'again' = next/prev */
  type: '' | 'again';
  findPrevious?: boolean;
}

/** Imperative API of a mounted viewer (one per open document). */
export interface ViewerController {
  goToPage(pageNumber: number): void;
  /** Outline destination (string name or explicit array). */
  goToDest(dest: unknown): void;
  setScaleValue(value: string): void;
  zoomBy(dir: 1 | -1): void;
  rotateBy(delta: 90 | -90): void;
  setMode(mode: ViewMode): void;
  find(req: FindRequest): void;
  closeFind(): void;
  /** Scrollable container (for the snapshot tool). */
  container(): HTMLElement | null;
}

const controllers = new Map<string, ViewerController>();

export function registerViewer(docId: string, c: ViewerController) {
  controllers.set(docId, c);
  return () => {
    if (controllers.get(docId) === c) controllers.delete(docId);
  };
}

export function getViewer(docId: string | null | undefined): ViewerController | undefined {
  return docId ? controllers.get(docId) : undefined;
}
