/**
 * "Đóng dấu kèm" (I33): the stamps placed before a signature. Builds the `stamps` list of
 * sign.stampAndSign / sign.stampAndSignToken from the stamp forms (the same pure models the stamp
 * dialogs use), and wraps a plain signing request. Pure. The PIN and the certificate password only
 * ever sit in the `sign` part of the request, never in `stamps` and never in persisted state.
 */
import type {
  SignStampAndSignParams,
  SignStampAndSignTokenParams,
  StampStep,
} from '@chef/contracts';
import { checkInitials, initialsParams, type InitialsForm } from '../stamps/initialsModel';
import { checkSeamForm, seamParams, type SeamForm } from '../stamps/seamModel';
import type { SignRequest } from './signRequest';

export interface SignStamps {
  seam: SeamForm | null;
  initials: InitialsForm | null;
}

export const NO_STAMPS: SignStamps = { seam: null, initials: null };

export interface StampProblem {
  stamp: 'seam' | 'initials';
  field: string;
}

/** A signing request that carries stamps: the core stamps first, then signs. */
export type StampedSignRequest =
  | { opId: 'sign.stampAndSign'; params: SignStampAndSignParams }
  | { opId: 'sign.stampAndSignToken'; params: SignStampAndSignTokenParams };

export type AnySignRequest = SignRequest | StampedSignRequest;

export function hasStamps(stamps: SignStamps): boolean {
  return stamps.seam !== null || stamps.initials !== null;
}

/**
 * The stamp steps in the order they are placed (seam, then initials). `problem` names the first
 * stamp whose form is not valid, so the dialog can say which field to fix before any job starts.
 */
export function stampStepsOf(
  stamps: SignStamps,
  current: number,
  pageCount: number,
): { steps: StampStep[]; problem: StampProblem | null } {
  const steps: StampStep[] = [];
  if (stamps.seam) {
    const check = checkSeamForm(stamps.seam, pageCount, current);
    if (!check.ok) return { steps: [], problem: { stamp: 'seam', field: check.field } };
    steps.push({
      op: 'stamp.seam',
      params: seamParams(stamps.seam, current, pageCount) as unknown as Record<string, unknown>,
    });
  }
  if (stamps.initials) {
    const check = checkInitials(stamps.initials, pageCount, current);
    if (!check.ok) return { steps: [], problem: { stamp: 'initials', field: check.field } };
    steps.push({
      op: 'stamp.initials',
      params: initialsParams(stamps.initials, current, pageCount) as unknown as Record<
        string,
        unknown
      >,
    });
  }
  return { steps, problem: null };
}

/**
 * Wraps a plain signing request with the stamps. No stamps: the request is returned unchanged
 * (sign.pades / sign.padesToken). With stamps: sign.stampAndSign / sign.stampAndSignToken.
 */
export function withStamps(req: SignRequest, steps: StampStep[]): AnySignRequest {
  if (steps.length === 0) return req;
  if (req.opId === 'sign.pades') {
    return { opId: 'sign.stampAndSign', params: { stamps: steps, sign: req.params } };
  }
  return { opId: 'sign.stampAndSignToken', params: { stamps: steps, sign: req.params } };
}
