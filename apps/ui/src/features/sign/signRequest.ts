/**
 * Builds the exact params of sign.pades (certificate file) or sign.padesToken (USB token) from
 * the dialog state. Pure. The PIN and the certificate password are only ever in the returned
 * params: `persistableDraft` strips them before anything is saved (T3.02, BLUEPRINT section 7).
 */
import type {
  SignPadesParams,
  SignPadesStoreParams,
  SignPadesTokenParams,
  SignatureTemplate,
} from '@chef/contracts';

export type SignLevel = 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
export type CertifyMode = 'none' | 'no-changes' | 'form-fill' | 'annotate';
export type DigestName = 'sha256' | 'sha384' | 'sha512';

export type SignerChoice =
  | { kind: 'pfx'; pfxPath: string; password?: string }
  /** A certificate of the Windows personal store, by its SHA-1 thumbprint (T4.11). */
  | { kind: 'store'; thumbprint: string }
  | {
      kind: 'token';
      modulePath: string;
      slotId?: number;
      tokenSerial?: string;
      certId: string;
      pin: string;
      confirmFinalTry?: boolean;
    };

export interface SignOptionsDraft {
  level: SignLevel;
  digest: DigestName;
  tsaUrls: string[];
  reason: string;
  location: string;
  contact: string;
  certify: CertifyMode;
  /** Look of the visible signature. Image paths must already be materialized. */
  template?: SignatureTemplate;
}

/** Where the visible box goes, after any anchor or fixed position is resolved. */
export interface ResolvedPlacement {
  page: number;
  /** User space [x1, y1, x2, y2] in points. */
  rect: [number, number, number, number];
  /** Existing empty signature field to draw into (its rect must be the same). */
  fieldName?: string;
}

export type SignRequestErrorCode = 'NEEDS_TSA' | 'BAD_TOKEN_SELECTION' | 'NO_PIN';

export class SignRequestError extends Error {
  readonly code: SignRequestErrorCode;
  constructor(code: SignRequestErrorCode, message: string) {
    super(message);
    this.name = 'SignRequestError';
    this.code = code;
  }
}

/** The op to call and its params. The caller passes `params` to runDocOp. */
export type SignRequest =
  | { opId: 'sign.pades'; params: SignPadesParams }
  | { opId: 'sign.padesToken'; params: SignPadesTokenParams }
  | { opId: 'sign.padesStore'; params: SignPadesStoreParams };

function commonParams(options: SignOptionsDraft, placement: ResolvedPlacement | null) {
  if (options.level !== 'B-B' && options.tsaUrls.length === 0) {
    throw new SignRequestError('NEEDS_TSA', 'Level B-T and above needs a timestamp server');
  }
  const out: Record<string, unknown> = { level: options.level, digest: options.digest };
  if (options.tsaUrls.length > 0) out.tsaUrls = [...options.tsaUrls];
  const reason = options.reason.trim();
  const location = options.location.trim();
  const contact = options.contact.trim();
  if (reason) out.reason = reason;
  if (location) out.location = location;
  if (contact) out.contactInfo = contact;
  if (options.certify !== 'none') out.certify = options.certify;
  if (options.template) out.template = options.template;
  if (placement) {
    out.page = placement.page;
    out.rect = [...placement.rect];
    if (placement.fieldName) out.fieldName = placement.fieldName;
  }
  return out;
}

/**
 * Params for one signature of the open document. `placement` null = invisible signature.
 * Throws SignRequestError for combinations the core would refuse anyway, so the dialog can say
 * why before a job starts.
 */
export function buildSignRequest(
  signer: SignerChoice,
  options: SignOptionsDraft,
  placement: ResolvedPlacement | null,
): SignRequest {
  const common = commonParams(options, placement);
  if (signer.kind === 'store') {
    if (!/^[0-9A-Fa-f]{40}$/.test(signer.thumbprint)) {
      throw new SignRequestError('BAD_TOKEN_SELECTION', 'No certificate chosen');
    }
    const params = { ...common, thumbprint: signer.thumbprint };
    return { opId: 'sign.padesStore', params: params as unknown as SignPadesStoreParams };
  }
  if (signer.kind === 'pfx') {
    const params: Record<string, unknown> = { ...common, pfxPath: signer.pfxPath };
    if (signer.password) params.password = signer.password;
    return { opId: 'sign.pades', params: params as unknown as SignPadesParams };
  }
  if (!signer.certId) throw new SignRequestError('BAD_TOKEN_SELECTION', 'No certificate chosen');
  if (!signer.pin) throw new SignRequestError('NO_PIN', 'The PIN is empty');
  const params: Record<string, unknown> = {
    ...common,
    modulePath: signer.modulePath,
    certId: signer.certId,
    pin: signer.pin,
  };
  if (signer.slotId !== undefined) params.slotId = signer.slotId;
  else if (signer.tokenSerial) params.tokenSerial = signer.tokenSerial;
  else throw new SignRequestError('BAD_TOKEN_SELECTION', 'No token slot chosen');
  if (signer.confirmFinalTry) params.confirmFinalTry = true;
  return { opId: 'sign.padesToken', params: params as unknown as SignPadesTokenParams };
}

/**
 * The part of a signing draft that may be saved (settings, the in-memory draft that survives a
 * dialog close). Passwords and PINs are removed, whatever the caller passes in.
 */
export function persistableDraft<T extends { signer?: unknown }>(draft: T): T {
  const copy = structuredClone(draft) as T & { signer?: Record<string, unknown> };
  if (copy.signer && typeof copy.signer === 'object') {
    delete copy.signer.pin;
    delete copy.signer.password;
    delete copy.signer.confirmFinalTry;
  }
  return copy;
}
