/**
 * JSON-RPC contract between the Electron main process and the Python core sidecar.
 * Source of truth: docs/CONTRACTS.md. Keep both in sync.
 */

export type SessionId = string;
export type JobId = string;

/** 0-based page indices. */
export type PageIndex = number;

export interface DocumentInfo {
  pageCount: number;
  pdfVersion: string;
  encrypted: boolean;
  fileSize: number;
  metadata: Record<string, string>;
  /** Page sizes in PDF points (1/72 inch), after rotation. */
  pages: { width: number; height: number; rotation: number }[];
  fonts: { name: string; embedded: boolean; subset: boolean }[];
  hasSignatures: boolean;
}

export interface SessionState {
  sessionId: SessionId;
  sourcePath: string | null;
  /** Absolute path of the current revision file (for the viewer). */
  revisionPath: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  signed: boolean;
}

export type ChangedPages = 'all' | PageIndex[];

export interface OpResult {
  /** null for standalone ops run without a session (e.g. file.merge). */
  state: SessionState | null;
  changedPages: ChangedPages;
  warnings: string[];
  /** Files written outside the session (e.g. split output). */
  outputs: string[];
  data?: unknown;
}

export interface OpDescriptor {
  id: string;
  title: string;
  group: string;
  /** JSON Schema of the params object. */
  paramsSchema: Record<string, unknown>;
  destructive: boolean;
  finalizing: boolean;
  batchable: boolean;
  /** true when the op does not need an open session (e.g. merge files). */
  standalone: boolean;
}

export interface RpcError {
  code: number;
  message: string;
  /** Stable machine-readable code, e.g. "PASSWORD_REQUIRED". */
  data?: { kind: string; detail?: unknown };
}

/** Request methods: name -> [params, result]. */
export interface RpcMethods {
  'system.ping': [Record<string, never>, { version: string; python: string }];
  'system.shutdown': [Record<string, never>, null];
  'ops.list': [Record<string, never>, OpDescriptor[]];
  /** Starts a job and returns immediately. Result arrives via job.finished. */
  'ops.run': [{ sessionId?: SessionId; opId: string; params: unknown }, { jobId: JobId }];
  'jobs.cancel': [{ jobId: JobId }, null];
  'session.open': [
    { path: string; password?: string },
    { state: SessionState; info: DocumentInfo },
  ];
  'session.create': [Record<string, never>, { state: SessionState; info: DocumentInfo }];
  'session.close': [{ sessionId: SessionId }, null];
  'session.state': [{ sessionId: SessionId }, SessionState];
  'session.info': [{ sessionId: SessionId }, DocumentInfo];
  'session.undo': [{ sessionId: SessionId }, OpResult];
  'session.redo': [{ sessionId: SessionId }, OpResult];
  'session.save': [{ sessionId: SessionId; path?: string }, SessionState & { warnings: string[] }];
  /** Built-in presets for scan.rasterize; params is a ScanRasterizeParams wire object. */
  'scan.presets': [
    Record<string, never>,
    { name: string; labelVi: string; labelEn: string; params: Record<string, unknown> }[],
  ];
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M][0];
export type RpcResult<M extends RpcMethod> = RpcMethods[M][1];

/** Notifications pushed from core (no id). */
export interface RpcNotifications {
  'job.progress': { jobId: JobId; done: number; total: number; message?: string };
  'job.finished': { jobId: JobId; result: OpResult };
  'job.failed': { jobId: JobId; error: RpcError };
  'job.cancelled': { jobId: JobId };
  log: { level: 'debug' | 'info' | 'warning' | 'error'; message: string };
}

export type RpcNotification = keyof RpcNotifications;

/** Stable error kinds (RpcError.data.kind). */
export const ErrorKinds = [
  'PASSWORD_REQUIRED',
  'PASSWORD_INVALID',
  'FILE_NOT_FOUND',
  'INVALID_PDF',
  'SESSION_NOT_FOUND',
  'OP_NOT_FOUND',
  'INVALID_PARAMS',
  'BLOCKED_BY_SIGNATURE',
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
  'LIBRARY_INVALID',
  'LIBRARY_NOT_FOUND',
  'LIBRARY_FULL',
  'LIBRARY_KEY_MISSING',
  'LIBRARY_TAMPERED',
  'CANCELLED',
  'INTERNAL',
] as const;
export type ErrorKind = (typeof ErrorKinds)[number];

/** Results of the standalone signature ops (`ops.run` → job.finished → result.data). */
export interface CertIdentity {
  taxCode: string | null;
  citizenId: string | null;
  budgetCode: string | null;
  organization: string | null;
  personName: string | null;
}

/** sign.certInfo result (same shape as core CertInfo). Dates are ISO 8601 strings. */
export interface CertInfoData {
  subjectCommonName: string | null;
  issuerCommonName: string | null;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  daysUntilExpiry: number;
  expired: boolean;
  expiringSoon: boolean;
  keyUsage: string[];
  keyAlgorithm: string;
  keySize: number | null;
  fingerprintSha256: string;
  identity: CertIdentity;
}

export type DriverConfidence = 'documented' | 'reported' | 'unverified';

export interface DriverProbe {
  status: 'ok' | 'error';
  errorKind: string | null;
  reason: string | null;
  tokenLabels: string[];
}

/** One row of sign.driverScan. */
export interface DriverRow {
  ca: string;
  caId: string;
  model: string;
  modelId: string;
  path: string;
  exists: boolean;
  confidence: DriverConfidence;
  bitness: string | null;
  probe?: DriverProbe;
}

export interface DriverScanData {
  os: string;
  drivers: DriverRow[];
}

export type PinState = 'ok' | 'count_low' | 'final_try' | 'locked' | 'to_be_changed';

/** One certificate on a token (sign.listTokens). */
export interface TokenCertificate {
  ckaId: string;
  label: string;
  isCa: boolean;
  cert: CertInfoData;
}

export interface TokenInfo {
  slotId: number;
  slotDescription: string;
  label: string;
  manufacturer: string;
  model: string;
  serial: string;
  initialized: boolean;
  pinState: PinState;
  flags: string[];
  protectedAuthPath: boolean;
  unreadableObjects: number;
  certificates: TokenCertificate[];
}

export interface ListTokensData {
  modulePath: string;
  tokens: TokenInfo[];
}

export type DiagStepId =
  | 'driver_found'
  | 'driver_loads'
  | 'token_present'
  | 'token_initialized'
  | 'certificate_readable'
  | 'certificate_validity'
  | 'pin_state'
  | 'signing_self_test';

export type DiagStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagStep {
  id: DiagStepId;
  status: DiagStatus;
  titleVi: string;
  titleEn: string;
  detail: string;
  fixVi: string | null;
  fixEn: string | null;
}

export interface DiagnoseData {
  overall: 'ok' | 'warn' | 'fail';
  steps: DiagStep[];
}

/** Status of one signature (sign.verify). `unsigned` is a signature field without a signature. */
export type SignatureStatus = 'valid' | 'valid-with-warnings' | 'invalid' | 'unknown' | 'unsigned';

/** Machine reasons of sign.verify (core/chef_core/signing/verify.py REASON_TEXT). */
export type SignatureReason =
  | 'INTEGRITY_FAILED'
  | 'MODIFIED_AFTER_SIGNING'
  | 'CERT_UNTRUSTED'
  | 'CERT_REVOKED'
  | 'CERT_EXPIRED_AT_SIGNING'
  | 'CERT_EXPIRED_NOW'
  | 'REVOCATION_UNKNOWN'
  | 'DOCMDP_VIOLATION'
  | 'TIMESTAMP_INVALID'
  | 'UNSIGNED_FIELD'
  | 'SIGNATURE_UNREADABLE';

export type SignatureLevel = 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';

/** One certificate of a signature's chain. `trusted` is true when the chain ends in a trusted root. */
export interface SignatureChainRow {
  subject: string;
  issuer: string;
  /** ISO 8601. */
  notBefore: string;
  /** ISO 8601. */
  notAfter: string;
  trusted: boolean;
}

export interface SignatureRevocationRow {
  cert: string;
  fingerprintSha256: string;
  /** "embedded" | "crl" | "ocsp" | "none" */
  source: string;
  /** "good" | "revoked" | "unknown" | "skipped" */
  status: string;
}

/** One entry of sign.verify's `data.signatures`. */
export interface SignatureVerifyItem {
  fieldName: string;
  status: SignatureStatus;
  reasons: SignatureReason[];
  summaryVi: string;
  summaryEn: string;
  revisionIndex: number | null;
  subFilter: string | null;
  level: SignatureLevel | null;
  digestAlgorithm: string | null;
  signerName: string | null;
  signerCert: CertInfoData | null;
  signingTime: string | null;
  timestampTime: string | null;
  timestampOk: boolean | null;
  coversWholeDocument: boolean | null;
  modificationLevel: string | null;
  docMdp: string | null;
  chain: SignatureChainRow[];
  revocation: SignatureRevocationRow[];
}

export interface SignatureVerifyData {
  signatures: SignatureVerifyItem[];
}

/** One trusted certificate (sign.trustList). `source` "bundled" entries cannot be removed. */
export interface TrustEntry {
  subject: string;
  issuer: string;
  notAfter: string;
  fingerprintSha256: string;
  group: 'vn-public-ca' | 'vn-gov-ca' | 'user';
  source: 'bundled' | 'user';
}

export interface TrustListData {
  entries: TrustEntry[];
}
