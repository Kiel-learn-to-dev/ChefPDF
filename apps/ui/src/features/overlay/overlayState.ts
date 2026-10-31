/**
 * In-memory state of the overlay dialogs (not saved): the drafts of the forms, which survive
 * closing a dialog to place an object on the page, and the placement mode itself.
 *
 * Placement flow: a dialog calls startPlacement (it closes), the viewer layer takes the mouse,
 * finish stores the box and reopens the dialog, which reads it once with takeResult.
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import type { DialogId } from '../../app/state/ui';
import { useUi } from '../../app/state/ui';

export type PlacementMode = 'point' | 'box';

export interface PlacementRequest {
  docId: string;
  mode: PlacementMode;
  /** The dialog to reopen when the placement ends. */
  returnTo: DialogId;
}

/** Box of a placement in points, top-left origin of the displayed page. */
export interface PlacementResult {
  docId: string;
  returnTo: DialogId;
  /** 0-based page where the box was drawn. */
  pageIndex: number;
  x: number;
  y: number;
  /** 0 for a point. */
  width: number;
  height: number;
}

interface OverlayState {
  request: PlacementRequest | null;
  result: PlacementResult | null;
  drafts: Record<string, unknown>;
  start(req: PlacementRequest): void;
  cancel(): void;
  finish(res: PlacementResult): void;
  /** Returns the placement result for `dialog` once, then forgets it. */
  takeResult(dialog: DialogId): PlacementResult | null;
  setDraft(key: string, value: unknown): void;
}

export const useOverlayState = create<OverlayState>((set, get) => ({
  request: null,
  result: null,
  drafts: {},
  start(req) {
    set({ request: req, result: null });
    useUi.getState().closeDialog();
  },
  cancel() {
    const req = get().request;
    set({ request: null });
    if (req) useUi.getState().openDialog(req.returnTo);
  },
  finish(res) {
    set({ request: null, result: res });
    useUi.getState().openDialog(res.returnTo);
  },
  takeResult(dialog) {
    const r = get().result;
    if (!r || r.returnTo !== dialog) return null;
    set({ result: null });
    return r;
  },
  setDraft(key, value) {
    set((s) => ({ drafts: { ...s.drafts, [key]: value } }));
  },
}));

/**
 * A dialog form kept as a draft: the value survives closing the dialog (placement) and starts from
 * the last-used options (`init`) the first time.
 */
export function useDraft<T>(key: string, init: () => T): [T, (next: T | ((prev: T) => T)) => void] {
  const stored = useOverlayState((s) => s.drafts[key] as T | undefined);
  const value = stored ?? init();
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = (useOverlayState.getState().drafts[key] as T | undefined) ?? init();
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      useOverlayState.getState().setDraft(key, resolved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}
