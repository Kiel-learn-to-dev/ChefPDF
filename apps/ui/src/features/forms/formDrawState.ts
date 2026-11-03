import { create } from 'zustand';
import type { PendingFormRect } from './formsModel';

interface FormDrawState {
  drawing: boolean;
  pending: PendingFormRect | null;
  setDrawing(drawing: boolean): void;
  setPending(pending: PendingFormRect | null): void;
}

export const useFormDraw = create<FormDrawState>((set) => ({
  drawing: false,
  pending: null,
  setDrawing(drawing) {
    set({ drawing });
  },
  setPending(pending) {
    set({ pending });
  },
}));
