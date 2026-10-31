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
  'CANCELLED',
  'INTERNAL',
] as const;
export type ErrorKind = (typeof ErrorKinds)[number];
