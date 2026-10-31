/**
 * The choices of the "Ký tài liệu" dialog that survive closing it (in memory, per session). Only
 * plain choices: the signer's password and PIN are never here (see SignerSection).
 */
import { create } from 'zustand';
import {
  DEFAULT_ANCHOR_FORM,
  DEFAULT_FIXED_FORM,
  type AnchorForm,
  type FixedForm,
} from './anchorModel';
import type { CertifyMode, DigestName, SignLevel } from './signRequest';
import { DEFAULT_SIGN_PREFS } from './signPrefs';

export type PlacementMode = 'invisible' | 'draw' | 'field' | 'anchor' | 'fixed';

export interface SignDraft {
  /** Chosen template id; undefined = the template bound to the certificate (or none). */
  templateId: string | null | undefined;
  level: SignLevel;
  digest: DigestName;
  certify: CertifyMode;
  reason: string;
  location: string;
  contact: string;
  placementMode: PlacementMode;
  anchorForm: AnchorForm;
  fixedForm: FixedForm;
}

export const DEFAULT_SIGN_DRAFT: SignDraft = {
  templateId: undefined,
  level: DEFAULT_SIGN_PREFS.level,
  digest: DEFAULT_SIGN_PREFS.digest,
  certify: DEFAULT_SIGN_PREFS.certify,
  reason: '',
  location: '',
  contact: '',
  placementMode: 'invisible',
  anchorForm: DEFAULT_ANCHOR_FORM,
  fixedForm: DEFAULT_FIXED_FORM,
};

interface DraftState {
  draft: SignDraft;
  patch(p: Partial<SignDraft>): void;
  reset(): void;
}

export const useSignDraft = create<DraftState>((set) => ({
  draft: DEFAULT_SIGN_DRAFT,
  patch(p) {
    set((s) => ({ draft: { ...s.draft, ...p } }));
  },
  reset() {
    set({ draft: DEFAULT_SIGN_DRAFT });
  },
}));
