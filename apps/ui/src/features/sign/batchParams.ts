/**
 * Params of sign.batch from the batch dialog state (T3.13). Pure. The signer's PIN and password
 * and the per-file passwords are only in the returned object, never saved.
 */
import type { SignBatchParams, SignatureTemplate } from '@chef/contracts';
import {
  anchorPlacementParams,
  fixedPlacementParams,
  type AnchorForm,
  type FixedForm,
} from './anchorModel';
import { suffixProblem, DEFAULT_SUFFIX, type BatchRow } from './batchModel';
import type { CertifyMode, DigestName, SignLevel, SignerChoice } from './signRequest';

export type BatchPlacement =
  | { mode: 'invisible' }
  | { mode: 'anchor'; form: AnchorForm }
  | { mode: 'fixed'; form: FixedForm }
  | { mode: 'rect'; page: number; rect: [number, number, number, number] };

export type OutputMode = 'suffix' | 'folder' | 'overwrite';

export interface BatchForm {
  signer: SignerChoice;
  level: SignLevel;
  digest: DigestName;
  tsaUrls: string[];
  reason: string;
  location: string;
  contact: string;
  certify: CertifyMode;
  template?: SignatureTemplate;
  placement: BatchPlacement;
  outputMode: OutputMode;
  suffix: string;
  folder: string | null;
  stopOnError: boolean;
  verifyAfter: boolean;
  /** The user confirmed overwriting the originals (required for overwrite mode). */
  overwriteConfirmed: boolean;
  /** Final try of a token: the user agreed to use the PIN. */
  confirmFinalTry?: boolean;
}

export type BatchProblem =
  | 'noFiles'
  | 'noTsa'
  | 'badSuffix'
  | 'noFolder'
  | 'noOverwriteConfirm'
  | 'badRect'
  | 'noAnchorText';

/** The first problem with the form, or null. The dialog shows the matching message. */
export function batchProblem(files: readonly BatchRow[], f: BatchForm): BatchProblem | null {
  if (files.length === 0) return 'noFiles';
  if (f.level !== 'B-B' && f.tsaUrls.length === 0) return 'noTsa';
  if (f.outputMode === 'suffix' && suffixProblem(f.suffix)) return 'badSuffix';
  if (f.outputMode === 'folder' && !f.folder) return 'noFolder';
  if (f.outputMode === 'overwrite' && !f.overwriteConfirmed) return 'noOverwriteConfirm';
  if (f.placement.mode === 'rect') {
    const [x1, y1, x2, y2] = f.placement.rect;
    if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return 'badRect';
  }
  if (f.placement.mode === 'anchor' && f.placement.form.text.trim() === '') return 'noAnchorText';
  return null;
}

function placementParams(p: BatchPlacement): SignBatchParams['placement'] {
  switch (p.mode) {
    case 'invisible':
      return undefined;
    case 'anchor':
      return anchorPlacementParams(p.form);
    case 'fixed':
      return fixedPlacementParams(p.form);
    case 'rect':
      return { kind: 'rect', page: p.page, rect: [...p.rect] };
  }
}

/** The sign.batch params for the form (the caller checked batchProblem first). */
export function buildBatchParams(files: readonly BatchRow[], f: BatchForm): SignBatchParams {
  const common: SignBatchParams['common'] = {
    level: f.level,
    digest: f.digest,
    ...(f.tsaUrls.length > 0 ? { tsaUrls: [...f.tsaUrls] } : {}),
    ...(f.reason.trim() ? { reason: f.reason.trim() } : {}),
    ...(f.location.trim() ? { location: f.location.trim() } : {}),
    ...(f.contact.trim() ? { contactInfo: f.contact.trim() } : {}),
    ...(f.certify !== 'none' ? { certify: f.certify } : {}),
    ...(f.template ? { template: f.template } : {}),
  };
  if (f.signer.kind === 'store') {
    // Batch signing reads a file or a token; the Windows store is used one document at a time.
    throw new Error('Kho chứng thư Windows chưa dùng cho ký hàng loạt. Chọn file .pfx hoặc token.');
  }
  const signer: SignBatchParams['signer'] =
    f.signer.kind === 'pfx'
      ? {
          kind: 'pfx',
          pfxPath: f.signer.pfxPath,
          ...(f.signer.password ? { password: f.signer.password } : {}),
        }
      : {
          kind: 'token',
          modulePath: f.signer.modulePath,
          certId: f.signer.certId,
          pin: f.signer.pin,
          ...(f.signer.slotId !== undefined ? { slotId: f.signer.slotId } : {}),
          ...(f.signer.tokenSerial && f.signer.slotId === undefined
            ? { tokenSerial: f.signer.tokenSerial }
            : {}),
          ...(f.confirmFinalTry ? { confirmFinalTry: true } : {}),
        };
  const output: SignBatchParams['output'] =
    f.outputMode === 'suffix'
      ? { mode: 'suffix', suffix: f.suffix.trim() || DEFAULT_SUFFIX }
      : f.outputMode === 'folder'
        ? { mode: 'folder', folder: f.folder ?? '' }
        : { mode: 'overwrite' };
  const placement = placementParams(f.placement);
  return {
    files: files.map((r) => ({ path: r.path, ...(r.password ? { password: r.password } : {}) })),
    signer,
    common,
    ...(placement ? { placement } : {}),
    output,
    stopOnError: f.stopOnError,
    verifyAfter: f.verifyAfter,
  };
}
