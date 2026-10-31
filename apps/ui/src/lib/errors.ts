import { ErrorKinds, type ErrorKind, type RpcError } from '@chef/contracts';

/** Error thrown by UI helpers when an RPC call or a job fails. */
export class ChefError extends Error {
  readonly kind: ErrorKind | 'UNKNOWN';
  readonly detail: unknown;
  readonly code: number | undefined;

  constructor(kind: ErrorKind | 'UNKNOWN', message: string, detail?: unknown, code?: number) {
    super(message);
    this.name = 'ChefError';
    this.kind = kind;
    this.detail = detail;
    this.code = code;
  }

  static fromRpcError(err: RpcError): ChefError {
    return new ChefError(asKind(err.data?.kind), err.message, err.data?.detail, err.code);
  }
}

function asKind(kind: unknown): ErrorKind | 'UNKNOWN' {
  return typeof kind === 'string' && (ErrorKinds as readonly string[]).includes(kind)
    ? (kind as ErrorKind)
    : 'UNKNOWN';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Normalize whatever `chef.rpc` rejected with into a ChefError. Electron's
 * ipcRenderer.invoke only keeps `message` of a thrown Error, so this also
 * looks for a JSON RpcError or a known error kind inside the message.
 */
export function toChefError(e: unknown): ChefError {
  if (e instanceof ChefError) return e;
  if (isRecord(e)) {
    const data = isRecord(e.data) ? e.data : undefined;
    const kind = data?.kind ?? e.kind;
    if (typeof kind === 'string') {
      return new ChefError(
        asKind(kind),
        String(e.message ?? kind),
        data?.detail,
        typeof e.code === 'number' ? e.code : undefined,
      );
    }
  }
  const message = e instanceof Error ? e.message : String(e);
  const json = message.match(/\{.*\}/s)?.[0];
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (isRecord(parsed) && (isRecord(parsed.data) || typeof parsed.kind === 'string'))
        return toChefError(parsed);
    } catch {
      /* not JSON */
    }
  }
  const found = ErrorKinds.find((k) => message.includes(k));
  return new ChefError(found ?? 'UNKNOWN', message);
}

/**
 * Error kinds of the certificate and token operations. Each one has a Vietnamese message under
 * `errors.<KIND>` in i18n (errors.test.ts checks that every kind has one).
 */
export const CERT_ERROR_KINDS: readonly ErrorKind[] = [
  'PASSWORD_REQUIRED',
  'PASSWORD_INVALID',
  'FILE_NOT_FOUND',
  'SIGN_BAD_PASSWORD',
  'SIGN_BAD_CERT',
  'SIGN_CERT_EXPIRED',
  'SIGN_TSA_FAILED',
  'SIGN_FAILED',
  'TOKEN_NOT_FOUND',
  'TOKEN_PIN_INVALID',
  'TOKEN_PIN_LOCKED',
  'TOKEN_PIN_CONFIRM_REQUIRED',
  'TOKEN_DRIVER_ERROR',
  'TOKEN_SUPPORT_UNAVAILABLE',
];

/** The password of a .pfx file was wrong or missing: ask again, do not keep it. */
export function isPasswordProblem(kind: ChefError['kind']): boolean {
  return (
    kind === 'SIGN_BAD_PASSWORD' || kind === 'PASSWORD_INVALID' || kind === 'PASSWORD_REQUIRED'
  );
}

/** The token refuses the PIN, or is locked: stop asking and tell the user. */
export function isTokenPinProblem(kind: ChefError['kind']): boolean {
  return kind === 'TOKEN_PIN_INVALID' || kind === 'TOKEN_PIN_LOCKED';
}
