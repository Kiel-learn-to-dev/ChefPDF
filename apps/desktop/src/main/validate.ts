/**
 * Validation of untrusted IPC input from the renderer. Pure Node.
 */
import path from 'node:path';
import type { FileFilter } from '@chef/contracts';
import { isPlainObject } from './fsutil';
import { RpcCallError } from './rpc';

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

const METHOD_RE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** Methods only main may call. */
const MAIN_ONLY_METHODS = new Set(['system.shutdown']);
const MAX_TEXT = 16 * 1024 * 1024;
const MAX_DATA_URL = 128 * 1024 * 1024;

function invalidParams(message: string): RpcCallError {
  return new RpcCallError({ code: -32602, message, data: { kind: 'INVALID_PARAMS' } });
}

/** Validates `chef.rpc(method, params)`; returns params normalised to an object. */
export function validateRpcCall(
  method: unknown,
  params: unknown,
): { method: string; params: Record<string, unknown> } {
  if (typeof method !== 'string' || method.length > 128 || !METHOD_RE.test(method)) {
    throw invalidParams('Invalid RPC method name');
  }
  if (MAIN_ONLY_METHODS.has(method))
    throw invalidParams(`${method} cannot be called from the renderer`);
  if (params === undefined || params === null) return { method, params: {} };
  if (!isPlainObject(params)) throw invalidParams('RPC params must be an object');
  return { method, params };
}

export function validateAbsPath(p: unknown, what = 'path'): string {
  if (
    typeof p !== 'string' ||
    p.length === 0 ||
    p.length > 32_768 ||
    p.includes('\0') ||
    !path.isAbsolute(p)
  ) {
    throw new IpcValidationError(`${what} must be an absolute path`);
  }
  return path.normalize(p);
}

export function validateFilters(v: unknown): FileFilter[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 50) throw new IpcValidationError('filters must be an array');
  return v.map((f) => {
    if (
      !isPlainObject(f) ||
      typeof f.name !== 'string' ||
      f.name.length > 200 ||
      !Array.isArray(f.extensions) ||
      f.extensions.length > 100 ||
      !f.extensions.every((e) => typeof e === 'string' && /^(\*|[A-Za-z0-9_-]{1,20})$/.test(e))
    ) {
      throw new IpcValidationError('Invalid file filter');
    }
    return { name: f.name, extensions: [...(f.extensions as string[])] };
  });
}

export function validateOpenDialogOptions(v: unknown): {
  multiple: boolean;
  directory: boolean;
  filters?: FileFilter[];
} {
  if (v === undefined || v === null) return { multiple: false, directory: false };
  if (!isPlainObject(v)) throw new IpcValidationError('openDialog options must be an object');
  if (v.multiple !== undefined && typeof v.multiple !== 'boolean') {
    throw new IpcValidationError('multiple must be a boolean');
  }
  if (v.directory !== undefined && typeof v.directory !== 'boolean') {
    throw new IpcValidationError('directory must be a boolean');
  }
  const base = { multiple: v.multiple === true, directory: v.directory === true };
  const filters = validateFilters(v.filters);
  return filters ? { ...base, filters } : base;
}

export function validateSaveDialogOptions(v: unknown): {
  defaultPath?: string;
  filters?: FileFilter[];
} {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new IpcValidationError('saveDialog options must be an object');
  const out: { defaultPath?: string; filters?: FileFilter[] } = {};
  if (v.defaultPath !== undefined && v.defaultPath !== null) {
    if (
      typeof v.defaultPath !== 'string' ||
      v.defaultPath.length > 32_768 ||
      v.defaultPath.includes('\0')
    ) {
      throw new IpcValidationError('defaultPath must be a string');
    }
    out.defaultPath = v.defaultPath;
  }
  const filters = validateFilters(v.filters);
  if (filters) out.filters = filters;
  return out;
}

export function validateText(v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_TEXT)
    throw new IpcValidationError('text must be a string');
  return v;
}

export function validatePngDataUrl(v: unknown): string {
  if (
    typeof v !== 'string' ||
    v.length > MAX_DATA_URL ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(v)
  ) {
    throw new IpcValidationError('Expected a data:image/png;base64 URL');
  }
  return v;
}

/** Resolves a save dialog default path against the configured default save directory. */
export function resolveDefaultSavePath(
  defaultPath: string | undefined,
  defaultSaveDir: string | null,
): string | undefined {
  if (!defaultPath) return defaultSaveDir ?? undefined;
  if (path.isAbsolute(defaultPath) || !defaultSaveDir) return defaultPath;
  return path.join(defaultSaveDir, defaultPath);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes a validated PNG data URL and checks the PNG signature. */
export function pngBytesFromDataUrl(dataUrl: string): Buffer {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new IpcValidationError('Data is not a PNG image');
  }
  return bytes;
}
